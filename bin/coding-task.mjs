#!/usr/bin/env node
// coding-task.mjs — delegate a coding task to Gemini or Copilot via browser CDP
//
// Usage:
//   node coding-task.mjs "<task>" --engine gemini|copilot [--tab <prefix>]
//   node coding-task.mjs "<task>" --engine gemini --context "<code snippet>"
//   node coding-task.mjs all "<task>"   — run both engines in parallel
//
// Output (stdout): JSON { engine, task, code: [{language, code}], explanation, raw }
// Errors go to stderr only.

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import {
	cdp,
	injectClipboardInterceptor,
	waitForCopyButton,
} from "../extractors/common.mjs";
import { dismissConsent, handleVerification } from "../extractors/consent.mjs";

const MAX_FILE_SIZE = 50 * 1024; // 50KB per file
const MAX_FILES = 5;

const __dir = fileURLToPath(new URL(".", import.meta.url));
const PAGES_CACHE = `${tmpdir().replaceAll("\\", "/")}/cdp-pages.json`;

// Target the dedicated GreedySearch Chrome instance (port 9222)
const GREEDY_PROFILE_DIR = `${tmpdir().replaceAll("\\", "/")}/greedysearch-chrome-profile`;
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;

// Mode system prompts — prepended to the user's task
const MODE_PROMPTS = {
	code: null, // no preamble — default behaviour
	review: `You are a senior software engineer doing a thorough code review. Analyse the code below for: correctness and edge cases, security issues, performance problems, readability and naming, missing error handling, and anything that would not survive a production incident. Be specific — cite line-level issues where relevant. Suggest concrete fixes, not vague advice.`,
	plan: `You are a senior software architect. The user will describe something they want to build and their current plan. Your job is to: (1) identify risks, gaps, and hidden assumptions in the plan, (2) flag anything that will cause pain later (scaling, ops, security, maintainability), (3) suggest better alternatives where the plan is suboptimal, (4) call out what's missing entirely. Be direct and opinionated — the goal is to find problems before they're built.`,
	test: `You are a senior engineer writing tests for code written by someone else. Your goal is to find what they missed. Write a comprehensive test suite that covers: edge cases the author likely didn't think of, boundary conditions (empty input, nulls, max values, type coercion), error paths and exception handling, concurrency or ordering issues if relevant, and any behaviour that differs from what the function name implies. Use the same language and testing framework as the code if apparent, otherwise default to the most common one for that language. Output runnable test code — not a list of what to test.`,
	debug: `You are a senior engineer debugging someone else's code. You have fresh eyes — no prior assumptions about what should work. Given the bug description and relevant code: (1) identify the most likely root cause, being specific about the exact line or condition, (2) explain why it manifests the way it does, (3) suggest the minimal fix, (4) flag any other latent bugs you notice while reading. Do not guess vaguely — reason from the code. If you need information that isn't provided, say exactly what you'd add to narrow it down.`,
};

const STREAM_TIMEOUT = 120000; // coding tasks take longer — passed to waitForCopyButton
const MIN_RESPONSE_LENGTH = 50;

// ---------------------------------------------------------------------------
// Tab management
// ---------------------------------------------------------------------------

async function getAnyTab() {
	const list = await cdp(["list"]);
	return list.split("\n")[0].slice(0, 8);
}

async function openNewTab() {
	const anchor = await getAnyTab();
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		'{"url":"about:blank"}',
	]);
	const { targetId } = JSON.parse(raw);
	await cdp(["list"]); // refresh cache so cdp nav can find the new tab
	return targetId.slice(0, 8);
}

// ---------------------------------------------------------------------------
// Engine implementations
// ---------------------------------------------------------------------------

const ENGINES = {
	gemini: {
		url: "https://gemini.google.com/app",
		domain: "gemini.google.com",

		async type(tab, text) {
			await cdp([
				"eval",
				tab,
				`
        (function(t) {
          var el = document.querySelector('rich-textarea .ql-editor');
          el.focus();
          document.execCommand('insertText', false, t);
        })(${JSON.stringify(text)})
      `,
			]);
		},

		async send(tab) {
			await cdp([
				"eval",
				tab,
				`document.querySelector('button[aria-label*="Send"]')?.click()`,
			]);
		},

		async waitReady(tab) {
			const deadline = Date.now() + 12000;
			while (Date.now() < deadline) {
				const ok = await cdp([
					"eval",
					tab,
					`!!document.querySelector('rich-textarea .ql-editor')`,
				]).catch(() => "false");
				if (ok === "true") return;
				await new Promise((r) => setTimeout(r, 400));
			}
			throw new Error("Gemini input never appeared");
		},

		async waitForCopyButton(tab) {
			await waitForCopyButton(tab, 'button[aria-label="Copy"]', {
				timeout: STREAM_TIMEOUT,
			});
		},

		async extract(tab) {
			// Click copy button → clipboard interceptor captures the markdown
			await cdp([
				"eval",
				tab,
				`document.querySelector('button[aria-label="Copy"]')?.click()`,
			]);
			await new Promise((r) => setTimeout(r, 400));
			return cdp(["eval", tab, "window.__codingTaskClipboard || ''"]);
		},
	},

	copilot: {
		url: "https://copilot.microsoft.com/",
		domain: "copilot.microsoft.com",

		async type(tab, text) {
			await cdp(["click", tab, "#userInput"]);
			await new Promise((r) => setTimeout(r, 300));
			await cdp(["type", tab, text]);
		},

		async send(tab) {
			await cdp([
				"eval",
				tab,
				`document.querySelector('#userInput')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`,
			]);
		},

		async waitReady(tab) {
			const deadline = Date.now() + 10000;
			while (Date.now() < deadline) {
				const ok = await cdp([
					"eval",
					tab,
					`!!document.querySelector('#userInput')`,
				]).catch(() => "false");
				if (ok === "true") return;
				await new Promise((r) => setTimeout(r, 400));
			}
			throw new Error("Copilot input never appeared");
		},

		async waitForCopyButton(tab) {
			await waitForCopyButton(
				tab,
				'button[data-testid="copy-ai-message-button"]',
				{ timeout: STREAM_TIMEOUT },
			);
		},

		async extract(tab) {
			// Click copy button → clipboard interceptor captures the markdown
			await cdp([
				"eval",
				tab,
				`document.querySelector('button[data-testid="copy-ai-message-button"]')?.click()`,
			]);
			await new Promise((r) => setTimeout(r, 400));
			return cdp(["eval", tab, "window.__codingTaskClipboard || ''"]);
		},
	},
};

// ---------------------------------------------------------------------------
// Code extraction
// ---------------------------------------------------------------------------

function extractCodeBlocks(text) {
	const blocks = [];
	const regex = /```(\w+)?\n([\s\S]*?)```/g;
	let match = regex.exec(text);
	while (match !== null) {
		blocks.push({ language: match[1] || "text", code: match[2].trim() });
		match = regex.exec(text);
	}
	// If no fenced blocks, look for indented blocks as fallback
	if (blocks.length === 0) {
		const lines = text.split("\n");
		const indented = lines
			.filter((l) => l.startsWith("    "))
			.map((l) => l.slice(4));
		if (indented.length > 3)
			blocks.push({ language: "text", code: indented.join("\n") });
	}
	return blocks;
}

function extractExplanation(text, _codeBlocks) {
	// Remove code blocks from text to get the explanation
	let explanation = text.replaceAll(/```[\s\S]*?```/g, "").trim();
	explanation = explanation.replaceAll(/\n{3,}/g, "\n\n").trim();
	return explanation.slice(0, 1000); // cap explanation at 1000 chars
}

async function runEngine(engineName, task, context, mode, tabPrefix) {
	const engine = ENGINES[engineName];
	if (!engine) throw new Error(`Unknown engine: ${engineName}`);

	// Find or open a tab
	let tab = tabPrefix;
	if (!tab) {
		if (existsSync(PAGES_CACHE)) {
			const pages = JSON.parse(readFileSync(PAGES_CACHE, "utf8"));
			const existing = pages.find((p) => p.url.includes(engine.domain));
			if (existing) tab = existing.targetId.slice(0, 8);
		}
		if (!tab) tab = await openNewTab();
	}

	// Navigate to fresh conversation — fall back to new tab if cached tab is stale
	try {
		await cdp(["nav", tab, engine.url], 35000);
	} catch (e) {
		if (e.message.includes("No target matching")) {
			tab = await openNewTab();
			await cdp(["nav", tab, engine.url], 35000);
		} else throw e;
	}
	await new Promise((r) => setTimeout(r, 2000));
	await dismissConsent(tab, cdp);
	await handleVerification(tab, cdp, 60000);
	await engine.waitReady(tab);
	await new Promise((r) => setTimeout(r, 300));

	// Inject clipboard interceptor to capture markdown when copy button clicked
	await injectClipboardInterceptor(tab, "__codingTaskClipboard");

	// Build the prompt
	const preamble = MODE_PROMPTS[mode] || null;
	const body = context
		? `${task}\n\nHere is the relevant code/context:\n\`\`\`\n${context}\n\`\`\``
		: task;
	const prompt = preamble ? `${preamble}\n\n---\n\n${body}` : body;

	await engine.type(tab, prompt);
	await new Promise((r) => setTimeout(r, 400));
	await engine.send(tab);
	await engine.waitForCopyButton(tab);

	const raw = await engine.extract(tab);
	if (!raw) throw new Error(`No response from ${engineName}`);

	const code = extractCodeBlocks(raw);
	const explanation = extractExplanation(raw, code);
	const url = await cdp(["eval", tab, "document.location.href"]).catch(
		() => engine.url,
	);

	return { engine: engineName, task, code, explanation, raw, url };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const args = process.argv.slice(2);
	if (!args.length || args[0] === "--help") {
		process.stderr.write(
			`${[
				'Usage: node coding-task.mjs "<task>" --engine gemini|copilot|all [--mode code|review|plan]',
				'       node coding-task.mjs "<task>" --engine gemini --context "<code>"',
				"",
				"Modes:",
				"  code   (default) — write or modify code",
				"  review — senior engineer code review: correctness, security, performance",
				"  plan   — architect review: risks, gaps, alternatives for a build plan",
				"  test   — write tests an author would miss: edge cases, error paths, boundary conditions",
				"  debug  — fresh-eyes root cause analysis: exact line, why it manifests, minimal fix",
				"",
				"Examples:",
				'  node coding-task.mjs "write a debounce function in JS" --engine gemini',
				'  node coding-task.mjs "review this module" --mode review --engine all --file src/myfile.mjs',
				'  node coding-task.mjs "debug this" --mode debug --engine all --file a.mjs --file b.mjs',
				'  node coding-task.mjs "I want to build X, here is my plan: ..." --mode plan --engine all',
			].join("\n")}\n`,
		);
		process.exit(1);
	}

	const engineFlagIdx = args.indexOf("--engine");
	const engineArg = engineFlagIdx === -1 ? "gemini" : args[engineFlagIdx + 1];
	const contextFlagIdx = args.indexOf("--context");
	const outIdx = args.indexOf("--out");
	const outFile = outIdx === -1 ? null : args[outIdx + 1];
	const tabFlagIdx = args.indexOf("--tab");
	const tabPrefix = tabFlagIdx === -1 ? null : args[tabFlagIdx + 1];
	const modeFlagIdx = args.indexOf("--mode");
	const mode = modeFlagIdx === -1 ? "code" : args[modeFlagIdx + 1];

	if (!Object.hasOwn(MODE_PROMPTS, mode)) {
		process.stderr.write(
			`Error: unknown mode "${mode}". Use: code, review, plan, test, debug\n`,
		);
		process.exit(1);
	}

	// --file can be repeated: --file a.mjs --file b.mjs
	const fileIndices = [];
	const filePaths = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--file" && args[i + 1]) {
			fileIndices.push(i, i + 1);
			filePaths.push(args[i + 1]);
		}
	}

	// Validate file paths: limit count, check readability, enforce size
	if (filePaths.length > MAX_FILES) {
		process.stderr.write(
			`Error: too many --file arguments (max ${MAX_FILES})\n`,
		);
		process.exit(1);
	}
	for (const p of filePaths) {
		if (!existsSync(p)) {
			process.stderr.write(`Error: file not found: ${p}\n`);
			process.exit(1);
		}
		if (isAbsolute(p) && !p.startsWith(process.cwd())) {
			process.stderr.write(
				`Error: file must be within project directory: ${p}\n`,
			);
			process.exit(1);
		}
		const stat = statSync(p);
		if (stat.size > MAX_FILE_SIZE) {
			process.stderr.write(
				`Error: file too large (${Math.round(stat.size / 1024)}KB, max ${MAX_FILE_SIZE / 1024}KB): ${p}\n`,
			);
			process.exit(1);
		}
	}

	const fileContext =
		filePaths.length > 0
			? filePaths
					.map((p) => `// FILE: ${p}\n${readFileSync(p, "utf8")}`)
					.join("\n\n")
			: null;
	const context =
		fileContext || (contextFlagIdx === -1 ? null : args[contextFlagIdx + 1]);

	const skipFlags = new Set([
		...(engineFlagIdx >= 0 ? [engineFlagIdx, engineFlagIdx + 1] : []),
		...(contextFlagIdx >= 0 ? [contextFlagIdx, contextFlagIdx + 1] : []),
		...(outIdx >= 0 ? [outIdx, outIdx + 1] : []),
		...(tabFlagIdx >= 0 ? [tabFlagIdx, tabFlagIdx + 1] : []),
		...(modeFlagIdx >= 0 ? [modeFlagIdx, modeFlagIdx + 1] : []),
		...fileIndices,
	]);
	const task = args.filter((_, i) => !skipFlags.has(i)).join(" ");

	if (!task) {
		process.stderr.write("Error: no task provided\n");
		process.exit(1);
	}

	await cdp(["list"]); // ensure Chrome is reachable

	let result;

	if (engineArg === "all") {
		const results = await Promise.allSettled(
			Object.keys(ENGINES).map((e) => runEngine(e, task, context, mode, null)),
		);
		result = {};
		for (const [i, r] of results.entries()) {
			const name = Object.keys(ENGINES)[i];
			result[name] =
				r.status === "fulfilled"
					? r.value
					: { engine: name, error: r.reason?.message };
		}
	} else {
		try {
			result = await runEngine(engineArg, task, context, mode, tabPrefix);
		} catch (e) {
			process.stderr.write(`Error: ${e.message}\n`);
			process.exit(1);
		}
	}

	const json = `${JSON.stringify(result, null, 2)}\n`;
	if (outFile) {
		writeFileSync(outFile, json, "utf8");
		process.stderr.write(`Results written to ${outFile}\n`);
	} else {
		process.stdout.write(json);
	}
}

main();

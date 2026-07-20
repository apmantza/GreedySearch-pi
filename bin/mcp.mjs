#!/usr/bin/env node
// bin/mcp.mjs — dependency-free MCP stdio server exposing GreedySearch as
// MCP tools (greedy_search, greedy_fetch) for Claude Code and any other
// MCP client.
//
// Hand-rolled JSON-RPC 2.0 over newline-delimited stdin/stdout. No SDK —
// this repo avoids adding new dependencies. CRITICAL: nothing but protocol
// JSON may ever reach stdout; all logging goes to stderr.
//
// Run directly: node bin/mcp.mjs
// Register with Claude Code: claude mcp add greedysearch -- node <path>/bin/mcp.mjs
// or via the project-scope .mcp.json checked into the repo root.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH_BIN = join(__dirname, "search.mjs");

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "greedysearch", version: "1.0.0" };

// Search runs 1-5 minutes; research mode can run longer. Keep a generous
// internal watchdog so a hung child process can't wedge the MCP session.
// Overridable via GREEDY_SEARCH_TIMEOUT_MS (same env var the pi tool honors).
const DEFAULT_TIMEOUT_MS = 6 * 60 * 1000; // ~6 minutes

function log(...args) {
	// All diagnostic output MUST go to stderr — stdout is reserved for
	// JSON-RPC frames.
	process.stderr.write(`[greedysearch-mcp] ${args.join(" ")}\n`);
}

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
	if (id === undefined || id === null) return; // notification — no reply
	send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
	if (id === undefined || id === null) return;
	send({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}

// ── Tool schemas ────────────────────────────────────────────────────────
// Mirrors src/tools/greedy-search-handler.ts parameter names/semantics so
// the MCP contract matches the in-pi tool contract.

const ENGINE_DESCRIPTION =
	'Engine to use: "all" (default, fans out to configured engines and fetches top sources), ' +
	'"perplexity" (p), "google" (g), "chatgpt" (gpt), "gemini" (gem), "bing" (b). ' +
	'Research engines: "semantic-scholar" (s2) and "logically" (log).';

const GREEDY_SEARCH_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "The search query" },
		engine: {
			type: "string",
			default: "all",
			description: ENGINE_DESCRIPTION,
		},
		synthesize: {
			type: "boolean",
			default: false,
			description:
				'Only for engine="all": synthesize the multi-engine results and fetched sources.',
		},
		synthesizer: {
			type: "string",
			description:
				'Synthesis engine for synthesize=true. Defaults to ~/.pi/greedyconfig synthesizer ("gemini" by default). Supported: "gemini", "chatgpt".',
		},
		depth: {
			type: "string",
			description:
				'Use "research" for the iterative research workflow. Legacy values: "fast" skips source fetching; "standard"/"deep" alias synthesize=true.',
		},
		breadth: {
			type: "number",
			default: 3,
			description:
				'Only for depth="research": number of parallel research directions per round, 1-5.',
		},
		iterations: {
			type: "number",
			default: 2,
			description:
				'Only for depth="research": number of iterative research rounds, 1-3.',
		},
		maxSources: {
			type: "number",
			description:
				'Only for depth="research": maximum fetched sources for the final report, 3-12.',
		},
		researchOutDir: {
			type: "string",
			description:
				'Only for depth="research": optional directory for the structured research bundle.',
		},
		writeResearchBundle: {
			type: "boolean",
			default: true,
			description:
				'Only for depth="research": write the structured research bundle to disk.',
		},
		fullAnswer: {
			type: "boolean",
			default: false,
			description:
				"When true, returns the complete answer instead of a truncated preview.",
		},
		locale: {
			type: "string",
			description:
				'Force results language (e.g. "en", "de", "fr"). Defaults to GREEDY_SEARCH_LOCALE or "en".',
		},
		visible: {
			type: "boolean",
			default: false,
			description:
				"Set to true to always use visible Chrome for this search (e.g. to solve a login/captcha challenge).",
		},
	},
	required: ["query"],
};

const GREEDY_FETCH_SCHEMA = {
	type: "object",
	properties: {
		url: { type: "string", description: "URL to fetch and extract content from" },
		maxChars: {
			type: "number",
			default: 8000,
			description: "Maximum characters of extracted content to return.",
		},
	},
	required: ["url"],
};

const TOOLS = [
	{
		name: "greedy_search",
		description:
			"WEB/RESEARCH SEARCH ONLY — searches live web via Perplexity, Google AI, ChatGPT, and Gemini, " +
			"plus opt-in research through Semantic Scholar and Logically, using local headless Chrome automation " +
			"(no API keys needed). Research mode (depth: \"research\") plans follow-up actions, fetches sources, " +
			"audits citations, and writes a structured research bundle on disk. Searches take roughly 1-5 minutes.",
		inputSchema: GREEDY_SEARCH_SCHEMA,
	},
	{
		name: "greedy_fetch",
		description:
			"Fetch a single URL and extract its readable content (title, byline, markdown body). " +
			"Uses HTTP first, falling back to Chrome/browser rendering for JS-heavy or blocked pages.",
		inputSchema: GREEDY_FETCH_SCHEMA,
	},
];

// ── greedy_search implementation ───────────────────────────────────────
// Mirrors src/tools/shared.ts runSearch(): spawn bin/search.mjs with the
// same flags/env contract, feed the query over stdin, parse the JSON
// result from stdout.

function buildSearchFlags(args) {
	const engine = String(args.engine ?? "all").trim() || "all";
	const depthRaw = String(args.depth ?? "").trim();
	const researchMode = depthRaw === "research";
	const legacyFast = depthRaw === "fast";
	const legacySynthesisDepth = depthRaw === "standard" || depthRaw === "deep";
	const synthesize =
		engine === "all" &&
		!legacyFast &&
		(args.synthesize === true || legacySynthesisDepth);
	const effectiveEngine = researchMode ? "all" : engine;
	const visible = args.visible === true || process.env.GREEDY_SEARCH_VISIBLE === "1";

	const flags = [];
	const fullAnswer = args.fullAnswer ?? effectiveEngine !== "all";
	if (fullAnswer) flags.push("--full");

	if (researchMode) {
		flags.push("--depth", "research");
		if (typeof args.breadth === "number") flags.push("--breadth", String(args.breadth));
		if (typeof args.iterations === "number")
			flags.push("--iterations", String(args.iterations));
		if (typeof args.maxSources === "number")
			flags.push("--max-sources", String(args.maxSources));
		if (typeof args.researchOutDir === "string")
			flags.push("--research-out-dir", args.researchOutDir);
		if (args.writeResearchBundle === false) flags.push("--no-research-bundle");
	} else if (legacyFast) {
		flags.push("--fast");
	} else if (depthRaw === "deep") {
		flags.push("--depth", "deep");
	} else if (synthesize) {
		flags.push("--synthesize");
	}
	if (synthesize && typeof args.synthesizer === "string") {
		flags.push("--synthesizer", args.synthesizer);
	}
	if (typeof args.locale === "string" && args.locale) {
		flags.push("--locale", args.locale);
	}
	if (visible) flags.push("--always-visible");
	else flags.push("--headless");

	return { engine: effectiveEngine, flags, visible };
}

function runSearch(query, args) {
	return new Promise((resolve, reject) => {
		const { engine, flags, visible } = buildSearchFlags(args);
		const procEnv = { ...process.env };
		if (visible) {
			procEnv.GREEDY_SEARCH_VISIBLE = "1";
			procEnv.GREEDY_SEARCH_ALWAYS_VISIBLE = "1";
		}

		const proc = spawn(
			process.execPath,
			[SEARCH_BIN, engine, "--inline", "--stdin", ...flags],
			{ stdio: ["pipe", "pipe", "pipe"], env: procEnv },
		);
		proc.stdin.write(query);
		proc.stdin.end();

		let out = "";
		let err = "";
		const MAX_ERR = 50 * 1024;
		let settled = false;

		const parsedTimeout = parseInt(process.env.GREEDY_SEARCH_TIMEOUT_MS || "", 10);
		const timeoutMs = Number.isNaN(parsedTimeout) ? DEFAULT_TIMEOUT_MS : parsedTimeout;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			if (process.platform === "win32") proc.kill();
			else proc.kill("SIGTERM");
			reject(new Error(`greedy_search timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		timer.unref();

		proc.stderr.on("data", (d) => {
			err += d;
			if (err.length > MAX_ERR) err = err.slice(-MAX_ERR);
			// Forward progress lines to our own stderr for visibility, never stdout.
			log(d.toString().trimEnd());
		});
		proc.stdout.on("data", (d) => (out += d));
		proc.on("error", (e) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(e);
		});
		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(err.trim() || `search.mjs exited with code ${code}`));
				return;
			}
			try {
				resolve(JSON.parse(out.trim()));
			} catch {
				reject(new Error(`Invalid JSON from search.mjs: ${out.slice(0, 200)}`));
			}
		});
	});
}

// Minimal inline formatter — intentionally not importing the .ts formatter
// (src/formatters/results.ts) to keep this a dependency-free, pure-.mjs
// server. Produces a compact human-readable summary; full structured data
// is still returned as JSON alongside it.
function formatSummary(engine, data) {
	const lines = [];
	const needsHuman = data._needsHumanVerification;
	if (needsHuman) {
		lines.push("## Manual verification required");
		lines.push(
			String(
				needsHuman.message ||
					"Visible Chrome is open. Solve the verification challenge, then rerun the same search.",
			),
		);
	}

	const synthesis = data._synthesis;
	if (synthesis?.answer) {
		lines.push(String(synthesis.answer));
		const sources = Array.isArray(data._sources) ? data._sources : [];
		if (sources.length > 0) {
			lines.push("\nSources:");
			for (const s of sources.slice(0, 8)) {
				lines.push(`- [${s.title || s.url}](${s.url})`);
			}
		}
		return lines.join("\n").trim();
	}

	// Single-engine results are flat: {query, url, answer, sources, ...}.
	if (typeof data.answer === "string") {
		lines.push(data.answer);
		const sources = Array.isArray(data.sources) ? data.sources : [];
		if (sources.length > 0) {
			lines.push("\nSources:");
			for (const s of sources.slice(0, 8)) {
				lines.push(`- [${s.title || s.url}](${s.url})`);
			}
		}
		return lines.join("\n").trim();
	}

	// Fallback: all-engine results keyed by engine name.
	const engineKeys = Object.keys(data).filter(
		(k) => !k.startsWith("_") && data[k] && typeof data[k] === "object",
	);
	for (const key of engineKeys) {
		const eng = data[key];
		if (engineKeys.length > 1) {
			lines.push(`\n## ${key}`);
		}
		if (eng.error) {
			lines.push(`Error: ${eng.error}`);
			continue;
		}
		if (eng.answer) lines.push(String(eng.answer));
		const sources = Array.isArray(eng.sources) ? eng.sources : [];
		if (sources.length > 0) {
			lines.push("\nSources:");
			for (const s of sources.slice(0, 5)) {
				lines.push(`- [${s.title || s.url}](${s.url})`);
			}
		}
	}
	return lines.join("\n").trim() || "No results returned.";
}

async function callGreedySearch(args) {
	if (!args || typeof args.query !== "string" || !args.query.trim()) {
		throw new Error("query is required");
	}
	const data = await runSearch(args.query, args);
	const summary = formatSummary(args.engine ?? "all", data);
	return {
		content: [
			{ type: "text", text: summary || "No results returned." },
			{ type: "text", text: JSON.stringify(data) },
		],
	};
}

// ── greedy_fetch implementation ────────────────────────────────────────

let fetchSourceContentPromise;
function getFetchSourceContent() {
	if (!fetchSourceContentPromise) {
		fetchSourceContentPromise = import("../src/search/fetch-source.mjs").then(
			(m) => m.fetchSourceContent,
		);
	}
	return fetchSourceContentPromise;
}

async function callGreedyFetch(args) {
	if (!args || typeof args.url !== "string" || !args.url.trim()) {
		throw new Error("url is required");
	}
	const maxChars = typeof args.maxChars === "number" ? args.maxChars : 8000;
	const fetchSourceContent = await getFetchSourceContent();
	const result = await fetchSourceContent(args.url, maxChars);
	if (result?.error && !result.content) {
		return {
			content: [{ type: "text", text: `Fetch failed: ${result.error}` }],
			isError: true,
		};
	}
	const summary = [
		`# ${result.title || args.url}`,
		"",
		result.byline ? `By ${result.byline}` : null,
		result.siteName ? `Source: ${result.siteName}` : null,
		"",
		result.content || "(no content extracted)",
	]
		.filter((l) => l !== null)
		.join("\n");
	return {
		content: [
			{ type: "text", text: summary },
			{ type: "text", text: JSON.stringify(result) },
		],
	};
}

// ── JSON-RPC dispatch ───────────────────────────────────────────────────

async function handleRequest(msg) {
	const { id, method, params } = msg;

	switch (method) {
		case "initialize": {
			const clientVersion = params?.protocolVersion;
			sendResult(id, {
				protocolVersion:
					typeof clientVersion === "string" ? clientVersion : PROTOCOL_VERSION,
				capabilities: { tools: {} },
				serverInfo: SERVER_INFO,
			});
			return;
		}
		case "notifications/initialized":
		case "initialized":
			// No response required for notifications.
			return;
		case "ping":
			sendResult(id, {});
			return;
		case "tools/list":
			sendResult(id, { tools: TOOLS });
			return;
		case "tools/call": {
			const name = params?.name;
			const toolArgs = params?.arguments ?? {};
			try {
				let result;
				if (name === "greedy_search") result = await callGreedySearch(toolArgs);
				else if (name === "greedy_fetch") result = await callGreedyFetch(toolArgs);
				else {
					sendError(id, -32602, `Unknown tool: ${name}`);
					return;
				}
				sendResult(id, result);
			} catch (e) {
				// Tool-level failures are reported as a successful JSON-RPC
				// response with isError:true per MCP convention, not a
				// JSON-RPC protocol error.
				sendResult(id, {
					content: [{ type: "text", text: `Error: ${e.message || String(e)}` }],
					isError: true,
				});
			}
			return;
		}
		default:
			if (method && method.startsWith("notifications/")) return; // ignore unknown notifications
			sendError(id, -32601, `Method not found: ${method}`);
	}
}

function main() {
	const rl = createInterface({ input: process.stdin, terminal: false });
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try {
			msg = JSON.parse(trimmed);
		} catch {
			sendError(null, -32700, "Parse error");
			return;
		}
		handleRequest(msg).catch((e) => {
			log("Unhandled error:", e?.stack || String(e));
			sendError(msg?.id, -32603, "Internal error", String(e?.message || e));
		});
	});
	rl.on("close", () => process.exit(0));
	process.on("uncaughtException", (e) => {
		log("Uncaught exception:", e?.stack || String(e));
	});
	log(`GreedySearch MCP server ready (${SEARCH_BIN})`);
}

main();

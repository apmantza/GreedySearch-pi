// src/search/synthesis-runner.mjs — Run Gemini synthesis via CDP
//
// Extracted from search.mjs.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { GREEDY_PROFILE_DIR } from "./constants.mjs";
import {
	buildSynthesisPrompt,
	normalizeSynthesisPayload,
	parseStructuredJson,
} from "./synthesis.mjs";

const __dir =
	import.meta.dirname ||
	new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export async function runGeminiPrompt(
	prompt,
	{ tabPrefix = null, timeoutMs = 180000, visible = null } = {},
) {
	return new Promise((resolve, reject) => {
		const extraArgs = tabPrefix ? ["--tab", String(tabPrefix)] : [];
		// Strip inherited visible-mode flags so a stale GREEDY_SEARCH_VISIBLE=1
		// in the parent process doesn't make Gemini fall back to visible
		// Chrome. Callers that genuinely want visible Gemini should pass
		// visible: true explicitly.
		const childEnv = {
			...process.env,
			CDP_PROFILE_DIR: GREEDY_PROFILE_DIR,
		};
		if (visible !== true) {
			delete childEnv.GREEDY_SEARCH_VISIBLE;
			delete childEnv.GREEDY_SEARCH_ALWAYS_VISIBLE;
		} else {
			childEnv.GREEDY_SEARCH_VISIBLE = "1";
			childEnv.GREEDY_SEARCH_ALWAYS_VISIBLE = "1";
		}
		const proc = spawn(
			process.execPath,
			[
				join(__dir, "..", "..", "extractors", "gemini.mjs"),
				"--stdin",
				...extraArgs,
			],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: childEnv,
			},
		);
		// Pipe prompts via stdin to avoid leaking them in process tables.
		proc.stdin.write(prompt);
		proc.stdin.end();
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const t = setTimeout(() => {
			proc.kill();
			reject(new Error(`Gemini prompt timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0) {
				reject(new Error(err.trim() || "gemini extractor failed"));
				return;
			}
			try {
				resolve(JSON.parse(out.trim()));
			} catch {
				reject(new Error(`bad JSON from gemini: ${out.slice(0, 100)}`));
			}
		});
	});
}

export async function synthesizeWithGemini(
	query,
	results,
	{ grounded = false, tabPrefix = null, visible = null } = {},
) {
	const sources = Array.isArray(results._sources)
		? results._sources
		: buildSourceRegistry(results);
	const prompt = buildSynthesisPrompt(query, results, sources, { grounded });

	const raw = await runGeminiPrompt(prompt, {
		tabPrefix,
		timeoutMs: 180000,
		visible,
	});
	let structured = parseStructuredJson(raw.answer || "");

	// Detect if Gemini echoed back the engine summaries instead of a synthesis.
	// Happens when Gemini can't synthesize (e.g. only 1 engine responded) and
	// echoes the prompt JSON. The engine summary JSON has per-engine keys
	// (perplexity/bing/google) but no synthesis fields (answer/agreement).
	const SYNTHESIS_FIELDS = [
		"answer",
		"agreement",
		"claims",
		"differences",
		"caveats",
	];
	const hasSynthesisFields =
		structured && SYNTHESIS_FIELDS.some((f) => f in structured);
	const hasEngineKeys =
		structured && ["perplexity", "bing", "google"].some((e) => e in structured);
	if (hasEngineKeys && !hasSynthesisFields) {
		structured = null; // Treat as parse failure — Gemini echoed input
	}

	return {
		...normalizeSynthesisPayload(structured, sources, raw.answer || ""),
		rawAnswer: raw.answer || "",
		geminiSources: raw.sources || [],
	};
}

// Need to import buildSourceRegistry for fallback
import { buildSourceRegistry } from "./sources.mjs";

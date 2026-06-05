// src/search/synthesis-runner.mjs — Engine-agnostic synthesis via CDP extractors
//
// The all-search synthesis layer builds a neutral prompt and can route it to a
// configured browser engine. Gemini remains the default synthesizer; ChatGPT is
// supported for users who opt in via ~/.pi/greedyconfig or --synthesizer.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { GREEDY_PROFILE_DIR, SUPPORTED_SYNTHESIZERS } from "./constants.mjs";
import {
	buildSynthesisPrompt,
	normalizeSynthesisPayload,
	parseStructuredJson,
} from "./synthesis.mjs";
import { buildSourceRegistry } from "./sources.mjs";

const __dir =
	import.meta.dirname ||
	new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

const SYNTHESIS_EXTRACTORS = {
	gemini: "gemini.mjs",
	chatgpt: "chatgpt.mjs",
};

const SYNTHESIS_START_URLS = {
	gemini: "https://gemini.google.com/app",
	chatgpt: "https://chatgpt.com/",
};

export function normalizeSynthesizer(synthesizer = "gemini") {
	const normalized = String(synthesizer || "gemini").toLowerCase();
	if (normalized === "gem") return "gemini";
	if (normalized === "gpt") return "chatgpt";
	return normalized;
}

export function getSynthesisStartUrl(synthesizer = "gemini") {
	return (
		SYNTHESIS_START_URLS[normalizeSynthesizer(synthesizer)] || "about:blank"
	);
}

export async function runSynthesisPrompt(
	synthesizer,
	prompt,
	{ tabPrefix = null, timeoutMs = 180000, visible = null } = {},
) {
	const normalizedSynthesizer = normalizeSynthesizer(synthesizer);
	const script = SYNTHESIS_EXTRACTORS[normalizedSynthesizer];
	if (!script || !SUPPORTED_SYNTHESIZERS.includes(normalizedSynthesizer)) {
		throw new Error(
			`Unsupported synthesizer "${synthesizer}". Supported: ${SUPPORTED_SYNTHESIZERS.join(", ")}`,
		);
	}

	return new Promise((resolve, reject) => {
		const extraArgs = tabPrefix ? ["--tab", String(tabPrefix)] : [];
		// Strip inherited visible-mode flags so a stale GREEDY_SEARCH_VISIBLE=1
		// in the parent process doesn't force visible Chrome. Callers that
		// genuinely want visible synthesis should pass visible: true explicitly.
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
			[join(__dir, "..", "..", "extractors", script), "--stdin", ...extraArgs],
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
			reject(
				new Error(
					`${normalizedSynthesizer} prompt timed out after ${timeoutMs / 1000}s`,
				),
			);
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0) {
				reject(
					new Error(err.trim() || `${normalizedSynthesizer} extractor failed`),
				);
				return;
			}
			try {
				resolve(JSON.parse(out.trim()));
			} catch {
				reject(
					new Error(
						`bad JSON from ${normalizedSynthesizer}: ${out.slice(0, 100)}`,
					),
				);
			}
		});
	});
}

// Backward-compatible Gemini helper used by research mode internals.
export async function runGeminiPrompt(prompt, options = {}) {
	return runSynthesisPrompt("gemini", prompt, options);
}

export async function synthesizeResults(
	query,
	results,
	{
		grounded = false,
		tabPrefix = null,
		visible = null,
		synthesizer = "gemini",
	} = {},
) {
	const normalizedSynthesizer = normalizeSynthesizer(synthesizer);
	const sources = Array.isArray(results._sources)
		? results._sources
		: buildSourceRegistry(results);
	const prompt = buildSynthesisPrompt(query, results, sources, { grounded });

	const raw = await runSynthesisPrompt(normalizedSynthesizer, prompt, {
		tabPrefix,
		timeoutMs: 180000,
		visible,
	});
	let structured = parseStructuredJson(raw.answer || "");

	// Detect if the synthesizer echoed back the engine summaries instead of a
	// synthesis. This can happen when it can't synthesize and mirrors prompt JSON.
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
		structured &&
		["perplexity", "bing", "google", "chatgpt", "gemini"].some(
			(e) => e in structured,
		);
	if (hasEngineKeys && !hasSynthesisFields) {
		structured = null; // Treat as parse failure — synthesizer echoed input
	}

	return {
		...normalizeSynthesisPayload(structured, sources, raw.answer || ""),
		rawAnswer: raw.answer || "",
		synthesizedBy: normalizedSynthesizer,
		synthesizerSources: raw.sources || [],
		// Backward-compatible field for existing consumers.
		geminiSources: normalizedSynthesizer === "gemini" ? raw.sources || [] : [],
	};
}

// Backward-compatible all-search synthesis helper.
export async function synthesizeWithGemini(query, results, options = {}) {
	return synthesizeResults(query, results, {
		...options,
		synthesizer: "gemini",
	});
}

// src/search/synthesis-runner.mjs — Run Gemini synthesis via CDP
//
// Extracted from search.mjs.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { GREEDY_PROFILE_DIR } from "./constants.mjs";
import { parseStructuredJson, normalizeSynthesisPayload, buildSynthesisPrompt } from "./synthesis.mjs";
import { cdp, openNewTab, closeTab, activateTab } from "./chrome.mjs";
import { trimText } from "./sources.mjs";

const __dir = import.meta.dirname || new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export async function synthesizeWithGemini(
	query,
	results,
	{ grounded = false, tabPrefix = null } = {},
) {
	const sources = Array.isArray(results._sources)
		? results._sources
		: buildSourceRegistry(results);
	const prompt = buildSynthesisPrompt(query, results, sources, { grounded });

	return new Promise((resolve, reject) => {
		const extraArgs = tabPrefix ? ["--tab", String(tabPrefix)] : [];
		const proc = spawn(
			"node",
			[join(__dir, "..", "..", "extractors", "gemini.mjs"), prompt, ...extraArgs],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, CDP_PROFILE_DIR: GREEDY_PROFILE_DIR },
			},
		);
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const t = setTimeout(() => {
			proc.kill();
			reject(new Error("Gemini synthesis timed out after 180s"));
		}, 180000);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0)
				reject(new Error(err.trim() || "gemini extractor failed"));
			else {
				try {
					const raw = JSON.parse(out.trim());
					const structured = parseStructuredJson(raw.answer || "");
					resolve({
						...normalizeSynthesisPayload(structured, sources, raw.answer || ""),
						rawAnswer: raw.answer || "",
						geminiSources: raw.sources || [],
					});
				} catch {
					reject(new Error(`bad JSON from gemini: ${out.slice(0, 100)}`));
				}
			}
		});
	});
}

// Need to import buildSourceRegistry for fallback
import { buildSourceRegistry } from "./sources.mjs";
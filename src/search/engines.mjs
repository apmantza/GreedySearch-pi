// src/search/engines.mjs — Engine map, extractor runner
//
// Extracted from search.mjs.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { GREEDY_PROFILE_DIR } from "./constants.mjs";

const __dir = import.meta.dirname || new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export const ENGINES = {
	perplexity: "perplexity.mjs",
	pplx: "perplexity.mjs",
	p: "perplexity.mjs",
	bing: "bing-copilot.mjs",
	copilot: "bing-copilot.mjs",
	b: "bing-copilot.mjs",
	google: "google-ai.mjs",
	g: "google-ai.mjs",
	gemini: "gemini.mjs",
	gem: "gemini.mjs",
};

export function runExtractor(
	script,
	query,
	tabPrefix = null,
	short = false,
	timeoutMs = null,
) {
	// Gemini is slower - use longer timeout
	if (timeoutMs === null) {
		timeoutMs = script.includes("gemini") ? 180000 : 90000;
	}
	const extraArgs = [
		...(tabPrefix ? ["--tab", tabPrefix] : []),
		...(short ? ["--short"] : []),
	];
	return new Promise((resolve, reject) => {
		const proc = spawn(
			"node",
			[join(__dir, "..", "..", "extractors", script), query, ...extraArgs],
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
			reject(new Error(`${script} timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0) reject(new Error(err.trim() || `extractor exit ${code}`));
			else {
				try {
					resolve(JSON.parse(out.trim()));
				} catch {
					reject(new Error(`bad JSON from ${script}: ${out.slice(0, 100)}`));
				}
			}
		});
	});
}
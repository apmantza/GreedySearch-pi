// src/search/engines.mjs — Extractor runner
//
// Engine map lives in constants.mjs; this module re-exports it for
// backward compatibility and provides the runExtractor() function.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { ENGINES, GREEDY_PROFILE_DIR } from "./constants.mjs";

export { ENGINES };

const __dir =
	import.meta.dirname ||
	new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export function runExtractor(
	script,
	query,
	tabPrefix = null,
	short = false,
	timeoutMs = null,
	locale = null,
) {
	// Gemini is slower - use longer timeout
	if (timeoutMs === null) {
		timeoutMs = script.includes("gemini") ? 120000 : 60000;
	}
	const extraArgs = [
		...(tabPrefix ? ["--tab", tabPrefix] : []),
		...(short ? ["--short"] : []),
		...(locale ? ["--locale", locale] : []),
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
			if (code === 0) {
				try {
					resolve(JSON.parse(out.trim()));
				} catch {
					reject(new Error(`bad JSON from ${script}: ${out.slice(0, 100)}`));
				}
			} else {
				reject(new Error(err.trim() || `extractor exit ${code}`));
			}
		});
	});
}

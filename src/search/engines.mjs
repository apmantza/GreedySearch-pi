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
	// Gemini synthesis: 70s budget (45s stream + ~25s nav/settle overhead)
	// Other engines: 60s budget
	if (timeoutMs === null) {
		timeoutMs = script.includes("gemini") ? 70000 : 60000;
	}
	const extraArgs = [
		...(tabPrefix ? ["--tab", tabPrefix] : []),
		...(short ? ["--short"] : []),
		...(locale ? ["--locale", locale] : []),
	];
	return new Promise((resolve, reject) => {
		const proc = spawn(
			process.execPath,
			[join(__dir, "..", "..", "extractors", script), "--stdin", ...extraArgs],
			{
				stdio: ["pipe", "pipe", "pipe"],
				env: { ...process.env, CDP_PROFILE_DIR: GREEDY_PROFILE_DIR },
			},
		);
		// Pipe query via stdin to avoid leaking it in process table command-line
		proc.stdin.write(query);
		proc.stdin.end();
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
				// Try to parse structured error envelope from stdout before falling back
				let envelope = null;
				try {
					const parsed = JSON.parse(out.trim());
					if (parsed._envelope) envelope = parsed._envelope;
				} catch {}
				const msg = err.trim() || `extractor exit ${code}`;
				const errObj = new Error(msg);
				if (envelope) errObj.envelope = envelope;
				reject(errObj);
			}
		});
	});
}

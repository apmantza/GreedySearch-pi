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
	// ChatGPT can use a 30s in-page stream wait plus a 35s node-side fallback.
	// Logically research answers can run academic + web searches before streaming.
	// Other engines: 60s budget
	if (timeoutMs === null) {
		timeoutMs = script.includes("logically")
			? 120000
			: script.includes("chatgpt")
				? 80000
				: script.includes("gemini")
					? 70000
					: 60000;
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
		// Forward child stderr to parent so [engine] stage: lines are visible
		// in real time. Also retain the buffer for the timeout diagnostic path.
		proc.stderr.on("data", (d) => {
			err += d;
			if (process.env.GREEDY_SEARCH_CHILD_STDERR !== "0") {
				process.stderr.write(d);
			}
		});
		const t = setTimeout(() => {
			proc.kill();
			// Surface as much diagnostic info as the killed child produced so the
			// caller can see *which stage* the extractor was in. handleError()
			// emits `{ _envelope, error }` JSON to stdout on graceful failure,
			// but a hard kill discards whatever was buffered.
			const tailLines = (s, n = 20) =>
				String(s ?? "")
					.split(/\r?\n/)
					.filter(Boolean)
					.slice(-n)
					.join("\n");
			let envelope = null;
			try {
				const parsed = JSON.parse(out.trim());
				if (parsed._envelope) envelope = parsed._envelope;
			} catch {}
			const errObj = new Error(
				`${script} timed out after ${timeoutMs / 1000}s` +
					(envelope?.lastStage ? ` (last stage: ${envelope.lastStage})` : ""),
			);
			errObj.engineScript = script;
			errObj.lastStage = envelope?.lastStage || null;
			errObj.partialErr = tailLines(err);
			errObj.partialOut = tailLines(out);
			reject(errObj);
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

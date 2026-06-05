/**
 * Shared types, utilities, and runSearch for Pi tool handlers
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProgressUpdate, ToolResult } from "../types.js";

export type { ProgressUpdate, ToolResult } from "../types.js";

// Import and re-export ALL_ENGINES from constants.mjs so it's always in sync.
// constants.mjs reads ~/.pi/greedyconfig for user overrides.
import { ALL_ENGINES } from "../search/constants.mjs";
export { ALL_ENGINES };

/** Strip surrounding double-quotes that some framework versions inject into string params */
export function stripQuotes(val: string): string {
	return val.replace(/^"|"$/g, "");
}

/**
 * Check if the CDP module is available in the package directory
 */
export function cdpAvailable(baseDir: string): boolean {
	return existsSync(join(baseDir, "bin", "cdp.mjs"));
}

/**
 * Create a "cdp missing" error result
 */
export function cdpMissingResult(): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: "cdp.mjs missing — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi",
			},
		],
		details: {} as Record<string, unknown>,
	};
}

/**
 * Create an error result with a message
 */
export function errorResult(prefix: string, e: unknown): ToolResult {
	const msg = e instanceof Error ? e.message : String(e);
	return {
		content: [{ type: "text", text: `${prefix}: ${msg}` }],
		details: {} as Record<string, unknown>,
	};
}

/**
 * Spawn search.mjs and collect JSON results, with progress streaming via stderr.
 * Shared by GreedySearch tool handlers.
 */
export function runSearch(
	engine: string,
	query: string,
	flags: string[],
	searchBin: string,
	signal?: AbortSignal,
	onProgress?: (
		engine: string,
		status: "done" | "error" | "needs-human",
	) => void,
	headless?: boolean, // defaults to true (headless is the default)
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const allFlags = [...flags];
		// Headless is default — only skip if explicitly false or GREEDY_SEARCH_VISIBLE=1
		if (headless !== false && process.env.GREEDY_SEARCH_VISIBLE !== "1")
			allFlags.push("--headless");
		if (headless === false) allFlags.push("--always-visible");
		// Propagate visibility preference via env (--headless flag is informational;
		// the actual headless control in search.mjs / launch.mjs reads the env var).
		const procEnv = { ...process.env };
		if (headless === false) {
			procEnv.GREEDY_SEARCH_VISIBLE = "1";
			procEnv.GREEDY_SEARCH_ALWAYS_VISIBLE = "1";
		}
		const proc = spawn(
			process.execPath,
			[searchBin, engine, "--inline", "--stdin", ...allFlags],
			{ stdio: ["pipe", "pipe", "pipe"], env: procEnv },
		);
		// Pipe query via stdin to avoid leaking it in process table command-line
		proc.stdin.write(query);
		proc.stdin.end();
		let out = "";
		let err = "";

		const onAbort = () => {
			proc.kill("SIGTERM");
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.stderr.on("data", (d: Buffer) => {
			err += d;
			// Match PROGRESS lines for any known engine (perplexity/google/chatgpt/bing/gemini)
			const ENGINE_PROGRESS_RE =
				/^PROGRESS:(perplexity|google|chatgpt|bing|gemini):(done|error|needs-human)$/;
			for (const line of d.toString().split("\n")) {
				// Engine progress: any known engine
				const engineMatch = line.match(ENGINE_PROGRESS_RE);
				if (engineMatch && onProgress) {
					onProgress(
						engineMatch[1],
						engineMatch[2] as "done" | "error" | "needs-human",
					);
				}
				// Synthesis progress: skipped (manual verification) or done/error
				const synthMatch = line.match(
					/^PROGRESS:synthesis:(done|error|skipped)$/,
				);
				if (synthMatch && onProgress) {
					onProgress(
						"synthesis",
						synthMatch[1] as "done" | "error" | "needs-human",
					);
				}
			}
		});

		proc.stdout.on("data", (d: Buffer) => (out += d));
		proc.on("close", (code: number) => {
			signal?.removeEventListener("abort", onAbort);
			if (code !== 0) {
				reject(new Error(err.trim() || `search.mjs exited with code ${code}`));
			} else {
				try {
					resolve(JSON.parse(out.trim()));
				} catch {
					reject(
						new Error(`Invalid JSON from search.mjs: ${out.slice(0, 200)}`),
					);
				}
			}
		});
	});
}

/**
 * Build a progress callback that tracks completed engines.
 * Returns an onProgress function suitable for runSearch.
 */
export function makeProgressTracker(
	engines: readonly string[],
	onUpdate: ((update: ProgressUpdate) => void) | undefined,
	suffix: "Searching" | "Researching",
	depth: string,
) {
	const completed = new Map<string, "done" | "error" | "needs-human">();

	return (eng: string, status: "done" | "error" | "needs-human") => {
		completed.set(eng, status);
		const parts: string[] = [];
		for (const e of engines) {
			const s = completed.get(e);
			if (s === "done") parts.push(`✅ ${e} done`);
			else if (s === "error") parts.push(`❌ ${e} failed`);
			else if (s === "needs-human")
				parts.push(`🔓 ${e} needs manual verification`);
			else parts.push(`⏳ ${e}`);
		}
		// Synthesis status: when all engines complete in non-fast mode,
		// show synthesis progress.  Handle "skipped" status (emitted when
		// manual verification is needed and synthesis is bypassed).
		if (depth !== "fast" && completed.size >= 3) {
			const synStatus = completed.get("synthesis");
			if (synStatus === "done") parts.push("✅ synthesized");
			else if (synStatus === "error") parts.push("❌ synthesis failed");
			else if (synStatus === "needs-human") parts.push("⏭️ synthesis skipped");
			else parts.push("🔄 synthesizing");
		}

		onUpdate?.({
			content: [
				{ type: "text", text: `**${suffix}...** ${parts.join(" · ")}` },
			],
			details: { _progress: true },
		} satisfies ProgressUpdate);
	};
}

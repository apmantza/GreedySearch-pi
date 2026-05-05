/**
 * Shared types, utilities, and runSearch for Pi tool handlers
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProgressUpdate, ToolResult } from "../types.js";

export type { ProgressUpdate, ToolResult } from "../types.js";

// Canonical source is src/search/constants.mjs — keep in sync
const ALL_ENGINES = ["perplexity", "bing", "google"] as const;

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
 * Shared by greedy_search and deep_research tool handlers.
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
		// Propagate visibility preference via env (--headless flag is informational;
		// the actual headless control in search.mjs / launch.mjs reads the env var).
		const procEnv = { ...process.env };
		if (headless === false) procEnv.GREEDY_SEARCH_VISIBLE = "1";
		const proc = spawn(
			"node",
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
			for (const line of d.toString().split("\n")) {
				const match = line.match(/^PROGRESS:(\w+):(done|error|needs-human)$/);
				if (match && onProgress) {
					onProgress(match[1], match[2] as "done" | "error" | "needs-human");
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
		if (depth !== "fast" && completed.size >= 3) parts.push("🔄 synthesizing");

		onUpdate?.({
			content: [
				{ type: "text", text: `**${suffix}...** ${parts.join(" · ")}` },
			],
			details: { _progress: true },
		} satisfies ProgressUpdate);
	};
}

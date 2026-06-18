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

/** Progress update for a single engine finishing/failing */
type EngineProgress = {
	type: "engine";
	engine: string;
	status: "done" | "error" | "needs-human";
};

/** Free-form progress text (e.g. research bar + ETA) */
type TextProgress = {
	type: "text";
	text: string;
};

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
	onProgress?: (update: EngineProgress | TextProgress) => void,
	options: { headless?: boolean } = {},
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const { headless = true } = options;
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
			// Match PROGRESS lines for any known engine.
			const ENGINE_PROGRESS_RE =
				/^PROGRESS:(perplexity|google|chatgpt|bing|gemini|semantic-scholar|semanticscholar|s2|logically):(done|error|needs-human)$/;
			for (const line of d.toString().split("\n")) {
				// Engine progress: any known engine
				const engineMatch = line.match(ENGINE_PROGRESS_RE);
				if (engineMatch && onProgress) {
					onProgress({
						type: "engine",
						engine: engineMatch[1],
						status: engineMatch[2] as "done" | "error" | "needs-human",
					});
				}
				// Synthesis progress: skipped (manual verification) or done/error
				const synthMatch = line.match(
					/^PROGRESS:synthesis:(done|error|skipped)$/,
				);
				if (synthMatch && onProgress) {
					onProgress({
						type: "engine",
						engine: "synthesis",
						status: synthMatch[1] as "done" | "error" | "needs-human",
					});
				}
				// Research progress markers (planning/fetching/synthesizing)
				const researchMatch = line.match(/^PROGRESS:research:(.+)$/);
				if (researchMatch && onProgress) {
					onProgress({
						type: "text",
						text: researchMatch[1],
					});
				}
				// Progress bar + ETA lines from createProgressTracker
				const barMatch = line.match(/^\[greedysearch\] (\[.+?\] .+)$/);
				if (barMatch && onProgress) {
					onProgress({
						type: "text",
						text: barMatch[1],
					});
				}
				// Single-engine stage lines: "[perplexity] stage: nav (+563ms)"
				const stageMatch = line.match(
					/^\[(perplexity|google|chatgpt|bing|gemini|semantic-scholar|logically)\] stage: (.+) \(\+\d+ms\)$/,
				);
				if (stageMatch && onProgress) {
					onProgress({
						type: "text",
						text: `${stageMatch[1]}: ${stageMatch[2]}`,
					});
				}
			}
		});

		proc.stdout.on("data", (d: Buffer) => (out += d));
		proc.on("close", (code: number) => {
			signal?.removeEventListener("abort", onAbort);
			if (code !== 0) {
				reject(new Error(err.trim() || `search.mjs exited with code ${code}`));
			} else {
				// For single-engine calls, signal completion so the progress
				// tracker can mark the engine as done.
				if (onProgress && engine !== "all") {
					onProgress({
						type: "engine",
						engine,
						status: "done" as const,
					});
				}
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
 * Render a Unicode progress bar.
 * Example: [████████████░░░░] for 75%
 */
function renderBar(done: number, total: number): string {
	if (total <= 0) return "";
	const width = 16;
	const filled = Math.round((done / total) * width);
	return (
		"[" +
		"█".repeat(Math.min(filled, width)) +
		"░".repeat(Math.max(0, width - filled)) +
		"]"
	);
}

/**
 * Format milliseconds as a short human duration.
 * e.g. "—" / "45s" / "1m 30s"
 */
function fmtDuration(ms: number): string {
	if (ms < 1000) return "—";
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * Build a progress callback that tracks completed engines.
 * Returns an onProgress function suitable for runSearch.
 *
 * For multi-engine calls (research or not) this shows a bar + ETA
 * line that tracks fraction of engines completed.  The bar always
 * appears; the research-path bar from `createProgressTracker` takes
 * priority when present.
 */
export function makeProgressTracker(
	engines: readonly string[],
	onUpdate: ((update: ProgressUpdate) => void) | undefined,
	suffix: "Searching" | "Researching",
	showSynthesis: boolean,
	query?: string,
) {
	const startedAt = Date.now();
	const completed = new Map<string, "done" | "error" | "needs-human">();
	let latestBarText = "";

	function render() {
		const lines: string[] = [];
		lines.push(`**${suffix}...** ${query || ""}`.trim());

		const done = completed.size;

		// Multi-engine bar + ETA (unless research supplies its own bar)
		if (engines.length > 1 && done > 0 && !latestBarText) {
			const elapsed = Date.now() - startedAt;
			const frac = Math.min(1, done / engines.length);
			const etaMs = frac > 0.01 ? Math.round(elapsed / frac - elapsed) : null;
			const bar = renderBar(done, engines.length);
			const eta = etaMs != null && etaMs > 0 ? fmtDuration(etaMs) : "—";
			lines.push(`${bar} ${done}/${engines.length} engines (ETA ${eta})`);
		}

		// Research mode bar from createProgressTracker has priority
		if (latestBarText) lines.push(latestBarText);

		const parts: string[] = [];
		for (const e of engines) {
			const s = completed.get(e);
			if (s === "done") parts.push(`✅ ${e} done`);
			else if (s === "error") parts.push(`❌ ${e} failed`);
			else if (s === "needs-human")
				parts.push(`🔓 ${e} needs manual verification`);
			else parts.push(`⏳ ${e}`);
		}
		if (showSynthesis && done >= engines.length) {
			const synStatus = completed.get("synthesis");
			if (synStatus === "done") parts.push("✅ synthesized");
			else if (synStatus === "error") parts.push("❌ synthesis failed");
			else if (synStatus === "needs-human") parts.push("⏭️ synthesis skipped");
			else parts.push("🔄 synthesizing");
		}
		if (parts.length > 0) {
			// Engine status line: 5 engines with emoji+separator runs ~110
			// chars, which is right at the 112-char terminal width. Truncate
			// with ellipsis if the join overflows — the TUI's Text.render
			// can't wrap a single line and crashes with
			//   "Rendered line N exceeds terminal width (W > W-4)"
			// if a single rendered line is wider than the terminal.
			const statusLine = parts.join(" · ");
			lines.push(
				statusLine.length > 110
					? statusLine.slice(0, 107) + "…"
					: statusLine,
			);
		}

		onUpdate?.({
			content: [{ type: "text", text: lines.join("\n") }],
			details: { _progress: true },
		} satisfies ProgressUpdate);
	}

	return (update: EngineProgress | TextProgress) => {
		if (update.type === "text") {
			if (update.text.startsWith("[")) {
				latestBarText = update.text;
			}
			render();
			return;
		}

		const { engine, status } = update;
		completed.set(engine, status);
		render();
	};
}

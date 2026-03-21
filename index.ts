/**
 * GreedySearch Pi Extension
 *
 * Adds a `greedy_search` tool to Pi that fans out queries to Perplexity,
 * Bing Copilot, and Google AI in parallel, returning synthesized AI answers.
 *
 * Reports streaming progress as each engine completes.
 * Requires Chrome to be running (or it auto-launches a dedicated instance).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const __dir = dirname(fileURLToPath(import.meta.url));

const ALL_ENGINES = ["perplexity", "bing", "google"] as const;

function cdpAvailable(): boolean {
	return existsSync(join(__dir, "cdp.mjs"));
}

function runSearch(
	engine: string,
	query: string,
	flags: string[] = [],
	signal?: AbortSignal,
	onProgress?: (engine: string, status: "done" | "error") => void,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [__dir + "/search.mjs", engine, "--inline", ...flags, query], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";

		const onAbort = () => { proc.kill("SIGTERM"); reject(new Error("Aborted")); };
		signal?.addEventListener("abort", onAbort, { once: true });

		// Watch stderr for progress events (PROGRESS:engine:done|error)
		proc.stderr.on("data", (d: Buffer) => {
			err += d;
			const lines = d.toString().split("\n");
			for (const line of lines) {
				const match = line.match(/^PROGRESS:(\w+):(done|error)$/);
				if (match && onProgress) {
					onProgress(match[1], match[2] as "done" | "error");
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
					reject(new Error(`Invalid JSON from search.mjs: ${out.slice(0, 200)}`));
				}
			}
		});
	});
}

function formatResults(engine: string, data: Record<string, unknown>): string {
	const lines: string[] = [];

	if (engine === "all") {
		// Synthesized output: prefer _synthesis + _sources
		const synthesis = data._synthesis as Record<string, unknown> | undefined;
		const dedupedSources = data._sources as Array<Record<string, unknown>> | undefined;
		if (synthesis?.answer) {
			lines.push("## Synthesis");
			lines.push(String(synthesis.answer));
			if (dedupedSources?.length) {
				lines.push("\n**Top sources by consensus:**");
				for (const s of dedupedSources.slice(0, 6)) {
					const engines = (s.engines as string[]) || [];
					lines.push(`- [${s.title || s.url}](${s.url}) [${engines.length}/3]`);
				}
			}
			lines.push("\n---\n*Synthesized from Perplexity, Bing Copilot, and Google AI*");
			return lines.join("\n").trim();
		}

		// Standard output: per-engine answers
		for (const [eng, result] of Object.entries(data)) {
			if (eng.startsWith("_")) continue;
			lines.push(`\n## ${eng.charAt(0).toUpperCase() + eng.slice(1)}`);
			const r = result as Record<string, unknown>;
			if (r.error) {
				lines.push(`Error: ${r.error}`);
			} else {
				if (r.answer) lines.push(String(r.answer));
				if (Array.isArray(r.sources) && r.sources.length > 0) {
					lines.push("\nSources:");
					for (const s of r.sources.slice(0, 3)) {
						const src = s as Record<string, string>;
						lines.push(`- [${src.title || src.url}](${src.url})`);
					}
				}
			}
		}
	} else {
		if (data.error) {
			lines.push(`Error: ${data.error}`);
		} else {
			if (data.answer) lines.push(String(data.answer));
			if (Array.isArray(data.sources) && data.sources.length > 0) {
				lines.push("\nSources:");
				for (const s of data.sources.slice(0, 5)) {
					const src = s as Record<string, string>;
					lines.push(`- [${src.title || src.url}](${src.url})`);
				}
			}
		}
	}

	return lines.join("\n").trim();
}

export default function greedySearchExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!cdpAvailable()) {
			ctx.ui.notify(
				"GreedySearch: cdp.mjs missing from package directory — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi",
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "greedy_search",
		label: "Greedy Search",
		description:
			"Search the web using AI-powered engines (Perplexity, Bing Copilot, Google AI) in parallel. " +
			"Optionally synthesize results with Gemini — deduplicates sources by consensus and returns one grounded answer. " +
			"Reports streaming progress as each engine completes. " +
			"Use for current information, library docs, error messages, best practices, or any question where training data may be stale.",
		promptSnippet: "Multi-engine AI web search with streaming progress",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			engine: Type.Union(
				[
					Type.Literal("all"),
					Type.Literal("perplexity"),
					Type.Literal("bing"),
					Type.Literal("google"),
					Type.Literal("gemini"),
					Type.Literal("gem"),
				],
				{
					description: 'Engine to use. "all" fans out to Perplexity, Bing, and Google in parallel (default).',
					default: "all",
				},
			),
			synthesize: Type.Optional(Type.Boolean({
				description: 'When true and engine is "all", deduplicates sources across engines and feeds them to Gemini for a single grounded synthesis. Adds ~30s but saves tokens and improves answer quality.',
				default: false,
			})),
			fullAnswer: Type.Optional(Type.Boolean({
				description: 'When true, returns the complete answer instead of a truncated preview (default: false, answers are shortened to ~300 chars to save tokens).',
				default: false,
			})),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query, engine = "all", synthesize = false, fullAnswer = false } = params as {
				query: string; engine: string; synthesize?: boolean; fullAnswer?: boolean;
			};

			if (!cdpAvailable()) {
				return {
					content: [{ type: "text", text: "cdp.mjs missing — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi" }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const flags: string[] = [];
			if (fullAnswer) flags.push("--full");
			if (synthesize && engine === "all") flags.push("--synthesize");

			// Track progress for "all" engine mode
			const completed = new Set<string>();

			const onProgress = (eng: string, status: "done" | "error") => {
				completed.add(eng);
				const parts: string[] = [];
				for (const e of ALL_ENGINES) {
					if (completed.has(e)) parts.push(`✅ ${e} done`);
					else parts.push(`⏳ ${e}`);
				}
				if (synthesize && completed.size >= 3) parts.push("🔄 synthesizing");

				onUpdate?.({
					content: [{ type: "text", text: `**Searching...** ${parts.join(" · ")}` }],
					details: { _progress: true },
				} as any);
			};

			try {
				const data = await runSearch(engine, query, flags, signal, engine === "all" ? onProgress : undefined);
				const text = formatResults(engine, data);
				return {
					content: [{ type: "text", text: text || "No results returned." }],
					details: { raw: data },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}
		},
	});
}

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

function runSearch(engine: string, query: string, flags: string[] = [], signal?: AbortSignal): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [__dir + "/search.mjs", engine, "--inline", ...flags, query], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";

		// Handle abort signal
		const onAbort = () => {
			proc.kill("SIGTERM");
			reject(new Error("Aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		proc.stdout.on("data", (d: Buffer) => (out += d));
		proc.stderr.on("data", (d: Buffer) => (err += d));
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

function formatPartialProgress(results: Record<string, Record<string, unknown>>, completed: string[], total: number): string {
	const parts: string[] = [];
	for (const eng of completed) {
		const r = results[eng];
		if (r?.error) {
			parts.push(`❌ ${eng} failed`);
		} else {
			parts.push(`✅ ${eng} done`);
		}
	}
	const remaining = total - completed.length;
	if (remaining > 0) {
		parts.push(`⏳ ${remaining} pending...`);
	}
	return `**Searching...** ${parts.join(" · ")}`;
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
			const { query, engine = "all", synthesize = false, fullAnswer = false } = params as { query: string; engine: string; synthesize?: boolean; fullAnswer?: boolean };

			if (!cdpAvailable()) {
				return {
					content: [{ type: "text", text: "cdp.mjs missing — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi" }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const flags: string[] = [];
			if (fullAnswer) flags.push("--full");

			// Single engine: just run it directly
			if (engine !== "all") {
				try {
					const data = await runSearch(engine, query, flags, signal);
					const text = formatResults(engine, data);
					return {
						content: [{ type: "text", text: text || "No results returned." }],
						details: { raw: data } as { raw?: Record<string, unknown> },
					};
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					return {
						content: [{ type: "text", text: `Search failed: ${msg}` }],
						details: {} as { raw?: Record<string, unknown> },
					};
				}
			}

			// engine: "all" — run engines in parallel with streaming progress
			const results: Record<string, Record<string, unknown>> = {};
			const completed: string[] = [];
			let allDone = false;

			const enginePromises = ALL_ENGINES.map(async (eng) => {
				try {
					const result = await runSearch(eng, query, flags, signal);
					results[eng] = result;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					results[eng] = { error: msg } as unknown as Record<string, unknown>;
				}
				completed.push(eng);

				// Report progress after each engine completes
				if (!allDone) {
					const progressText = formatPartialProgress(results, completed, ALL_ENGINES.length);
					onUpdate?.({
						content: [{ type: "text", text: progressText }],
						details: { raw: results, _progress: true },
					} as any);
				}
			});

			// Wait for all engines to complete
			await Promise.allSettled(enginePromises);
			allDone = true;

			// Deduplicate sources across all engines
			const allData = results as Record<string, unknown>;
			allData._sources = deduplicateSources(results);

			// Optionally synthesize with Gemini
			if (synthesize && !signal?.aborted) {
				onUpdate?.({
					content: [{ type: "text", text: "**Searching...** ✅ perplexity done · ✅ bing done · ✅ google done · 🔄 Synthesizing with Gemini..." }],
					details: { raw: allData, _progress: true },
				} as any);

				try {
					const synthesis = await runSearch("gemini",
						`Based on the following search results from multiple AI engines, provide a single, synthesized answer to the user's question. Combine the information, resolve any conflicts, and present the most accurate and complete answer.\n\n` +
						`User's question: "${query}"\n\n` +
						`## perplexity\n${(results.perplexity as any)?.answer || "failed"}\n\n` +
						`## bing\n${(results.bing as any)?.answer || "failed"}\n\n` +
						`## google\n${(results.google as any)?.answer || "failed"}\n\n` +
						`Provide a synthesized answer that combines the best information, notes where sources agree or disagree, and is clear and well-structured.`,
						["--short"], signal
					);
					allData._synthesis = { answer: synthesis.answer || "", synthesized: true };
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					allData._synthesis = { error: msg, synthesized: false };
				}
			}

			const text = formatResults("all", allData);
			return {
				content: [{ type: "text", text: text || "No results returned." }],
				details: { raw: allData },
			};
		},
	});
}

function deduplicateSources(results: Record<string, Record<string, unknown>>): Array<Record<string, unknown>> {
	const seen = new Map();
	const engineOrder = ["perplexity", "bing", "google"];

	for (const engine of engineOrder) {
		const r = results[engine] as Record<string, unknown> | undefined;
		const sources = r?.sources as Array<Record<string, string>> | undefined;
		if (!sources) continue;

		for (const s of sources) {
			const url = s.url?.split("#")[0]?.replace(/\/$/, "");
			if (!url || url.length < 10) continue;

			if (!seen.has(url)) {
				seen.set(url, { url: s.url, title: s.title || "", engines: [engine] });
			} else {
				const existing = seen.get(url);
				if (!existing.engines.includes(engine)) {
					existing.engines.push(engine);
				}
				if (!existing.title && s.title) existing.title = s.title;
			}
		}
	}

	return Array.from(seen.values())
		.sort((a: any, b: any) => b.engines.length - a.engines.length)
		.slice(0, 10);
}

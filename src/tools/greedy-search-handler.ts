/**
 * greedy_search tool handler — multi-engine AI web search
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatResults } from "../formatters/results.js";
import { ALL_ENGINES, cdpAvailable, cdpMissingResult, errorResult, makeProgressTracker, runSearch } from "./shared.js";

export function registerGreedySearchTool(pi: ExtensionAPI, baseDir: string) {
	pi.registerTool({
		name: "greedy_search",
		label: "Greedy Search",
		description:
			"WEB SEARCH ONLY — searches live web via Perplexity, Bing Copilot, and Google AI in parallel. " +
			"Optionally synthesizes results with Gemini, deduplicates sources by consensus. " +
			"Use for: library docs, recent framework changes, error messages, best practices, current events. " +
			"Reports streaming progress as each engine completes.",
		promptSnippet: "Multi-engine AI web search with streaming progress",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			engine: Type.Union(
				[Type.Literal("all"), Type.Literal("perplexity"), Type.Literal("bing"), Type.Literal("google"), Type.Literal("gemini"), Type.Literal("gem")],
				{ description: 'Engine to use. "all" fans out to Perplexity, Bing, and Google in parallel (default).', default: "all" },
			),
			depth: Type.Union(
				[Type.Literal("fast"), Type.Literal("standard"), Type.Literal("deep")],
				{ description: "Search depth: fast (single engine, ~15-30s), standard (3 engines + synthesis, ~30-90s), deep (3 engines + source fetching + synthesis + confidence, ~60-180s). Default: standard.", default: "standard" },
			),
			fullAnswer: Type.Optional(Type.Boolean({ description: "When true, returns the complete answer instead of a truncated preview (default: false, answers are shortened to ~300 chars to save tokens).", default: false })),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query, engine = "all", depth = "standard", fullAnswer: fullAnswerParam } = params as {
				query: string; engine: string; depth?: "fast" | "standard" | "deep"; fullAnswer?: boolean;
			};

			if (!cdpAvailable(baseDir)) return cdpMissingResult();

			const flags: string[] = [];
			const fullAnswer = fullAnswerParam ?? (engine !== "all");
			if (fullAnswer) flags.push("--full");
			if (depth === "deep") flags.push("--depth", "deep");
			else if (depth === "standard" && engine === "all") flags.push("--synthesize");

			const onProgress = engine === "all"
				? makeProgressTracker(ALL_ENGINES, onUpdate, "Searching", depth)
				: undefined;

			try {
				const data = await runSearch(engine, query, flags, `${baseDir}/bin/search.mjs`, signal, onProgress);
				const text = formatResults(engine, data);
				return { content: [{ type: "text", text: text || "No results returned." }], details: { raw: data } };
			} catch (e) {
				return errorResult("Search failed", e);
			}
		},
	});
}
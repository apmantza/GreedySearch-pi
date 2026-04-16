/**
 * deep_research tool handler — legacy alias to greedy_search with depth: deep
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { formatDeepResearch } from "../formatters/results.js";
import { ALL_ENGINES, cdpAvailable, cdpMissingResult, errorResult, makeProgressTracker, runSearch } from "./shared.js";

export function registerDeepResearchTool(pi: ExtensionAPI, baseDir: string) {
	pi.registerTool({
		name: "deep_research",
		label: "Deep Research (legacy)",
		description:
			"DEPRECATED — Use greedy_search with depth: 'deep' instead. " +
			"Comprehensive multi-engine research with source fetching and synthesis.",
		promptSnippet: "Deep multi-engine research (legacy alias to greedy_search)",
		parameters: Type.Object({
			query: Type.String({ description: "The research question" }),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query } = params as { query: string };

			if (!cdpAvailable(baseDir)) return cdpMissingResult();

			const onProgress = makeProgressTracker(ALL_ENGINES, onUpdate, "Researching", "standard");

			try {
				const data = await runSearch("all", query, ["--deep"], `${baseDir}/bin/search.mjs`, signal, onProgress);
				const text = formatDeepResearch(data);
				return { content: [{ type: "text", text: text || "No results returned." }], details: { raw: data } };
			} catch (e) {
				return errorResult("Deep research failed", e);
			}
		},
	});
}
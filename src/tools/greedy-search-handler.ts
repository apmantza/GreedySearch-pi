/**
 * greedy_search tool handler — multi-engine AI web search
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { formatResults } from "../formatters/results.js";
import {
	ALL_ENGINES,
	cdpAvailable,
	cdpMissingResult,
	errorResult,
	makeProgressTracker,
	runSearch,
	stripQuotes,
} from "./shared.js";

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
			engine: Type.String({
				description:
					'Engine to use: "all" (default), "perplexity", "bing", "google", "gemini", "gem". "all" fans out to Perplexity, Bing, and Google in parallel.',
				default: "all",
			}),
			depth: Type.String({
				description:
					'Search depth: "fast" (single engine, ~15-30s), "standard" (3 engines + synthesis, ~30-90s), "deep" (3 engines + source fetching + synthesis + confidence, ~60-180s). Default: "standard".',
				default: "standard",
			}),
			fullAnswer: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns the complete answer instead of a truncated preview (default: false, answers are shortened to ~300 chars to save tokens).",
					default: false,
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description:
						"Set to false to show Chrome window (headless is the default). Set GREEDY_SEARCH_VISIBLE=1 to disable headless globally.",
					default: true,
				}),
			),
			visible: Type.Optional(
				Type.Boolean({
					description:
						"Set to true to always use visible Chrome for this search. Alias for headless: false.",
					default: false,
				}),
			),
			alwaysVisible: Type.Optional(
				Type.Boolean({
					description:
						"Set to true to keep GreedySearch in visible Chrome mode for this search. Alias for visible: true.",
					default: false,
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query, fullAnswer: fullAnswerParam } = params as {
				query: string;
				engine: string;
				depth?: "fast" | "standard" | "deep";
				fullAnswer?: boolean;
				headless?: boolean;
				visible?: boolean;
				alwaysVisible?: boolean;
			};
			const engine = stripQuotes((params as any).engine ?? "all") || "all";
			const depth = (stripQuotes((params as any).depth ?? "standard") ||
				"standard") as "fast" | "standard" | "deep";
			const visible =
				(params as any).visible === true ||
				(params as any).alwaysVisible === true ||
				(params as any).headless === false ||
				process.env.GREEDY_SEARCH_VISIBLE === "1" ||
				process.env.GREEDY_SEARCH_ALWAYS_VISIBLE === "1";
			const headless = !visible;

			if (!cdpAvailable(baseDir)) return cdpMissingResult();

			const flags: string[] = [];
			const fullAnswer = fullAnswerParam ?? engine !== "all";
			if (fullAnswer) flags.push("--full");
			if (depth === "deep") flags.push("--depth", "deep");
			else if (depth === "standard" && engine === "all")
				flags.push("--synthesize");

			const onProgress =
				engine === "all"
					? makeProgressTracker(ALL_ENGINES, onUpdate, "Searching", depth)
					: undefined;

			try {
				const data = await runSearch(
					engine,
					query,
					flags,
					`${baseDir}/bin/search.mjs`,
					signal,
					onProgress,
					headless,
				);
				const text = formatResults(engine, data);
				return {
					content: [{ type: "text", text: text || "No results returned." }],
					details: { raw: data },
				};
			} catch (e) {
				return errorResult("Search failed", e);
			}
		},

		renderCall(args, theme) {
			const q = (args.query || "").slice(0, 60);
			const qDisplay = q.length < (args.query || "").length ? `${q}...` : q;
			const engineDisplay =
				args.engine && args.engine !== "all"
					? theme.fg("dim", ` (${args.engine})`)
					: "";
			return new Text(
				`${theme.fg("toolTitle", theme.bold("greedy_search"))} "${theme.fg("accent", qDisplay)}"${engineDisplay}`,
				0,
				0,
			);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				const progressText = (result.content.find((c) => c.type === "text") as any)?.text as string | undefined;
				const display = progressText
					? progressText.replace(/\*\*/g, "")
					: "Searching...";
				return new Text(theme.fg("warning", display), 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text");
			const raw = (result.details as any)?.raw as
				| Record<string, unknown>
				| undefined;

			// Collapsed: one-line summary only
			if (!expanded) {
				const needsHuman = raw?._needsHumanVerification as
					| Record<string, unknown>
					| undefined;
				if (needsHuman) {
					return new Text(
						theme.fg("warning", " → Manual verification required"),
						0,
						0,
					);
				}

				const synthesis = raw?._synthesis as
					| Record<string, unknown>
					| undefined;
				const sources = raw?._sources as Array<unknown> | undefined;
				if (synthesis) {
					const sourceCount = Array.isArray(sources) ? sources.length : 0;
					const agreement = (synthesis.agreement as Record<string, unknown> | undefined)?.level as string | undefined;
					let summary = " → Synthesized";
					if (sourceCount > 0)
						summary += ` · ${sourceCount} source${sourceCount > 1 ? "s" : ""}`;
					if (agreement) summary += ` · ${agreement}`;
					return new Text(theme.fg("muted", summary), 0, 0);
				}

				// Single engine: count its sources
				const engineKeys = Object.keys(raw || {}).filter(
					(k) => !k.startsWith("_"),
				);
				let totalSources = 0;
				for (const key of engineKeys) {
					const eng = (raw as any)[key] as Record<string, unknown> | undefined;
					const s = eng?.sources as Array<unknown> | undefined;
					if (Array.isArray(s)) totalSources += s.length;
				}
				if (totalSources > 0) {
					return new Text(
						theme.fg(
							"muted",
							` → ${totalSources} source${totalSources > 1 ? "s" : ""}`,
						),
						0,
						0,
					);
				}

				// No structured data — show content text as error/fallback
				const snippet = (textContent as any)?.text as string | undefined;
				if (snippet) {
					return new Text(
						theme.fg("warning", ` → ${snippet.slice(0, 80)}`),
						0,
						0,
					);
				}
				return new Text(theme.fg("muted", " → Done"), 0, 0);
			}

			// Expanded: full output
			if (!textContent || textContent.type !== "text") {
				return new Text("", 0, 0);
			}

			const lines = textContent.text
				.split("\n")
				.map((line) => theme.fg("toolOutput", line))
				.join("\n");
			return new Text(`\n${lines}`, 0, 0);
		},
	});
}

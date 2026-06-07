/**
 * greedy_search tool handler — multi-engine AI web search
 */

import { Type } from "@sinclair/typebox";

type ExtensionAPI = {
	registerTool(tool: Record<string, unknown>): void;
};
import { formatResults } from "../formatters/results.js";
import {
	ALL_ENGINES,
	cdpAvailable,
	cdpMissingResult,
	errorResult,
	makeProgressTracker,
	runSearch,
	stripQuotes,
	type ProgressUpdate,
	type ToolResult,
} from "./shared.js";

type GreedySearchParams = {
	query: string;
	engine?: string;
	synthesize?: boolean;
	synthesizer?: string;
	depth?: "fast" | "standard" | "deep" | "research" | string;
	breadth?: number;
	iterations?: number;
	maxSources?: number;
	researchOutDir?: string;
	writeResearchBundle?: boolean;
	fullAnswer?: boolean;
	headless?: boolean;
	visible?: boolean;
	alwaysVisible?: boolean;
};

type ToolTheme = {
	fg(style: string, text: string): string;
	bold(text: string): string;
};

type RenderState = {
	expanded: boolean;
	isPartial?: boolean;
};

class Text {
	constructor(
		private text: string,
		private paddingX = 0,
		private paddingY = 0,
	) {}

	render(width: number): string[] {
		const horizontal = " ".repeat(this.paddingX);
		const blank = "";
		const contentWidth = Math.max(1, width - this.paddingX * 2);
		const lines = this.text.split("\n").flatMap((line) => {
			if (line.length <= contentWidth) return [`${horizontal}${line}`];
			const wrapped: string[] = [];
			for (let i = 0; i < line.length; i += contentWidth) {
				wrapped.push(`${horizontal}${line.slice(i, i + contentWidth)}`);
			}
			return wrapped;
		});
		return [
			...Array.from({ length: this.paddingY }, () => blank),
			...lines,
			...Array.from({ length: this.paddingY }, () => blank),
		];
	}

	invalidate() {}
}

export function registerGreedySearchTool(pi: ExtensionAPI, baseDir: string) {
	pi.registerTool({
		name: "greedy_search",
		label: "Greedy Search",
		description:
			"WEB/RESEARCH SEARCH ONLY — searches live web via Perplexity, Google AI, ChatGPT, and Gemini, plus opt-in research through Logically. " +
			"Research mode is the centerpiece: it plans follow-up actions, fetches sources, audits citations, " +
			"and writes a structured research bundle on disk. " +
			"Use for: library docs, recent framework changes, error messages, best practices, current events. " +
			"Reports streaming progress as each engine completes.",
		promptSnippet: "Multi-engine AI web search with streaming progress",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			engine: Type.String({
				description:
					'Engine to use: "all" (default), "perplexity", "google", "chatgpt", "gemini", "gem". Research engine: "logically". "all" fans out to the configured engines and fetches top sources. Customize via ~/.pi/greedyconfig. Bing Copilot is still available as "bing" for signed-in users.',
				default: "all",
			}),
			synthesize: Type.Optional(
				Type.Boolean({
					description:
						'Only for engine="all": synthesize the multi-engine results and fetched sources. Default: false.',
					default: false,
				}),
			),
			synthesizer: Type.Optional(
				Type.String({
					description:
						'Synthesis engine for synthesize=true. Defaults to ~/.pi/greedyconfig synthesizer (currently "gemini" by default). Supported: "gemini", "chatgpt".',
				}),
			),
			depth: Type.Optional(
				Type.String({
					description:
						'Deprecated except "research". Use depth="research" for the iterative research workflow. Legacy values: "fast" skips source fetching; "standard"/"deep" alias synthesize=true.',
				}),
			),
			breadth: Type.Optional(
				Type.Number({
					description:
						'Only for depth="research": number of parallel research directions per round, 1-5 (default: 3).',
					default: 3,
				}),
			),
			iterations: Type.Optional(
				Type.Number({
					description:
						'Only for depth="research": number of iterative research rounds, 1-3 (default: 2).',
					default: 2,
				}),
			),
			maxSources: Type.Optional(
				Type.Number({
					description:
						'Only for depth="research": maximum fetched sources for the final report, 3-12.',
				}),
			),
			researchOutDir: Type.Optional(
				Type.String({
					description:
						'Only for depth="research": optional directory for the structured research bundle. Defaults to .pi/greedysearch-research/<timestamp>_<query>.',
				}),
			),
			writeResearchBundle: Type.Optional(
				Type.Boolean({
					description:
						'Only for depth="research": write the structured research bundle to disk (default true).',
					default: true,
				}),
			),
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
		execute: async (
			_toolCallId: string,
			params: GreedySearchParams,
			signal?: AbortSignal,
			onUpdate?: (update: ProgressUpdate) => void,
		) => {
			const { query, fullAnswer: fullAnswerParam } = params;
			const engine = stripQuotes(params.engine ?? "all") || "all";
			const depthRaw = stripQuotes(params.depth ?? "") as
				| "fast"
				| "standard"
				| "deep"
				| "research"
				| "";
			const researchMode = depthRaw === "research";
			const legacyFast = depthRaw === "fast";
			const legacySynthesisDepth =
				depthRaw === "standard" || depthRaw === "deep";
			const synthesize =
				engine === "all" &&
				!legacyFast &&
				(params.synthesize === true || legacySynthesisDepth);
			const effectiveEngine = researchMode ? "all" : engine;
			const visible =
				params.visible === true ||
				params.alwaysVisible === true ||
				params.headless === false ||
				process.env.GREEDY_SEARCH_VISIBLE === "1" ||
				process.env.GREEDY_SEARCH_ALWAYS_VISIBLE === "1";
			const headless = !visible;

			if (!cdpAvailable(baseDir)) return cdpMissingResult();

			const flags: string[] = [];
			const fullAnswer = fullAnswerParam ?? effectiveEngine !== "all";
			if (fullAnswer) flags.push("--full");
			if (researchMode) {
				flags.push("--depth", "research");
				if (typeof params.breadth === "number")
					flags.push("--breadth", String(params.breadth));
				if (typeof params.iterations === "number")
					flags.push("--iterations", String(params.iterations));
				if (typeof params.maxSources === "number")
					flags.push("--max-sources", String(params.maxSources));
				if (typeof params.researchOutDir === "string")
					flags.push("--research-out-dir", params.researchOutDir);
				if (params.writeResearchBundle === false)
					flags.push("--no-research-bundle");
			} else if (legacyFast) flags.push("--fast");
			else if (depthRaw === "deep") flags.push("--depth", "deep");
			else if (synthesize) flags.push("--synthesize");
			if (synthesize && typeof params.synthesizer === "string") {
				flags.push("--synthesizer", params.synthesizer);
			}

			const onProgress =
				effectiveEngine === "all"
					? makeProgressTracker(
							ALL_ENGINES,
							onUpdate,
							researchMode ? "Researching" : "Searching",
							synthesize,
						)
					: undefined;

			try {
				const data = await runSearch(
					effectiveEngine,
					query,
					flags,
					`${baseDir}/bin/search.mjs`,
					signal,
					onProgress,
					headless,
				);
				const text = formatResults(effectiveEngine, data);
				return {
					content: [{ type: "text", text: text || "No results returned." }],
					details: { raw: data },
				};
			} catch (e) {
				return errorResult("Search failed", e);
			}
		},

		renderCall(args: Partial<GreedySearchParams>, theme: ToolTheme) {
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

		renderResult(
			result: ToolResult,
			{ expanded, isPartial }: RenderState,
			theme: ToolTheme,
		) {
			if (isPartial) {
				const progressText = result.content.find(
					(c) => c.type === "text",
				)?.text;
				const display = progressText
					? progressText.replace(/\*\*/g, "")
					: "Searching...";
				return new Text(theme.fg("warning", display), 0, 0);
			}

			const textContent = result.content.find((c) => c.type === "text");
			const raw = result.details?.raw as Record<string, unknown> | undefined;

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
					const agreement = (
						synthesis.agreement as Record<string, unknown> | undefined
					)?.level as string | undefined;
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
					const eng = raw?.[key] as Record<string, unknown> | undefined;
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
				const snippet = textContent?.text;
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

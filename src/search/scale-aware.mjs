// src/search/scale-aware.mjs — Complexity classification and fast-path research
//
// Before entering the full iterative loop, classify the query complexity to
// decide whether the expensive multi-round path is warranted. Simple "what is
// X" queries get a fast single-pass path; complex/multi-faceted queries get
// the full iterative treatment (possibly with adjusted breadth/iterations).

import { trimText } from "./sources.mjs";
import { runGeminiPrompt } from "./synthesis-runner.mjs";
import { parseStructuredJson } from "./synthesis.mjs";

const COMPLEXITY_PROMPT_TIMEOUT_MS = 30_000;

function clampInt(value, min, max, fallback) {
	const n = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

/**
 * Classify a research query as simple, moderate, or complex.
 * Returns { complexity, reasoning, suggestedBreadth, suggestedIterations, needsAcademicSources }.
 */
export async function classifyResearchComplexity(query) {
	const prompt = [
		"You are a research complexity classifier.",
		"Classify the following query by research complexity.",
		"",
		"- simple: A narrow factual question (what is X, define X, how does X work).",
		"  Answerable with 1-3 search queries and a short synthesis. No sub-questions.",
		"- moderate: A focused comparison, recent change, or best-practice lookup.",
		"  Needs 2-4 angles but stays within one domain.",
		"- complex: Multi-faceted survey, landscape analysis, or cross-domain investigation.",
		"  Benefits from parallel research directions and iterative deepening.",
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				complexity: "simple",
				reasoning: "narrow factual question",
				suggestedBreadth: 1,
				suggestedIterations: 1,
				needsAcademicSources: false,
			},
			null,
			2,
		),
		"END_JSON",
		"",
		"Query: " + query,
	].join("\n");

	try {
		const raw = await runGeminiPrompt(prompt, {
			timeoutMs: COMPLEXITY_PROMPT_TIMEOUT_MS,
		});
		const parsed = parseStructuredJson(raw?.answer || "") || {};
		const complexity = ["simple", "moderate", "complex"].includes(
			parsed.complexity,
		)
			? parsed.complexity
			: "moderate";
		return {
			complexity,
			reasoning: trimText(parsed.reasoning || "", 200),
			suggestedBreadth: clampInt(
				parsed.suggestedBreadth,
				1,
				5,
				complexity === "simple" ? 1 : 3,
			),
			suggestedIterations: clampInt(
				parsed.suggestedIterations,
				1,
				3,
				complexity === "simple" ? 1 : 2,
			),
			needsAcademicSources: parsed.needsAcademicSources === true,
		};
	} catch (error) {
		process.stderr.write(
			`[greedysearch] Complexity classification failed, defaulting to moderate: ${error.message}\n`,
		);
		return {
			complexity: "moderate",
			reasoning: "classification failed",
			suggestedBreadth: 3,
			suggestedIterations: 2,
			needsAcademicSources: false,
		};
	}
}

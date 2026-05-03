/**
 * Search results formatters
 * Extracted from index.ts
 */

import { formatEngineName, humanizeSourceType } from "../utils/helpers.js";
import { renderSynthesis } from "./synthesis.js";
import { formatSourceLine, renderSourceEvidence } from "./sources.js";

/**
 * Format search results based on engine type
 */
export function formatResults(
	engine: string,
	data: Record<string, unknown>,
): string {
	const lines: string[] = [];

	if (engine === "all") {
		return formatAllEnginesResult(data, lines);
	}

	return formatSingleEngineResult(data, lines);
}

/**
 * Format multi-engine results with synthesis
 */
function formatAllEnginesResult(
	data: Record<string, unknown>,
	lines: string[],
): string {
	const synthesis = data._synthesis as Record<string, unknown> | undefined;
	const dedupedSources = data._sources as
		| Array<Record<string, unknown>>
		| undefined;

	// If we have a synthesis answer, render it
	if (synthesis?.answer) {
		renderSynthesis(lines, synthesis, dedupedSources || [], 6);
		lines.push("*Synthesized from Perplexity, Bing Copilot, and Google AI*\n");
		return lines.join("\n").trim();
	}

	// Fallback: render individual engine results
	for (const [eng, result] of Object.entries(data)) {
		if (eng.startsWith("_")) continue;
		lines.push(`\n## ${formatEngineName(eng)}`);
		formatEngineResult(result as Record<string, unknown>, lines, 3);
	}

	return lines.join("\n").trim();
}

/**
 * Format single engine result
 */
function formatSingleEngineResult(
	data: Record<string, unknown>,
	lines: string[],
): string {
	formatEngineResult(data, lines, 5);
	return lines.join("\n").trim();
}

/**
 * Format a single engine's result (answer + sources)
 */
function formatEngineResult(
	data: Record<string, unknown>,
	lines: string[],
	maxSources: number,
): void {
	if (data.error) {
		lines.push(`Error: ${data.error}`);
		return;
	}

	if (data.answer) {
		lines.push(String(data.answer));
	}

	const sources = data.sources as Array<Record<string, string>> | undefined;
	if (Array.isArray(sources) && sources.length > 0) {
		lines.push("\nSources:");
		for (const s of sources.slice(0, maxSources)) {
			lines.push(`- [${s.title || s.url}](${s.url})`);
		}
	}
}

/**
 * Format deep research results with confidence metrics
 */

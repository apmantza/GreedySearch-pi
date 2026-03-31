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
export function formatDeepResearch(data: Record<string, unknown>): string {
	const lines: string[] = [];
	const confidence = data._confidence as Record<string, unknown> | undefined;
	const dedupedSources = data._sources as
		| Array<Record<string, unknown>>
		| undefined;
	const synthesis = data._synthesis as Record<string, unknown> | undefined;

	lines.push("# Deep Research Report\n");

	if (confidence) {
		formatConfidenceSection(lines, confidence);
	}

	if (synthesis?.answer) {
		renderSynthesis(lines, synthesis, dedupedSources || [], 8);
	}

	formatEnginePerspectives(lines, data);
	formatSourceRegistry(lines, dedupedSources || []);

	return lines.join("\n").trim();
}

/**
 * Format confidence section with metrics
 */
function formatConfidenceSection(
	lines: string[],
	confidence: Record<string, unknown>,
): void {
	const enginesResponded = (confidence.enginesResponded as string[]) || [];
	const enginesFailed = (confidence.enginesFailed as string[]) || [];
	const agreementLevel = String(confidence.agreementLevel || "mixed");
	const firstPartySourceCount = Number(confidence.firstPartySourceCount || 0);
	const sourceTypeBreakdown = confidence.sourceTypeBreakdown as
		| Record<string, number>
		| undefined;

	lines.push("## Confidence\n");
	lines.push(`- Agreement: ${formatEngineName(agreementLevel)}`);
	lines.push(
		`- Engines responded: ${enginesResponded.map(formatEngineName).join(", ") || "none"}`,
	);

	if (enginesFailed.length > 0) {
		lines.push(
			`- Engines failed: ${enginesFailed.map(formatEngineName).join(", ")}`,
		);
	}

	lines.push(
		`- Top source consensus: ${confidence.topSourceConsensus || 0}/3 engines`,
	);
	lines.push(`- Total unique sources: ${confidence.sourcesCount || 0}`);
	lines.push(`- Official sources: ${confidence.officialSourceCount || 0}`);
	lines.push(`- First-party sources: ${firstPartySourceCount}`);
	lines.push(
		`- Fetch success rate: ${confidence.fetchedSourceSuccessRate || 0}`,
	);

	if (sourceTypeBreakdown && Object.keys(sourceTypeBreakdown).length > 0) {
		lines.push(
			`- Source mix: ${Object.entries(sourceTypeBreakdown)
				.map(([type, count]) => `${humanizeSourceType(type)} ${count}`)
				.join(", ")}`,
		);
	}

	lines.push("");
}

/**
 * Format engine perspectives section
 */
function formatEnginePerspectives(
	lines: string[],
	data: Record<string, unknown>,
): void {
	lines.push("## Engine Perspectives\n");

	for (const engine of ["perplexity", "bing", "google"]) {
		const r = data[engine] as Record<string, unknown> | undefined;
		if (!r) continue;

		lines.push(`### ${formatEngineName(engine)}`);

		if (r.error) {
			lines.push(`⚠️ Error: ${r.error}`);
		} else if (r.answer) {
			lines.push(String(r.answer).slice(0, 2000));
		}

		lines.push("");
	}
}

/**
 * Format source registry section
 */
function formatSourceRegistry(
	lines: string[],
	sources: Array<Record<string, unknown>>,
): void {
	if (sources.length === 0) return;

	lines.push("## Source Registry\n");
	for (const source of sources) {
		lines.push(formatSourceLine(source));
		renderSourceEvidence(lines, source);
	}
	lines.push("");
}

/**
 * Search results formatters
 * Extracted from index.ts
 */

import { formatEngineName } from "../utils/helpers.js";
import { renderSynthesis } from "./synthesis.js";

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
	const needsHuman = data._needsHumanVerification as
		| Record<string, unknown>
		| undefined;
	const research = data._research as Record<string, unknown> | undefined;

	if (needsHuman) {
		const engines = Array.isArray(needsHuman.engines)
			? needsHuman.engines.join(", ")
			: "one or more engines";
		lines.push("## Manual verification required");
		lines.push(
			String(
				needsHuman.message ||
					"Visible Chrome is open. Solve the verification challenge, then rerun the same search.",
			),
		);
		lines.push(`Engines: ${engines}`);
		lines.push("");
	}

	// If we have a synthesis answer, render it
	if (synthesis?.answer) {
		if (research?.mode === "iterative") renderResearchHeader(lines, research);
		renderSynthesis(lines, synthesis, dedupedSources || [], 6);
		const synthesizedBy = String(
			synthesis.synthesizedBy || "configured synthesizer",
		);
		lines.push(
			research?.mode === "iterative"
				? "*Research mode: iterative planning, source fetching, citation audit, and bundle output*\n"
				: `*Synthesized by ${synthesizedBy} from multi-engine results and fetched sources*\n`,
		);
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

function renderResearchHeader(
	lines: string[],
	research: Record<string, unknown>,
): void {
	const floor = research.floor as Record<string, unknown> | undefined;
	const metrics = floor?.metrics as Record<string, unknown> | undefined;
	const bundle = research.bundle as Record<string, unknown> | undefined;
	const manifest = research.manifest as Record<string, unknown> | undefined;
	lines.push("## Research Run");
	lines.push(
		`- Status: ${floor?.floorMet ? "floor met" : "partial / floor unmet"}`,
	);
	if (manifest?.terminationReason)
		lines.push(`- Stop reason: ${String(manifest.terminationReason)}`);
	if (metrics) {
		lines.push(
			`- Evidence: ${metrics.fetchedOk || 0} fetched sources, ${metrics.primarySources || 0} primary/official, ${metrics.claims || 0} claims, ${metrics.cited || 0} citations`,
		);
		lines.push(
			`- Questions: ${metrics.closedQuestions || 0}/${metrics.totalQuestions || 0} closed${metrics.openQuestions ? `, ${metrics.openQuestions} open` : ""}`,
		);
	}
	if (bundle?.dir) lines.push(`- Bundle: ${String(bundle.dir)}`);
	lines.push("");
}

/**
 * Format single engine result
 */
function formatSingleEngineResult(
	data: Record<string, unknown>,
	lines: string[],
): string {
	const needsHuman = data._needsHumanVerification as
		| Record<string, unknown>
		| undefined;
	if (needsHuman) {
		const engines = Array.isArray(needsHuman.engines)
			? needsHuman.engines.join(", ")
			: "this engine";
		lines.push("## Manual verification required");
		lines.push(
			String(
				needsHuman.message ||
					"Visible Chrome is open. Solve the verification challenge, then rerun the same search.",
			),
		);
		lines.push(`Engines: ${engines}`);
		lines.push("");
	}
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

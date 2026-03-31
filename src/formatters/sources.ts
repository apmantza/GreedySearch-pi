/**
 * Source formatting utilities
 * Extracted from index.ts
 */

import { formatEngineName, humanizeSourceType } from "../utils/helpers.js";

/**
 * Get source URL from various possible fields
 */
export function sourceUrl(source: Record<string, unknown>): string {
	return String(source.displayUrl || source.canonicalUrl || source.url || "");
}

/**
 * Get source label/title from various possible fields
 */
export function sourceLabel(source: Record<string, unknown>): string {
	return String(
		source.title || source.domain || sourceUrl(source) || "Untitled source",
	);
}

/**
 * Calculate consensus score (engine count)
 */
export function sourceConsensus(source: Record<string, unknown>): number {
	if (typeof source.engineCount === "number") return source.engineCount;
	const engines = Array.isArray(source.engines)
		? (source.engines as string[])
		: [];
	return engines.length;
}

/**
 * Build a map of sources by ID for quick lookup
 */
export function getSourceMap(
	sources: Array<Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
	return new Map(
		sources
			.map((source) => [String(source.id || ""), source] as const)
			.filter(([id]) => id),
	);
}

/**
 * Format a single source line for display
 */
export function formatSourceLine(source: Record<string, unknown>): string {
	const id = String(source.id || "?");
	const url = sourceUrl(source);
	const title = sourceLabel(source);
	const domain = String(source.domain || "");
	const engines = Array.isArray(source.engines)
		? (source.engines as string[])
		: [];
	const consensus = sourceConsensus(source);
	const typeLabel = humanizeSourceType(String(source.sourceType || ""));
	const fetch = source.fetch as Record<string, unknown> | undefined;
	const fetchStatus = fetch?.ok
		? `fetched ${fetch.status || 200}`
		: fetch?.attempted
			? "fetch failed"
			: "";

	const pieces = [
		`${id} - [${title}](${url})`,
		domain,
		typeLabel,
		engines.length
			? `cited by ${engines.map(formatEngineName).join(", ")} (${consensus}/3)`
			: `${consensus}/3`,
		fetchStatus,
	].filter(Boolean);

	return `- ${pieces.join(" - ")}`;
}

/**
 * Render source evidence (snippet, last modified, errors)
 */
export function renderSourceEvidence(
	lines: string[],
	source: Record<string, unknown>,
): void {
	const fetch = source.fetch as Record<string, unknown> | undefined;
	if (!fetch?.attempted) return;

	const snippet = String(fetch.snippet || "").trim();
	const lastModified = String(fetch.lastModified || "").trim();

	if (snippet) lines.push(`  Evidence: ${snippet}`);
	if (lastModified) lines.push(`  Last-Modified: ${lastModified}`);
	if (fetch.error) lines.push(`  Fetch error: ${String(fetch.error)}`);
}

/**
 * Pick top sources, preferring recommended ones
 */
export function pickSources(
	sources: Array<Record<string, unknown>>,
	recommendedIds: string[] = [],
	max = 6,
): Array<Record<string, unknown>> {
	if (!sources.length) return [];

	const sourceMap = getSourceMap(sources);
	const recommended = recommendedIds
		.map((id) => sourceMap.get(id))
		.filter((source): source is Record<string, unknown> => Boolean(source));

	if (recommended.length > 0) return recommended.slice(0, max);
	return sources.slice(0, max);
}

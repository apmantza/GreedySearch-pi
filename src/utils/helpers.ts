/**
 * Utility helpers for formatting
 * Consolidated from single-use functions in index.ts
 */

/**
 * Format engine name for display
 * Replaces 'bing' with 'Bing Copilot', etc.
 */
export function formatEngineName(engine: string): string {
	const displayNames: Record<string, string> = {
		bing: "Bing Copilot",
		google: "Google AI",
		gemini: "Gemini",
		copilot: "Copilot",
		perplexity: "Perplexity",
	};

	return (
		displayNames[engine] ??
		engine.charAt(0).toUpperCase() + engine.slice(1)
	);
}

/**
 * Humanize source type labels
 */
export function humanizeSourceType(sourceType: string): string {
	if (!sourceType) return "";
	if (sourceType === "official-docs") return "official docs";
	return sourceType.replace(/-/g, " ");
}

/**
 * Format agreement level with proper capitalization
 */
export function formatAgreementLevel(level: string): string {
	if (!level) return "Mixed";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

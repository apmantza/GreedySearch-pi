/**
 * Coding task result formatters
 * Extracted from index.ts to reduce complexity
 */

import { formatEngineName } from "../utils/helpers.js";

interface CodeBlock {
	language: string;
	code: string;
}

interface CodingResult {
	explanation?: string;
	code?: CodeBlock[];
	url?: string;
	error?: string;
}

/**
 * Format a single coding result (explanation + code blocks + source)
 * Extracted to avoid duplication in multi-engine and single-engine paths
 */
function formatCodingResult(result: CodingResult, lines: string[]): void {
	if (result.error) {
		lines.push(`⚠️ Error: ${result.error}\n`);
		return;
	}

	if (result.explanation) {
		lines.push(String(result.explanation));
	}

	if (Array.isArray(result.code) && result.code.length > 0) {
		for (const block of result.code) {
			lines.push(`\n\`\`\`${block.language}\n${block.code}\n\`\`\`\n`);
		}
	}

	if (result.url) {
		lines.push(`*Source: ${result.url}*\n`);
	}
}

/**
 * Format coding task results - supports both single and multi-engine results
 */
export function formatCodingTask(
	data: Record<string, unknown> | Record<string, Record<string, unknown>>,
): string {
	const lines: string[] = [];

	// Check if it's multi-engine result
	const hasMultipleEngines = "gemini" in data || "copilot" in data;

	if (hasMultipleEngines) {
		// Multi-engine result
		for (const [engineName, result] of Object.entries(data)) {
			lines.push(`## ${formatEngineName(engineName)}\n`);
			formatCodingResult(result as CodingResult, lines);
		}
	} else {
		// Single engine result
		formatCodingResult(data as CodingResult, lines);
	}

	return lines.join("\n").trim();
}

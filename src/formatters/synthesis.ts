/**
 * Synthesis and research result formatters
 * Extracted from index.ts
 */

import { formatAgreementLevel } from "../utils/helpers.js";
import {
	formatSourceLine,
	pickSources,
	renderSourceEvidence,
} from "./sources.js";

/**
 * Render synthesis data (answer, consensus, differences, caveats, claims, sources)
 */
export function renderSynthesis(
	lines: string[],
	synthesis: Record<string, unknown>,
	sources: Array<Record<string, unknown>>,
	maxSources = 6,
): void {
	// Answer section
	if (synthesis.answer) {
		lines.push("## Answer");
		lines.push(String(synthesis.answer));
		lines.push("");
	}

	// Consensus section
	const agreement = synthesis.agreement as Record<string, unknown> | undefined;
	const agreementSummary = String(agreement?.summary || "").trim();
	const agreementLevel = String(agreement?.level || "").trim();

	if (agreementSummary || agreementLevel) {
		lines.push("## Consensus");
		lines.push(
			`- ${formatAgreementLevel(agreementLevel)}${agreementSummary ? ` - ${agreementSummary}` : ""}`,
		);
		lines.push("");
	}

	// Differences section
	const differences = Array.isArray(synthesis.differences)
		? (synthesis.differences as string[])
		: [];
	if (differences.length > 0) {
		lines.push("## Where Engines Differ");
		for (const difference of differences) lines.push(`- ${difference}`);
		lines.push("");
	}

	// Caveats section
	const caveats = Array.isArray(synthesis.caveats)
		? (synthesis.caveats as string[])
		: [];
	if (caveats.length > 0) {
		lines.push("## Caveats");
		for (const caveat of caveats) lines.push(`- ${caveat}`);
		lines.push("");
	}

	// Claims section
	const claims = Array.isArray(synthesis.claims)
		? (synthesis.claims as Array<Record<string, unknown>>)
		: [];
	if (claims.length > 0) {
		lines.push("## Key Claims");
		for (const claim of claims) {
			const sourceIds = Array.isArray(claim.sourceIds)
				? (claim.sourceIds as string[])
				: [];
			const support = String(claim.support || "moderate");
			lines.push(
				`- ${String(claim.claim || "")} [${support}${sourceIds.length ? `; ${sourceIds.join(", ")}` : ""}]`,
			);
		}
		lines.push("");
	}

	// Top sources section
	const recommendedIds = Array.isArray(synthesis.recommendedSources)
		? (synthesis.recommendedSources as string[])
		: [];
	const topSources = pickSources(sources, recommendedIds, maxSources);

	if (topSources.length > 0) {
		lines.push("## Top Sources");
		for (const source of topSources) lines.push(formatSourceLine(source));
		lines.push("");
	}
}

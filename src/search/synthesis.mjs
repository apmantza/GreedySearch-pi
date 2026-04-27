// src/search/synthesis.mjs — Synthesis prompt building, structured JSON parsing,
// confidence metrics, and payload normalization
//
// Extracted from search.mjs to reduce file complexity.

import { ALL_ENGINES } from "./constants.mjs";
import { trimText } from "./sources.mjs";

export function parseStructuredJson(text) {
	if (!text) return null;
	let trimmed = String(text).trim();

	// Look for BEGIN_JSON/END_JSON markers first
	const beginIdx = trimmed.indexOf("BEGIN_JSON");
	const endIdx = trimmed.indexOf("END_JSON");
	if (beginIdx !== -1 && endIdx !== -1 && beginIdx < endIdx) {
		trimmed = trimmed.slice(beginIdx + "BEGIN_JSON".length, endIdx).trim();
	} else {
		// Strip out common LLM preamble text before the actual JSON
		const jsonStart = trimmed.indexOf("{");
		if (jsonStart > 0) {
			trimmed = trimmed.slice(jsonStart);
		}
	}

	const candidates = [
		trimmed,
		trimmed
			.replace(/^```json\s*/i, "")
			.replace(/^```\s*/i, "")
			.replace(/```$/i, "")
			.trim(),
	];

	const objectMatch = trimmed.match(/\{[\s\S]*\}$/);
	if (objectMatch) candidates.push(objectMatch[0]);

	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// try next candidate
		}
	}
	return null;
}

export function normalizeSynthesisPayload(
	payload,
	sources,
	fallbackAnswer = "",
) {
	const sourceIds = new Set(sources.map((source) => source.id));
	const agreementLevel = [
		"high",
		"medium",
		"low",
		"mixed",
		"conflicting",
	].includes(payload?.agreement?.level)
		? payload.agreement.level
		: "mixed";
	const claims = Array.isArray(payload?.claims)
		? payload.claims
				.map((claim) => ({
					claim: trimText(claim?.claim || "", 260),
					support: ["strong", "moderate", "weak", "conflicting"].includes(
						claim?.support,
					)
						? claim.support
						: "moderate",
					sourceIds: Array.isArray(claim?.sourceIds)
						? claim.sourceIds.filter((id) => sourceIds.has(id))
						: [],
				}))
				.filter((claim) => claim.claim)
		: [];
	const recommendedSources = Array.isArray(payload?.recommendedSources)
		? payload.recommendedSources.filter((id) => sourceIds.has(id)).slice(0, 6)
		: [];

	// Clean up fallback answer if it contains preamble text
	const cleanFallback = fallbackAnswer
		? fallbackAnswer.replace(/^[\s\S]*?\{/m, "{").replace(/}\s*[\s\S]*$/m, "}")
		: "";

	return {
		answer: trimText(payload?.answer || cleanFallback || fallbackAnswer, 4000),
		agreement: {
			level: agreementLevel,
			summary: trimText(payload?.agreement?.summary || "", 280),
		},
		differences: Array.isArray(payload?.differences)
			? payload.differences
					.map((item) => trimText(item, 220))
					.filter(Boolean)
					.slice(0, 5)
			: [],
		caveats: Array.isArray(payload?.caveats)
			? payload.caveats
					.map((item) => trimText(item, 220))
					.filter(Boolean)
					.slice(0, 5)
			: [],
		claims,
		recommendedSources,
	};
}

export function buildSynthesisPrompt(
	query,
	results,
	sources,
	{ grounded = false } = {},
) {
	const engineSummaries = {};
	for (const engine of ["perplexity", "bing", "google"]) {
		const result = results[engine];
		if (!result) continue;
		if (result.error) {
			engineSummaries[engine] = {
				status: "error",
				error: String(result.error),
			};
			continue;
		}

		engineSummaries[engine] = {
			status: "ok",
			answer: trimText(result.answer || "", grounded ? 4500 : 2200),
			sourceIds: sources
				.filter((source) => source.engines.includes(engine))
				.sort(
					(a, b) =>
						(a.perEngine[engine]?.rank || 99) -
						(b.perEngine[engine]?.rank || 99),
				)
				.map((source) => source.id)
				.slice(0, 6),
		};
	}

	const sourceRegistry = sources.slice(0, grounded ? 10 : 8).map((source) => ({
		id: source.id,
		title: source.title,
		domain: source.domain,
		canonicalUrl: source.canonicalUrl,
		sourceType: source.sourceType,
		isOfficial: source.isOfficial,
		engines: source.engines,
		engineCount: source.engineCount,
		perEngine: source.perEngine,
		fetch: source.fetch?.attempted
			? {
					ok: source.fetch.ok,
					status: source.fetch.status,
					publishedTime: source.fetch.publishedTime || "",
					lastModified: source.fetch.lastModified || "",
					byline: source.fetch.byline || "",
					siteName: source.fetch.siteName || "",
					...(grounded
						? { snippet: trimText(source.fetch.snippet || "", 700) }
						: {}),
				}
			: undefined,
	}));

	return [
		"Synthesize the following search results into a concise answer.",
		"Compare the three engine responses (Perplexity, Bing, Google) and identify:",
		"1. The main answer to the query",
		"2. Where the engines agree",
		"3. Where they disagree (if anywhere)",
		"4. Any caveats or limitations",
		"Use source IDs like S1, S2 when citing sources.",
		"Format: Start with a brief answer, then list key points.",
		"",
		`Query: ${query}`,
		"",
		`Engine results:\n${JSON.stringify(engineSummaries, null, 2)}`,
		"",
		`Source registry:\n${JSON.stringify(sourceRegistry, null, 2)}`,
	].join("\n");
}

export function buildConfidence(out) {
	const sources = Array.isArray(out._sources) ? out._sources : [];
	const topConsensus = sources.length > 0 ? sources[0]?.engineCount || 0 : 0;
	const officialSourceCount = sources.filter(
		(source) => source.isOfficial,
	).length;
	const firstPartySourceCount = sources.filter(
		(source) => source.isOfficial || source.sourceType === "maintainer-blog",
	).length;
	const fetchedAttempted = sources.filter(
		(source) => source.fetch?.attempted,
	).length;
	const fetchedSucceeded = sources.filter((source) => source.fetch?.ok).length;
	const sourceTypeBreakdown = sources.reduce((acc, source) => {
		acc[source.sourceType] = (acc[source.sourceType] || 0) + 1;
		return acc;
	}, {});
	const synthesisLevel = out._synthesis?.agreement?.level;

	return {
		sourcesCount: sources.length,
		topSourceConsensus: topConsensus,
		agreementLevel:
			synthesisLevel ||
			(topConsensus >= 3 ? "high" : topConsensus >= 2 ? "medium" : "low"),
		enginesResponded: ALL_ENGINES.filter(
			(engine) => out[engine]?.answer && !out[engine]?.error,
		),
		enginesFailed: ALL_ENGINES.filter((engine) => out[engine]?.error),
		officialSourceCount,
		firstPartySourceCount,
		fetchedSourceSuccessRate:
			fetchedAttempted > 0
				? Number((fetchedSucceeded / fetchedAttempted).toFixed(2))
				: 0,
		sourceTypeBreakdown,
	};
}

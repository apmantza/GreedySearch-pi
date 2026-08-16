// src/search/synthesis.mjs — Synthesis prompt building, structured JSON parsing,
// confidence metrics, and payload normalization
//
// Extracted from search.mjs to reduce file complexity.

import { ALL_ENGINES } from "./constants.mjs";
import { trimText } from "./sources.mjs";

function escapeControlCharsInsideJsonStrings(text) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (const char of String(text)) {
		if (escaped) {
			out += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			out += char;
			escaped = true;
			continue;
		}
		if (char === '"') {
			inString = !inString;
			out += char;
			continue;
		}
		if (inString && char === "\n") out += "\\n";
		else if (inString && char === "\r") out += "\\r";
		else if (inString && char === "\t") out += "\\t";
		else out += char;
	}
	return out;
}

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

	// Find the outermost JSON object via brace matching (avoids ReDoS-prone .* patterns)
	const firstBrace = trimmed.indexOf("{");
	const lastBrace = trimmed.lastIndexOf("}");
	if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
		candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
	}

	for (const candidate of [...candidates]) {
		const repaired = escapeControlCharsInsideJsonStrings(candidate);
		if (repaired !== candidate) candidates.push(repaired);
	}

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
	// Use indexOf/lastIndexOf instead of [\s\S]* patterns to avoid ReDoS
	let cleanFallback = "";
	if (fallbackAnswer) {
		const firstBrace = fallbackAnswer.indexOf("{");
		const lastBrace = fallbackAnswer.lastIndexOf("}");
		if (firstBrace !== -1 && lastBrace !== -1 && firstBrace < lastBrace) {
			cleanFallback = fallbackAnswer.slice(firstBrace, lastBrace + 1);
		} else {
			cleanFallback = fallbackAnswer;
		}
	}

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

/**
 * Determine which engine entries of a multi-engine results object should be
 * summarized for synthesis. Filters to non-private (`_`-prefixed) object keys
 * that carry `answer`/`error`/`engine` fields, ordered deterministically:
 * engines in ALL_ENGINES first (config order), then any extras (aliases /
 * engines not in the known list) in object insertion order.
 */
export function getEngineSummaryKeys(results) {
	const knownEngines = Array.isArray(ALL_ENGINES) ? ALL_ENGINES : [];
	return Object.keys(results)
		.filter(
			(key) =>
				!key.startsWith("_") &&
				results[key] &&
				typeof results[key] === "object" &&
				("answer" in results[key] ||
					"error" in results[key] ||
					"engine" in results[key]),
		)
		.sort((a, b) => {
			const ia = knownEngines.indexOf(a);
			const ib = knownEngines.indexOf(b);
			return (
				(ia === -1 ? knownEngines.length : ia) -
				(ib === -1 ? knownEngines.length : ib)
			);
		});
}

export function buildSynthesisPrompt(
	query,
	results,
	sources,
	{ grounded = false } = {},
) {
	// Build over every engine present in `results`, not a hard-coded subset:
	// with ~/.pi/greedyconfig engines like chatgpt/gemini in the fan-out, the
	// synthesizer must see ALL engine answers.
	const engineKeys = getEngineSummaryKeys(results);

	// Per-engine answer cap is primary (matches pre-fix quality for the common
	// 3-4 engine configs); the flat total budget is a safety ceiling that only
	// binds for wide configs (n >= 6) so the assembled prompt stays under the
	// composer's ~32k input ceiling.
	const perEngineCap = grounded ? 4500 : 2200;
	const totalBudget = grounded ? 18000 : 11000;
	const perEngineChars = Math.max(
		1,
		Math.min(
			perEngineCap,
			Math.floor(totalBudget / Math.max(1, engineKeys.length)),
		),
	);
	const engineSummaries = {};
	for (const engine of engineKeys) {
		const result = results[engine];
		if (result.error) {
			engineSummaries[engine] = {
				status: "error",
				error: trimText(String(result.error), 500),
			};
			continue;
		}

		engineSummaries[engine] = {
			status: "ok",
			answer: trimText(result.answer || "", perEngineChars),
			sourceIds: sources
				.filter((source) => source.engines.includes(engine))
				.sort(
					(a, b) =>
						(a.perEngine[engine]?.rank || 99) - (b.perEngine[engine]?.rank || 99),
				)
				.map((source) => source.id)
				.slice(0, 6),
		};
	}

	// Snippet budget: always include content for fetched sources so Gemini can
	// make citation decisions based on what the sources actually say, not just
	// their metadata. Grounded mode gets a larger budget per source.
	const snippetChars = grounded ? 700 : 300;
	const sourceRegistry = sources.slice(0, grounded ? 10 : 8).map((source) => ({
		id: source.id,
		title: source.title,
		domain: source.domain,
		canonicalUrl: source.canonicalUrl,
		sourceType: source.sourceType,
		isOfficial: source.isOfficial,
		engines: source.engines,
		engineCount: source.engineCount,
		fetch: source.fetch?.attempted
			? {
					ok: source.fetch.ok,
					publishedTime: source.fetch.publishedTime || "",
					byline: source.fetch.byline || "",
					snippet: trimText(source.fetch.snippet || "", snippetChars),
				}
			: undefined,
	}));

	return [
		"You are a research synthesizer. Combine these search engine results into a single authoritative answer.",
		"",
		`Query: ${query}`,
		"",
		`Engine summaries:\n${JSON.stringify(engineSummaries, null, 2)}`,
		"",
		`Source registry:\n${JSON.stringify(sourceRegistry, null, 2)}`,
		"",
		"Instructions:",
		"- Write a clear, direct answer in markdown (use headers/bullets where they help readability)",
		"- Cite sources inline as [S1], [S2] etc. when making specific claims",
		"- Prefer sources with content (fetch.ok=true and non-empty snippet) for citations",
		"- Note where the engines agree or meaningfully disagree",
		"- List any important caveats or limitations",
		"- recommendedSources: the 2-4 source IDs most worth reading for this query",
		"",
		"Respond ONLY with a JSON object wrapped in BEGIN_JSON / END_JSON markers:",
		"",
		"BEGIN_JSON",
		JSON.stringify(
			{
				answer: "<your markdown answer here>",
				agreement: {
					level: "high|medium|mixed|conflicting",
					summary: "<one sentence>",
				},
				differences: ["<notable difference between engines, if any>"],
				caveats: ["<important caveat or limitation>"],
				recommendedSources: ["S1", "S2"],
			},
			null,
			2,
		),
		"END_JSON",
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

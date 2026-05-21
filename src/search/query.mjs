// src/search/query.mjs — Query normalization for search engine input
//
// Two universal transforms applied to all engines:
//   1. stripPreamble  — remove agent-generated conversational openers
//   2. addRecencyHint — append current year for temporally-sensitive queries
//
// Note: Google udm=50 is an AI mode with the same query understanding as
// natural-language question form — keyword conversion adds no benefit there.

// Agent preambles that add no search signal
const PREAMBLE_RX = /^(can you |could you |please |would you mind |i need to (know|understand) |i want to (know|understand) |i('m| am) (looking for|wondering about|curious about) |i need (information|info) (about|on) |tell me )?(about |explain |describe |give me |help me understand |search for |look up |find |research )?(about |regarding |on |for )?(it|this|the following)?\s*/i;

// Temporal keywords that indicate recency sensitivity
const TEMPORAL_RX = /\b(latest|newest|current|recent|up-to-date|up to date)\b/i;

// Version numbers and years — if already present, don't add year
const VERSION_RX = /\b\d+\.\d+|\bv\d+\b|\b20(2[0-9]|[3-9]\d)\b/i;

/**
 * Strip common agent-generated preambles that add no search signal.
 * "Can you explain how React hooks work?" → "how React hooks work?"
 */
export function stripPreamble(query) {
	const stripped = query.trim().replace(PREAMBLE_RX, "").trim();
	return stripped.length > 4 ? stripped : query.trim();
}

/**
 * Append current year when the query has explicit recency language but no
 * version number or year. Prevents engines blending old/new results.
 * "latest FastAPI best practices" → "latest FastAPI best practices 2026"
 */
export function addRecencyHint(query, year = new Date().getFullYear()) {
	if (!TEMPORAL_RX.test(query)) return query;
	if (VERSION_RX.test(query)) return query; // already specific
	return `${query.trimEnd()} ${year}`;
}

/**
 * Full normalization pipeline. Engine-agnostic: all three AI search engines
 * handle natural-language questions natively, so no per-engine rewriting.
 * Returns the original query unchanged if transforms produce an empty string.
 */
export function normalizeQuery(query) {
	if (!query?.trim()) return query;
	let q = stripPreamble(query);
	q = addRecencyHint(q);
	return q || query;
}

// src/search/research.mjs — Iterative deep-research orchestration
//
// Research mode borrows the small-loop architecture from open deep-research:
// plan focused queries, run broad search, extract compact learnings + follow-up
// directions, then produce a final report. It deliberately reuses GreedySearch's
// no-API browser engines and source fetchers instead of Firecrawl/OpenAI.

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSourceRegistry,
	classifySourceType,
	computeCompositeScore,
	mergeFetchDataIntoSources,
	normalizeUrl,
	trimText,
} from "./sources.mjs";
import { parseStructuredJson } from "./synthesis.mjs";
import { RESEARCH_ENGINES } from "./constants.mjs";
import { runGeminiPrompt } from "./synthesis-runner.mjs";
import { classifyResearchComplexity } from "./scale-aware.mjs";
import { runSimpleResearchMode } from "./simple-research.mjs";
import { createProgressTracker } from "./progress.mjs";

const __dir = fileURLToPath(new URL(".", import.meta.url)).replace(
	/^\/([A-Z]:)/,
	"$1",
);
const SEARCH_BIN = join(__dir, "..", "..", "bin", "search.mjs");
const DEFAULT_RESEARCH_BUNDLE_ROOT = join(
	process.cwd(),
	".pi",
	"greedysearch-research",
);

function slugifyResearchName(value) {
	const slug = String(value || "research")
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-|-$/g, "")
		.slice(0, 60);
	return slug || "research";
}

function uniqueStrings(items, limit = Infinity) {
	const seen = new Set();
	const out = [];
	for (const item of items || []) {
		const clean = trimText(String(item || ""), 1000);
		if (!clean || seen.has(clean)) continue;
		seen.add(clean);
		out.push(clean);
		if (out.length >= limit) break;
	}
	return out;
}

async function fetchMultipleResearchSources(...args) {
	const { fetchMultipleSources } = await import("./fetch-source.mjs");
	return fetchMultipleSources(...args);
}

async function writeResearchSourcesToFiles(...args) {
	const { writeSourcesToFiles } = await import("./file-sources.mjs");
	return writeSourcesToFiles(...args);
}

export function clampResearchOptions({
	breadth = 3,
	iterations = 2,
	maxSources,
}) {
	const safeBreadth = clampInt(breadth, 1, 5, 3);
	const safeIterations = clampInt(iterations, 1, 3, 2);
	const safeMaxSources = clampInt(
		maxSources ?? Math.max(5, safeBreadth * safeIterations * 2),
		3,
		12,
		8,
	);
	return {
		breadth: safeBreadth,
		iterations: safeIterations,
		maxSources: safeMaxSources,
	};
}

function clampInt(value, min, max, fallback) {
	const n = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

export function normalizeResearchQueries(
	plan,
	originalQuery,
	breadth,
	{ expand = true, includeOriginal = true, exclude = [] } = {},
) {
	const rawQueries = Array.isArray(plan?.queries) ? plan.queries : [];
	const queries = [];
	const excluded = new Set(
		[...exclude].map((item) => sanitizeResearchQuery(item).toLowerCase()),
	);
	for (const item of rawQueries) {
		const query = typeof item === "string" ? item : item?.query;
		const researchGoal =
			typeof item === "string" ? "" : item?.researchGoal || "";
		addResearchQuery(queries, query, researchGoal, { exclude: excluded });
	}

	if (includeOriginal) {
		addResearchQuery(queries, originalQuery, "Original user query", {
			prepend: true,
			exclude: excluded,
		});
	}

	if (expand) {
		const expansionQueries = [
			{
				query: `${originalQuery} official docs GitHub`,
				researchGoal:
					"Find primary project docs, repository details, and maintainer claims.",
			},
			{
				query: `${originalQuery} benchmarks limitations compatibility`,
				researchGoal:
					"Validate performance claims and uncover unsupported APIs or caveats.",
			},
			{
				query: `${originalQuery} alternatives comparison production use cases`,
				researchGoal:
					"Compare against conventional headless browsers and identify when to choose it.",
			},
			{
				query: `${originalQuery} anti bot detection Cloudflare screenshots visual rendering`,
				researchGoal:
					"Check automation risks, rendering gaps, screenshots, and bot-detection behavior.",
			},
		];
		for (const item of expansionQueries) {
			if (queries.length >= breadth) break;
			addResearchQuery(queries, item.query, item.researchGoal, {
				exclude: excluded,
			});
		}
	}

	return queries.slice(0, breadth);
}

function addResearchQuery(
	queries,
	query,
	researchGoal = "",
	{ prepend = false, exclude = new Set() } = {},
) {
	if (!query || typeof query !== "string") return;
	const clean = sanitizeResearchQuery(query);
	if (
		!clean ||
		exclude.has(clean.toLowerCase()) ||
		queries.some((q) => q.query.toLowerCase() === clean.toLowerCase())
	) {
		return;
	}
	const item = { query: clean, researchGoal: trimText(researchGoal, 320) };
	if (prepend) queries.unshift(item);
	else queries.push(item);
}

function sanitizeResearchQuery(query) {
	return collapseWhitespace(stripMarkdownLinks(String(query)));
}

function stripMarkdownLinks(value) {
	let output = "";
	let index = 0;
	while (index < value.length) {
		const openLabel = value.indexOf("[", index);
		if (openLabel === -1) {
			output += value.slice(index);
			break;
		}
		const closeLabel = value.indexOf("]", openLabel + 1);
		if (
			closeLabel === -1 ||
			value[closeLabel + 1] !== "(" ||
			closeLabel === openLabel + 1
		) {
			output += value.slice(index, openLabel + 1);
			index = openLabel + 1;
			continue;
		}
		const closeUrl = value.indexOf(")", closeLabel + 2);
		if (closeUrl === -1) {
			output += value.slice(index, openLabel + 1);
			index = openLabel + 1;
			continue;
		}
		const url = value.slice(closeLabel + 2, closeUrl).trimStart();
		if (!url.startsWith("http://") && !url.startsWith("https://")) {
			output += value.slice(index, openLabel + 1);
			index = openLabel + 1;
			continue;
		}
		output += value.slice(index, openLabel);
		output += value.slice(openLabel + 1, closeLabel);
		index = closeUrl + 1;
	}
	return output;
}

function collapseWhitespace(value) {
	let output = "";
	let previousWasWhitespace = false;
	for (const char of value) {
		if (char === " " || char === "\t" || char === "\n" || char === "\r") {
			if (!previousWasWhitespace) output += " ";
			previousWasWhitespace = true;
		} else {
			output += char;
			previousWasWhitespace = false;
		}
	}
	return output.trim();
}

/**
 * Tokenize a string into lowercase word tokens for Jaccard similarity.
 */
export function tokenSet(value) {
	return new Set(
		String(value)
			.toLowerCase()
			.normalize("NFD")
			.replaceAll(/[\u0300-\u036f]/g, "")
			.split(/[^\w]+/)
			.filter((t) => t.length > 1),
	);
}

/**
 * Jaccard similarity between two strings based on word tokens.
 * Returns 0..1 where 1 = identical token sets.
 */
export function jaccardSimilarity(a, b) {
	const tokensA = tokenSet(a);
	const tokensB = tokenSet(b);
	const unionSize = new Set([...tokensA, ...tokensB]).size;
	if (unionSize === 0) return 1;
	let intersection = 0;
	for (const t of tokensA) {
		if (tokensB.has(t)) intersection++;
	}
	return intersection / unionSize;
}

/**
 * Check if a query is a duplicate or near-duplicate of already-used queries.
 * Returns true if the query should be rejected.
 */
export function isDuplicateQuery(
	query,
	usedQueries,
	{ threshold = 0.75, roundIndex = 0, originalQuery = null } = {},
) {
	const normalized = sanitizeResearchQuery(query).toLowerCase();

	// Exact duplicate check
	if (usedQueries.has(normalized)) return true;

	// Reject the original query after round 1
	if (
		originalQuery &&
		roundIndex > 0 &&
		normalized === sanitizeResearchQuery(originalQuery).toLowerCase()
	) {
		return true;
	}

	// Near-duplicate check via Jaccard similarity
	for (const used of usedQueries) {
		if (jaccardSimilarity(normalized, used) >= threshold) {
			return true;
		}
	}

	return false;
}

/**
 * Evaluate research quality using Gemini and return structured assessment.
 */
function buildQualityEvaluationPrompt(
	originalQuery,
	rounds,
	allLearnings,
	allGaps,
) {
	const roundSummaries = rounds.map((round) => ({
		queries: round.queries?.map((q) => q.query || "") || [],
		learnings: round.learnings || [],
		gaps: round.gaps || [],
	}));

	return [
		"You are evaluating the quality of an iterative research run.",
		"Assess coverage across: official sources, limitations/risks, benchmarks/performance, production usage, and counter-evidence.",
		"Score each dimension 0-10. Overall score 0-10.",
		"Identify remaining knowledge gaps.",
		"Propose targeted next actions (search queries or direct URL fetches) that would most improve the research.",
		"Decide whether to continue or stop.",
		"terminationReason must be one of: quality_threshold | max_rounds | no_novel_actions | insufficient_evidence.",
		"",
		`Original research question: ${originalQuery}`,
		`Rounds completed: ${JSON.stringify(roundSummaries, null, 2)}`,
		`Accumulated learnings: ${JSON.stringify(allLearnings.slice(0, 12), null, 2)}`,
		`Known gaps: ${JSON.stringify(allGaps.slice(0, 8), null, 2)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				score: 7.5,
				coverage: {
					officialSources: 8,
					limitations: 5,
					benchmarks: 7,
					productionUseCases: 6,
					counterEvidence: 4,
				},
				knowledgeGaps: ["specific gap or missing evidence"],
				shouldContinue: true,
				terminationReason: "quality_threshold",
				nextActions: [
					{ type: "search", query: "targeted search query" },
					{ type: "fetchUrl", url: "https://example.com/primary-doc" },
				],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

/**
 * Generate fallback queries based on identified gaps when the planner produces insufficient novel actions.
 */
export function buildFallbackQueriesFromGaps(
	gaps,
	originalQuery,
	usedQueries,
	nextBreadth,
	roundIndex,
) {
	const fallbacks = [];
	const angles = [
		{
			template: (gap) => `${gap} official documentation`,
			label: "official docs",
		},
		{
			template: (gap) => `${gap} GitHub issues discussions`,
			label: "community signals",
		},
		{
			template: (gap) => `${gap} benchmarks performance comparison`,
			label: "benchmarks",
		},
		{
			template: (gap) => `${gap} limitations risks caveats`,
			label: "limitations",
		},
		{
			template: (gap) => `${gap} production deployment experience`,
			label: "production usage",
		},
		{
			template: (gap) => `${originalQuery} ${gap} counter evidence`,
			label: "counter-evidence",
		},
	];

	for (let i = 0; i < gaps.length && fallbacks.length < nextBreadth; i++) {
		const gap = gaps[i];
		const angle = angles[i % angles.length];
		const candidate = angle.template(gap);
		if (!isDuplicateQuery(candidate, usedQueries, { roundIndex })) {
			fallbacks.push({
				query: candidate,
				researchGoal: `Gap-driven: ${gap} (${angle.label})`,
			});
		}
	}

	return fallbacks;
}

async function evaluateResearchQuality(
	originalQuery,
	rounds,
	allLearnings,
	allGaps,
	qualityHistory,
) {
	try {
		const rawEvaluation = await runGeminiPrompt(
			buildQualityEvaluationPrompt(
				originalQuery,
				rounds,
				allLearnings,
				allGaps,
			),
			{ timeoutMs: 120000 },
		);
		const evaluation = parseGeminiJson(rawEvaluation, {});

		// Normalize score
		const score =
			typeof evaluation.score === "number"
				? Math.min(10, Math.max(0, evaluation.score))
				: qualityHistory.length > 0
					? qualityHistory[qualityHistory.length - 1]
					: 5;

		const gaps = Array.isArray(evaluation.knowledgeGaps)
			? evaluation.knowledgeGaps
					.map((g) => String(g))
					.filter(Boolean)
					.slice(0, 6)
			: [];

		const nextActions = Array.isArray(evaluation.nextActions)
			? evaluation.nextActions.slice(0, 5)
			: [];

		const shouldContinue =
			typeof evaluation.shouldContinue === "boolean"
				? evaluation.shouldContinue
				: score < 8;

		const terminationReason = evaluation.terminationReason || null;

		return {
			score,
			coverage: evaluation.coverage || {},
			knowledgeGaps: gaps,
			shouldContinue,
			nextActions,
			terminationReason:
				terminationReason || (score >= 8.5 ? "quality_threshold" : null),
			evaluationError: "",
		};
	} catch (error) {
		process.stderr.write(
			`[greedysearch] Quality evaluation failed: ${error.message}\n`,
		);
		return {
			score:
				qualityHistory.length > 0
					? qualityHistory[qualityHistory.length - 1]
					: 5,
			coverage: {},
			knowledgeGaps: [],
			shouldContinue: true,
			nextActions: [],
			terminationReason: null,
			evaluationError: error.message,
		};
	}
}

function summarizeEngineAnswers(result) {
	const summaries = {};
	for (const engine of Object.keys(result || {}).filter(
		(key) => !key.startsWith("_"),
	)) {
		const value = result?.[engine];
		if (!value) continue;
		summaries[engine] = value.error
			? { status: "error", error: String(value.error) }
			: {
					status: "ok",
					answer: trimText(value.answer || "", 1400),
					sources: Array.isArray(value.sources)
						? value.sources.slice(0, 5).map((s) => ({
								title: trimText(s.title || "", 160),
								url: s.url || "",
							}))
						: [],
				};
	}
	return summaries;
}

/**
 * Action-based research planning prompt.
 * Returns actions: { type: "search" | "fetchUrl", query?, url?, researchGoal? }
 */
function buildResearchActionPrompt(
	query,
	breadth,
	learnings = [],
	gaps = [],
	usedUrls = [],
) {
	const gapSection =
		gaps.length > 0
			? `\nKnown knowledge gaps to target:\n${gaps.map((g) => `- ${g}`).join("\n")}`
			: "";
	const usedUrlSection =
		usedUrls.length > 0
			? `\nAlready fetched URLs (do not re-fetch):\n${usedUrls.map((u) => `- ${u}`).join("\n")}`
			: "";

	return [
		"You are planning web research actions for a multi-engine search agent.",
		"You can plan two types of actions:",
		'  - "search": run a multi-engine SERP search query',
		'  - "fetchUrl": directly fetch a specific URL (docs page, GitHub repo, specification, etc.)',
		'Prefer "fetchUrl" when a specific primary source URL is known or obvious.',
		'Use "search" for broad discovery or when specific URLs are unknown.',
		`Return at most ${breadth} actions.`,
		"Avoid near-duplicate search queries and already-fetched URLs.",
		"",
		`User topic: ${query}`,
		learnings.length
			? `\nPrior learnings to build on:\n${learnings.map((l) => `- ${l}`).join("\n")}`
			: "",
		gapSection,
		usedUrlSection,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				actions: [
					{
						type: "search",
						query: "specific search query",
						researchGoal: "what this action should clarify",
					},
					{
						type: "fetchUrl",
						url: "https://example.com/docs/relevant-page",
						researchGoal: "extract specific information from this page",
					},
				],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

/**
 * Validate and normalize a single research action.
 */
export function validateAction(action) {
	if (!action || typeof action !== "object") return null;
	const type = action.type;
	const researchGoal = trimText(action.researchGoal || "", 320);

	if (type === "search") {
		if (action.query == null) return null;
		const query = sanitizeResearchQuery(action.query);
		return query ? { type: "search", query, researchGoal } : null;
	}
	if (type === "fetchUrl") {
		if (action.url == null) return null;
		const url = normalizeUrl(action.url);
		return url ? { type: "fetchUrl", url, researchGoal } : null;
	}
	return null;
}

/**
 * Execute a research action. Returns { ok, result?, error?, sources?, fetchResult? }
 */
async function executeResearchAction(
	action,
	{ locale = null, short = true, usedQueries, usedUrls, maxChars = 8000 } = {},
) {
	if (action.type === "search") {
		const normalizedQuery = sanitizeResearchQuery(action.query).toLowerCase();
		usedQueries.add(normalizedQuery);

		try {
			const result = await runFastAllSearch(action.query, { locale, short });
			const sources = buildSourceRegistry(result, action.query);
			return {
				ok: true,
				action,
				result,
				sources,
			};
		} catch (error) {
			return {
				ok: false,
				action,
				error: error.message,
				sources: [],
			};
		}
	}

	if (action.type === "fetchUrl") {
		const normalizedUrl = normalizeUrl(action.url);
		if (usedUrls.has(normalizedUrl)) {
			return {
				ok: false,
				action,
				error: `URL already fetched: ${normalizedUrl}`,
				sources: [],
			};
		}

		try {
			const fetchResult = await fetchSingleResearchSource(
				normalizedUrl,
				maxChars,
			);
			usedUrls.add(normalizedUrl);

			// Build a source entry from the fetch result
			const domain = getDomainFromUrl(normalizedUrl);
			const source = {
				id: "",
				canonicalUrl: fetchResult.finalUrl || normalizedUrl,
				displayUrl: fetchResult.url || normalizedUrl,
				domain,
				title: fetchResult.title || normalizedUrl,
				engines: ["fetch"],
				engineCount: 1,
				perEngine: {},
				sourceType: classifySourceType(
					domain,
					fetchResult.title || "",
					fetchResult.finalUrl || normalizedUrl,
				),
				isOfficial: false,
				smartScore: 0,
				fetch: {
					attempted: true,
					ok: !fetchResult.error && (fetchResult.contentChars || 0) > 100,
					status: fetchResult.status || null,
					finalUrl: fetchResult.finalUrl || normalizedUrl,
					content: fetchResult.content || "",
					contentChars: fetchResult.contentChars || 0,
					snippet: fetchResult.snippet || "",
					error: fetchResult.error || "",
				},
			};

			return {
				ok: true,
				action,
				result: null,
				sources: [source],
				fetchResult: {
					id: source.id,
					url: normalizedUrl,
					finalUrl: fetchResult.finalUrl || normalizedUrl,
					title: fetchResult.title || "",
					content: fetchResult.content || "",
					contentChars: fetchResult.contentChars || 0,
					snippet: fetchResult.snippet || "",
					status: fetchResult.status || null,
					error: fetchResult.error || "",
					source: fetchResult.source || "http",
					duration: fetchResult.duration || 0,
				},
			};
		} catch (error) {
			return {
				ok: false,
				action,
				error: error.message,
				sources: [],
			};
		}
	}

	return {
		ok: false,
		action,
		error: `Unknown action type: ${action.type}`,
		sources: [],
	};
}

async function fetchSingleResearchSource(url, maxChars) {
	return await fetchSourceContentDirect(url, maxChars);
}

async function fetchSourceContentDirect(url, maxChars = 8000) {
	const start = Date.now();

	// GitHub URL — use API for rich content
	try {
		const { parseGitHubUrl, fetchGitHubContent } = await import(
			"../github.mjs"
		);
		const parsed = parseGitHubUrl(url);
		if (
			parsed &&
			(parsed.type === "root" ||
				parsed.type === "tree" ||
				(parsed.type === "blob" && !parsed.path?.includes(".")))
		) {
			const ghResult = await fetchGitHubContent(url);
			if (ghResult.ok) {
				const { trimContentHeadTail } = await import("../utils/content.mjs");
				const content = trimContentHeadTail(ghResult.content, maxChars);
				return {
					url,
					finalUrl: url,
					status: 200,
					title: ghResult.title,
					snippet: content.slice(0, 320),
					content,
					contentChars: content.length,
					source: "github-api",
					duration: Date.now() - start,
				};
			}
		}
	} catch {
		// Not a GitHub URL or API failed — fall through to HTTP
	}

	// Standard HTTP fetch
	try {
		const { fetchSourceHttp } = await import("../fetcher.mjs");
		const { trimContentHeadTail } = await import("../utils/content.mjs");
		const httpResult = await fetchSourceHttp(url, { timeoutMs: 10000 });
		if (httpResult.ok) {
			const content = trimContentHeadTail(httpResult.markdown, maxChars);
			return {
				url,
				finalUrl: httpResult.finalUrl,
				status: httpResult.status,
				title: httpResult.title,
				snippet: httpResult.excerpt,
				content,
				contentChars: content.length,
				source: "http",
				duration: Date.now() - start,
			};
		}
	} catch {
		// HTTP failed — return error
	}

	return {
		url,
		title: "",
		content: "",
		contentChars: 0,
		snippet: "",
		error: "HTTP fetch failed",
		source: "error",
		duration: Date.now() - start,
	};
}

function getDomainFromUrl(rawUrl) {
	try {
		const domain = new URL(rawUrl).hostname.toLowerCase();
		return domain.replace(/^www\./, "");
	} catch {
		return "";
	}
}

/**
 * Normalize a GitHub root/tree URL into specific fetchable pages.
 * Expands github.com/owner/repo into [README, CONTRIBUTING, CHANGELOG, key files].
 */
async function normalizeGitHubFetchActions(actions, usedUrls) {
	const normalized = [];
	const { parseGitHubUrl } = await import("../github.mjs");

	for (const action of actions) {
		if (action.type !== "fetchUrl") {
			normalized.push(action);
			continue;
		}

		const parsed = parseGitHubUrl(action.url);
		if (!parsed || parsed.type !== "root") {
			normalized.push(action);
			continue;
		}

		const { owner, repo } = parsed;
		const base = `https://github.com/${owner}/${repo}`;

		// Check if we already fetched the root
		if (usedUrls.has(base)) {
			continue;
		}

		// Expand into specific fetch targets (limit to avoid overwhelming)
		const targets = [
			base, // root (gets README + tree)
		];

		// Add docs/CONTRIBUTING/CHANGELOG if they exist in the tree
		const candidatePaths = [
			`${base}/blob/main/CONTRIBUTING.md`,
			`${base}/blob/master/CONTRIBUTING.md`,
			`${base}/blob/main/CHANGELOG.md`,
			`${base}/blob/master/CHANGELOG.md`,
			`${base}/blob/main/docs/README.md`,
		];

		// Only add a few supplemental targets to avoid excessive fetches
		for (const candidate of candidatePaths) {
			if (targets.length >= 3) break;
			if (!usedUrls.has(candidate)) {
				targets.push(candidate);
			}
		}

		for (const url of targets) {
			normalized.push({
				type: "fetchUrl",
				url,
				researchGoal:
					action.researchGoal || `Fetch GitHub content for ${owner}/${repo}`,
			});
		}
	}

	return normalized;
}

/**
 * Parse action plan from Gemini response into validated actions.
 */
export function parseActionPlan(rawJson, breadth) {
	const parsed = parseStructuredJson(rawJson?.answer || "") || {};
	const rawActions = Array.isArray(parsed?.actions) ? parsed.actions : [];
	const actions = [];

	for (const item of rawActions) {
		const action = validateAction(item);
		if (action && actions.length < breadth) {
			actions.push(action);
		}
	}

	return actions;
}

/**
 * Backward-compatible: convert old query-only plan to action list.
 */
export function queriesToActions(queries) {
	return (queries || [])
		.map((q) => ({
			type: "search",
			query: typeof q === "string" ? q : q.query,
			researchGoal: typeof q === "string" ? "" : q.researchGoal || "",
		}))
		.filter((a) => a.query);
}

function sourceKey(source) {
	return (
		normalizeUrl(
			source?.finalUrl || source?.canonicalUrl || source?.url || "",
		) ||
		source?.id ||
		""
	);
}

function buildEvidenceExtractionPrompt(
	originalQuery,
	questions,
	fetchedSources,
	alreadyExtracted = new Set(),
) {
	const openQuestions = (questions || [])
		.filter((q) => q.status !== "closed")
		.slice(0, 12)
		.map((q) => ({ id: q.id, question: q.question }));
	const sourceSnippets = (fetchedSources || [])
		.filter((source) => source?.content || source?.snippet)
		.filter((source) => !alreadyExtracted.has(sourceKey(source)))
		.slice(0, 6)
		.map((source, index) => ({
			id: source.id || `F${index + 1}`,
			title: source.title || "",
			url: source.finalUrl || source.url || source.canonicalUrl || "",
			content: trimText(source.content || source.snippet || "", 5000),
		}));

	return [
		"You are doing goal-based evidence extraction for an iterative research run.",
		"For each source, extract only information that helps answer the open questions.",
		"Use original wording/details where useful. Do not invent answers; leave questions open if evidence is insufficient.",
		"If a source answers one or more tracked questions, identify those question IDs explicitly.",
		"Also propose genuinely new sub-questions discovered from the evidence.",
		"",
		`Original research question: ${originalQuery}`,
		`Open question ledger: ${JSON.stringify(openQuestions, null, 2)}`,
		`Fetched sources: ${JSON.stringify(sourceSnippets, null, 2)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				extractions: [
					{
						sourceId: "S1",
						url: "https://example.com/source",
						rational: "why this source matters for the goal",
						evidence:
							"specific quoted/paraphrased evidence with numbers, dates, caveats",
						summary: "concise contribution to the research question",
						answers: [
							{
								id: "Q1",
								evidence: "brief evidence that closes the question",
							},
						],
						newQuestions: ["new sub-question raised by this source"],
					},
				],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

function normalizeEvidenceExtractions(payload, fetchedSources) {
	const raw = Array.isArray(payload?.extractions) ? payload.extractions : [];
	const byUrl = new Map();
	const byId = new Map();
	for (const source of fetchedSources || []) {
		if (source?.id) byId.set(String(source.id), source);
		const key = sourceKey(source);
		if (key) byUrl.set(key, source);
	}
	return raw
		.map((item) => {
			const source =
				byId.get(String(item?.sourceId || "")) ||
				byUrl.get(normalizeUrl(item?.url || "") || "");
			const sourceId = String(item?.sourceId || source?.id || "");
			const url = normalizeUrl(
				item?.url || source?.finalUrl || source?.url || "",
			);
			const answers = Array.isArray(item?.answers)
				? item.answers
						.map((answer) => ({
							id: String(answer?.id || ""),
							evidence: trimText(answer?.evidence || "", 500),
							sourceIds: [sourceId].filter(Boolean),
						}))
						.filter((answer) => answer.id)
				: [];
			return {
				sourceId,
				url,
				title: source?.title || item?.title || "",
				rational: trimText(item?.rational || "", 700),
				evidence: trimText(item?.evidence || "", 1600),
				summary: trimText(item?.summary || "", 700),
				answers,
				newQuestions: uniqueStrings(item?.newQuestions || [], 6),
			};
		})
		.filter(
			(item) => item.sourceId || item.url || item.summary || item.evidence,
		);
}

export async function extractEvidenceFromSources({
	query,
	questions,
	fetchedSources,
	extractedSourceKeys,
}) {
	const pending = (fetchedSources || []).filter(
		(source) =>
			(source?.content || source?.snippet) &&
			!extractedSourceKeys.has(sourceKey(source)),
	);
	if (pending.length === 0) return { evidence: [], error: "" };
	try {
		const raw = await runGeminiPrompt(
			buildEvidenceExtractionPrompt(
				query,
				questions,
				pending,
				extractedSourceKeys,
			),
			{ timeoutMs: 120000 },
		);
		const parsed = parseGeminiJson(raw, { extractions: [] });
		const evidence = normalizeEvidenceExtractions(parsed, pending);
		for (const source of pending) {
			const key = sourceKey(source);
			if (key) extractedSourceKeys.add(key);
		}
		return { evidence, error: "" };
	} catch (error) {
		return { evidence: [], error: error.message || String(error) };
	}
}

function buildLearningPrompt(
	originalQuery,
	roundQueries,
	searchSummaries,
	fetchedSources,
	questions = [],
	evidenceItems = [],
) {
	const sourceSnippets = fetchedSources
		.filter((source) => source?.content || source?.snippet)
		.slice(0, 10)
		.map((source, index) => ({
			id: `F${index + 1}`,
			title: source.title || "",
			url: source.finalUrl || source.url || "",
			snippet: trimText(source.content || source.snippet || "", 3000),
		}));

	return [
		"You are extracting compact research state from live multi-engine search results.",
		"Create dense, non-overlapping learnings with exact names, numbers, dates, limitations, and caveats where available.",
		"Also propose follow-up search queries that would most improve confidence or fill gaps.",
		"",
		`Original research question: ${originalQuery}`,
		`Round queries: ${JSON.stringify(roundQueries, null, 2)}`,
		`Question ledger: ${JSON.stringify(questions, null, 2)}`,
		`Extracted source evidence: ${JSON.stringify(evidenceItems.slice(-12), null, 2)}`,
		`Engine summaries: ${JSON.stringify(searchSummaries, null, 2)}`,
		`Fetched source snippets: ${JSON.stringify(sourceSnippets, null, 2)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				learnings: ["concise, information-dense learning"],
				answeredQuestions: [
					{
						id: "Q1",
						evidence: "brief evidence that closes this question",
						sourceIds: ["S1"],
					},
				],
				newQuestions: ["new sub-question discovered from the evidence"],
				followUpQueries: ["specific next search query"],
				gaps: ["important uncertainty or missing evidence"],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

export function buildFinalReportPrompt(
	originalQuery,
	rounds,
	sources,
	questions = [],
	evidenceItems = [],
) {
	const learnings = rounds.flatMap((round) => round.learnings || []);
	const gaps = rounds.flatMap((round) => round.gaps || []);
	const sourceRegistry = sources.slice(0, 12).map((source) => ({
		id: source.id,
		title: source.title,
		domain: source.domain,
		url: source.canonicalUrl,
		type: source.sourceType,
		engines: source.engines,
		fetch: source.fetch?.attempted
			? {
					ok: source.fetch.ok,
					snippet: trimText(source.fetch.snippet || "", 1200),
					publishedTime: source.fetch.publishedTime || "",
				}
			: undefined,
	}));

	return [
		"You are writing the final research report for an iterative deep-research run.",
		"Produce a thorough markdown report organized into clear sections.",
		"",
		"Use the learnings and source registry below. Every substantive claim MUST be backed by an [S1] citation.",
		'Where engines disagree, surface the conflicting claims explicitly in the "differences" array.',
		'Include a "Key Claims" structure that maps each distinct claim to its supporting source IDs.',
		"",
		"Report structure:",
		"1. ## Summary — A 2-4 sentence executive summary of findings",
		"2. ## Key Findings — The main findings, organized by theme or question, each with inline citations",
		"3. ## Areas of Disagreement — Where engines or sources conflict (if any)",
		"4. ## Limitations & Caveats — Important qualifiers, gaps, or uncertainties",
		"",
		`Original research question: ${originalQuery}`,
		`Learnings: ${JSON.stringify(learnings, null, 2)}`,
		`Known gaps/caveats: ${JSON.stringify(gaps, null, 2)}`,
		`Question ledger: ${JSON.stringify(questions, null, 2)}`,
		`Goal-based extracted evidence: ${JSON.stringify(evidenceItems.slice(-20), null, 2)}`,
		`Source registry: ${JSON.stringify(sourceRegistry, null, 2)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				answer: "markdown report with sections and inline [S1] citations",
				agreement: {
					level: "high|medium|low|mixed|conflicting",
					summary: "one-sentence confidence summary",
				},
				differences: ["notable disagreement or conflict between sources"],
				caveats: ["important caveat or qualification"],
				claims: [
					{
						claim: "specific factual statement from the research",
						support: "strong|moderate|weak|conflicting",
						sourceIds: ["S1", "S2"],
					},
				],
				recommendedSources: ["S1", "S2"],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

/**
 * Build a synthesis prompt that derives the final report directly from
 * previously extracted evidence (no per-round learnings required). This is
 * used as a fallback when the regular final-report path returns no
 * structured learnings (for example when Gemini's input field rejected the
 * per-round learning prompt but the goal-based extraction step succeeded).
 */
export function buildSynthesisFromEvidencePrompt(
	originalQuery,
	sources = [],
	questions = [],
	evidenceItems = [],
) {
	const sourceRegistry = sources.slice(0, 12).map((source) => ({
		id: source.id,
		title: source.title,
		domain: source.domain,
		url: source.canonicalUrl,
		type: source.sourceType,
		engines: source.engines,
	}));
	const evidenceSlice = evidenceItems.slice(-20);
	const answerableQuestionIds = new Set();
	for (const item of evidenceSlice) {
		for (const ans of item.answers || []) {
			if (ans?.id) answerableQuestionIds.add(ans.id);
		}
	}
	const openQuestionSummary = (questions || [])
		.filter((q) => q.status !== "closed")
		.map((q) => ({ id: q.id, question: q.question }));

	return [
		"You are writing the final research report from goal-based extracted evidence.",
		"Per-round learnings were not produced, but the per-source evidence extraction step succeeded.",
		"Synthesize a thorough markdown report using ONLY the evidence below. Every substantive claim MUST be backed by an [S1] citation.",
		"",
		"Report structure:",
		"1. ## Summary — A 2-4 sentence executive summary of findings",
		"2. ## Key Findings — The main findings, organized by theme or question, each with inline citations",
		"3. ## Limitations & Caveats — Important qualifiers, gaps, or uncertainties",
		"",
		`Original research question: ${originalQuery}`,
		`Per-source extracted evidence: ${JSON.stringify(evidenceSlice, null, 2)}`,
		`Source registry: ${JSON.stringify(sourceRegistry, null, 2)}`,
		`Questions already answered by the evidence: ${JSON.stringify(Array.from(answerableQuestionIds))}`,
		`Questions still open after this evidence: ${JSON.stringify(openQuestionSummary)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				answer: "markdown report with sections and inline [S1] citations",
				agreement: {
					level: "high|medium|low|mixed|conflicting",
					summary: "one-sentence confidence summary",
				},
				differences: ["notable disagreement or conflict between sources"],
				caveats: ["important caveat or qualification"],
				claims: [
					{
						claim: "specific factual statement supported by the evidence",
						support: "strong|moderate|weak|conflicting",
						sourceIds: ["S1", "S2"],
					},
				],
				recommendedSources: ["S1", "S2"],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

async function runFastAllSearch(query, { locale = null, short = true } = {}) {
	const args = [SEARCH_BIN, "all", "--inline", "--stdin", "--fast"];
	if (!short) args.push("--full");
	if (locale) args.push("--locale", locale);

	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, GREEDY_SEARCH_RESEARCH_CHILD: "1" },
		});
		proc.stdin.write(query);
		proc.stdin.end();

		let out = "";
		let err = "";
		let stderrBuffer = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => {
			err += d;
			stderrBuffer += d.toString();
			const lines = stderrBuffer.split("\n");
			stderrBuffer = lines.pop() || "";
			for (const line of lines) {
				if (shouldForwardChildStderr(line)) {
					process.stderr.write(`${line}\n`);
				}
			}
		});
		const t = setTimeout(() => {
			proc.kill();
			reject(new Error(`research child search timed out for: ${query}`));
		}, 140000);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0) {
				reject(
					new Error(err.trim() || `search child exited with code ${code}`),
				);
				return;
			}
			try {
				resolve(JSON.parse(out.trim()));
			} catch {
				reject(
					new Error(`Invalid JSON from research child: ${out.slice(0, 200)}`),
				);
			}
		});
	});
}

function dedupeSources(sourceLists) {
	const seen = new Map();
	for (const source of sourceLists.flat()) {
		const canonicalUrl = normalizeUrl(source.canonicalUrl || source.url);
		if (!canonicalUrl) continue;
		const existing = seen.get(canonicalUrl);
		if (!existing) {
			seen.set(canonicalUrl, { ...source, canonicalUrl });
			continue;
		}
		existing.engines = [
			...new Set([...(existing.engines || []), ...(source.engines || [])]),
		];
		existing.engineCount = existing.engines.length;
		existing.smartScore = Math.max(
			existing.smartScore || 0,
			source.smartScore || 0,
		);
	}

	return Array.from(seen.values())
		.sort((a, b) => {
			const diff = computeCompositeScore(b) - computeCompositeScore(a);
			if (diff !== 0) return diff;
			return (a.domain || "").localeCompare(b.domain || "");
		})
		.slice(0, 12)
		.map((source, index) => ({ ...source, id: `S${index + 1}` }));
}

function shouldForwardChildStderr(line) {
	return (
		/^PROGRESS:/.test(line) ||
		/^\[greedysearch\]/.test(line) ||
		/^\[(bing|perplexity|google|gemini|chatgpt|logically|semantic-scholar)\]/.test(
			line,
		) ||
		/^GreedySearch Chrome/.test(line) ||
		/^Launching GreedySearch Chrome/.test(line) ||
		/^Headless mode/.test(line) ||
		/^Ready\.?$/.test(line)
	);
}

function parseGeminiJson(raw, fallback = {}) {
	return parseStructuredJson(raw?.answer || "") || fallback;
}

/**
 * Audit citations in the final answer against known sources.
 * Extracts source IDs (e.g. "S1", "S2") from the answer text and verifies
 * each maps to a valid source with fetch data.
 */
export function auditCitations(answer, sources) {
	if (!answer || !Array.isArray(sources)) {
		return {
			cited: [],
			missing: [],
			unfetched: [],
			ok: true,
		};
	}

	// Extract source IDs: matches patterns like [S1], [S2], [S3, S4], (S1), S1,
	// and also F1, F2 (fetched source IDs)
	const idPattern = /\b[SF](\d+)\b/g;
	const citedIds = new Set();
	let match;
	while ((match = idPattern.exec(answer)) !== null) {
		citedIds.add(`S${match[1]}`);
		citedIds.add(`F${match[1]}`);
	}

	// Also check for "recommendedSources" or "sources" array in synthesis
	// Build lookup map
	const sourceMap = new Map();
	for (const source of sources) {
		const id = source?.id;
		if (id) {
			sourceMap.set(id, source);
		}
	}

	// Check each cited ID
	const cited = Array.from(citedIds);
	const missing = [];
	const unfetched = [];

	for (const id of cited) {
		const source = sourceMap.get(id);
		if (!source) {
			// Try matching by index: S1 -> sources[0]
			const indexMatch = id.match(/^(S|F)(\d+)$/);
			if (indexMatch) {
				const idx = parseInt(indexMatch[2], 10) - 1;
				if (idx >= 0 && idx < sources.length) {
					const matched = sources[idx];
					if (matched) {
						// Check if source was fetched successfully
						const fetchOk =
							matched.fetch?.ok ||
							(matched.content && matched.content.length > 100) ||
							(matched.contentChars && matched.contentChars > 100);
						if (!fetchOk) {
							unfetched.push(id);
						}
						continue;
					}
				}
			}
			missing.push(id);
		} else {
			// Source exists but check if it was fetched
			const fetchOk =
				source.fetch?.ok ||
				(source.content && source.content.length > 100) ||
				(source.contentChars && source.contentChars > 100);
			if (!fetchOk) {
				unfetched.push(id);
			}
		}
	}

	return {
		cited,
		missing,
		unfetched,
		ok: missing.length === 0,
	};
}

/**
 * Check reachability of cited source URLs via HEAD requests.
 * Returns { reachable, dead, skipped } with per-URL status.
 */
export async function checkCitationUrls(
	sources,
	{ timeoutMs = 6000, concurrency = 4 } = {},
) {
	const safeConcurrency = Math.max(1, Math.floor(concurrency || 1));
	const citedSources = (sources || []).filter(
		(s) => s?.id && (s?.canonicalUrl || s?.finalUrl || s?.url),
	);
	if (citedSources.length === 0) {
		return { reachable: [], dead: [], skipped: [], ok: true };
	}

	const reachable = [];
	const dead = [];
	const skipped = [];

	// Process in batches to avoid overwhelming
	for (let i = 0; i < citedSources.length; i += safeConcurrency) {
		const batch = citedSources.slice(i, i + safeConcurrency);
		const results = await Promise.allSettled(
			batch.map(async (source) => {
				const url =
					source.fetch?.finalUrl ||
					source.canonicalUrl ||
					source.finalUrl ||
					source.url;
				if (!url) return { id: source.id, url: "", status: "skipped" };

				// Skip non-HTTP URLs and known-unreachable patterns
				try {
					const parsed = new URL(url);
					if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
						return { id: source.id, url, status: "skipped" };
					}
				} catch {
					return { id: source.id, url, status: "skipped" };
				}

				try {
					const controller = new AbortController();
					const timer = setTimeout(() => controller.abort(), timeoutMs);
					try {
						const response = await fetch(url, {
							method: "HEAD",
							redirect: "follow",
							signal: controller.signal,
							headers: {
								"User-Agent":
									"Mozilla/5.0 (compatible; GreedySearch/2.0; +https://github.com/apmantza/greedysearch-pi)",
							},
						});
						clearTimeout(timer);
						const ok = response.status >= 200 && response.status < 400;
						const botProtectedOrHeadlessHost = [401, 403, 405, 429].includes(
							response.status,
						);
						let status = "dead";
						if (ok) status = "reachable";
						else if (botProtectedOrHeadlessHost) status = "skipped";
						return {
							id: source.id,
							url,
							status,
							httpStatus: response.status,
							reason: botProtectedOrHeadlessHost
								? "bot-protected-or-head-disallowed"
								: undefined,
						};
					} catch (fetchError) {
						clearTimeout(timer);
						return {
							id: source.id,
							url,
							status: "dead",
							error:
								fetchError.name === "AbortError"
									? "timeout"
									: fetchError.message,
						};
					}
				} catch (error) {
					return {
						id: source.id,
						url,
						status: "dead",
						error: error.message,
					};
				}
			}),
		);

		for (const result of results) {
			const value =
				result.status === "fulfilled"
					? result.value
					: {
							id: "?",
							url: "",
							status: "dead",
							error: result.reason?.message || "unknown",
						};
			if (value.status === "reachable") reachable.push(value);
			else if (value.status === "dead") dead.push(value);
			else skipped.push(value);
		}
	}

	return {
		reachable,
		dead,
		skipped,
		ok: dead.length === 0,
	};
}

/**
 * Shared orchestration: run citation URL check with logging.
 * Used by both runResearchMode() and runSimpleResearchMode() to avoid
 * duplicating the try/catch/logging block.
 */
export async function runCitationUrlCheck(
	combinedSources,
	citationAudit = null,
) {
	process.stderr.write("PROGRESS:research:check-urls\n");
	try {
		const citedIds = new Set(citationAudit?.cited || []);
		const sourcesToCheck = citedIds.size
			? (combinedSources || []).filter((source) => citedIds.has(source?.id))
			: combinedSources;
		const citationUrls = await checkCitationUrls(sourcesToCheck, {
			timeoutMs: 6000,
			concurrency: 4,
		});
		if (!citationUrls.ok) {
			process.stderr.write(
				`[greedysearch] ${citationUrls.dead.length} dead citation URL(s) detected\n`,
			);
		}
		return citationUrls;
	} catch (error) {
		process.stderr.write(
			`[greedysearch] URL reachability check failed: ${error.message}\n`,
		);
		return null;
	}
}

export function computeResearchFloor({
	sources = [],
	fetchedSources = [],
	synthesis = {},
	citationAudit = null,
	gaps = [],
	questions = [],
	rounds = [],
	qualityScore = 0,
	qualityThreshold = 8.5,
	maxSources = 8,
	requireCitations = true,
	requireQuestions = true,
} = {}) {
	const fetchedOk = fetchedSources.filter(
		(source) =>
			source?.fetch?.ok ||
			(source?.contentChars || 0) > 100 ||
			String(source?.content || "").length > 100,
	);
	const primarySources = sources.filter((source) =>
		["official-docs", "repo", "maintainer-blog", "academic"].includes(
			String(source?.sourceType || ""),
		),
	);
	const claims = Array.isArray(synthesis?.claims) ? synthesis.claims : [];
	const citedCount = citationAudit ? citationAudit.cited?.length || 0 : 0;
	const questionStats = questionProgress(questions);
	// Follow-up questions discovered during a run are useful handoff gaps, not a
	// reason to fail a short research run forever. The deterministic floor only
	// requires the original/root questions to close; newly-created questions stay
	// visible in STATUS.md and `gaps` for deeper follow-up rounds.
	const requiredQuestions = (questions || []).filter(
		(q) => !q.createdRound || q.reason === "Original research question",
	);
	const requiredQuestionStats = questionProgress(requiredQuestions);
	// Scale the minimum fetched sources by the number of rounds. The
	// simple research path runs 1 round with fewer sources, so requiring
	// 2-4 sources would be too strict. Iterative research (2+ rounds)
	// gets the full minFetched requirement.
	const roundCount = (rounds || []).length;
	const baseMin = Math.min(4, Math.max(2, Number(maxSources) || 8));
	const minFetched = roundCount <= 1 ? Math.min(2, baseMin) : baseMin;
	const checks = {
		roundsRun: rounds.length >= 1,
		fetchedSources: fetchedOk.length >= minFetched,
		primarySources: primarySources.length >= 1,
		qualityScore:
			qualityScore >= Math.min(qualityThreshold, 8) ||
			(requireCitations && claims.length > 0 && citedCount > 0),
		claimsExtracted: !requireCitations || claims.length > 0,
		citationsPresent: !requireCitations || citedCount > 0,
		citationsValid: !requireCitations || citationAudit?.ok === true,
		unfetchedCitations:
			!requireCitations || (citationAudit?.unfetched || []).length === 0,
		requiredQuestionsClosed:
			!requireQuestions || requiredQuestionStats.open === 0,
	};
	return {
		floorMet: Object.values(checks).every(Boolean),
		checks,
		metrics: {
			fetchedOk: fetchedOk.length,
			primarySources: primarySources.length,
			claims: claims.length,
			cited: citedCount,
			gaps: gaps.length,
			openQuestions: questionStats.open,
			closedQuestions: questionStats.closed,
			totalQuestions: questionStats.total,
			openRequiredQuestions: requiredQuestionStats.open,
			closedRequiredQuestions: requiredQuestionStats.closed,
			totalRequiredQuestions: requiredQuestionStats.total,
			qualityScore,
			minFetched,
		},
	};
}

function annotateFetchedSourcesWithIds(fetchedSources, sources) {
	const byUrl = new Map();
	for (const source of sources || []) {
		const key = normalizeUrl(
			source?.canonicalUrl || source?.finalUrl || source?.url,
		);
		if (key && source?.id) byUrl.set(key, source.id);
	}
	return (fetchedSources || []).map((source, index) => {
		const key = normalizeUrl(
			source?.finalUrl || source?.canonicalUrl || source?.url,
		);
		return {
			...source,
			id: source?.id || byUrl.get(key) || `F${index + 1}`,
		};
	});
}

export function createQuestionLedger(query) {
	return [
		{
			id: "Q1",
			question: trimText(sanitizeResearchQuery(query), 320),
			status: "open",
			reason: "Original research question",
			evidence: [],
			sourceIds: [],
		},
	];
}

function nextQuestionId(questions) {
	let max = 0;
	for (const q of questions || []) {
		const n = Number.parseInt(String(q.id || "").replace(/^Q/i, ""), 10);
		if (Number.isFinite(n)) max = Math.max(max, n);
	}
	return `Q${max + 1}`;
}

function findSimilarQuestion(questions, question) {
	const normalized = sanitizeResearchQuery(question).toLowerCase();
	return (questions || []).find(
		(q) =>
			q.question?.toLowerCase() === normalized ||
			jaccardSimilarity(q.question || "", normalized) >= 0.82,
	);
}

function addQuestion(questions, question, { reason = "", round = null } = {}) {
	const clean = trimText(sanitizeResearchQuery(question), 320);
	if (!clean) return null;
	const existing = findSimilarQuestion(questions, clean);
	if (existing) return existing;
	const item = {
		id: nextQuestionId(questions),
		question: clean,
		status: "open",
		reason: trimText(reason, 240),
		createdRound: round,
		evidence: [],
		sourceIds: [],
	};
	questions.push(item);
	return item;
}

function closeQuestion(
	questions,
	idOrQuestion,
	{ evidence = "", sourceIds = [], round = null } = {},
) {
	const target =
		questions.find((q) => q.id === idOrQuestion) ||
		findSimilarQuestion(questions, idOrQuestion);
	if (!target) return null;
	target.status = "closed";
	target.closedRound = target.closedRound || round;
	if (evidence)
		target.evidence = uniqueStrings([...(target.evidence || []), evidence], 4);
	if (Array.isArray(sourceIds)) {
		target.sourceIds = uniqueStrings(
			[...(target.sourceIds || []), ...sourceIds],
			8,
		);
	}
	return target;
}

function questionProgress(questions) {
	const total = questions.length;
	const closed = questions.filter((q) => q.status === "closed").length;
	return { total, closed, open: Math.max(0, total - closed) };
}

export function updateQuestionLedger(
	questions,
	{ roundNumber, actions = [], learningPayload = {} } = {},
) {
	for (const run of actions) {
		const action = run?.action || run;
		const goal =
			action?.researchGoal && action.researchGoal !== "Original user query"
				? action.researchGoal
				: action?.query || action?.url || "";
		if (goal) {
			addQuestion(questions, goal, {
				reason: "Planned research action",
				round: roundNumber,
			});
		}
	}

	// Cap the open-question ledger growth. Discovered gap/follow-up questions
	// are useful handoffs but Gemini tends to emit one per evidence slot, which
	// blows up the ledger and inflates the `requiredQuestionsClosed` floor
	// check. Keep at most MAX_OPEN_FOLLOWUPS of them across the whole run;
	// older ones are auto-resolved as "covered by later evidence" so they
	// don't block the floor forever.
	const MAX_OPEN_FOLLOWUPS = 5;
	const followupOpen = questions.filter(
		(q) => q.status === "open" && q.reason === "Discovered gap/follow-up",
	);
	if (followupOpen.length > MAX_OPEN_FOLLOWUPS) {
		const overflow = followupOpen
			.sort((a, b) => (a.createdRound || 0) - (b.createdRound || 0))
			.slice(0, followupOpen.length - MAX_OPEN_FOLLOWUPS);
		for (const q of overflow) {
			q.status = "resolved";
			q.closedRound = roundNumber;
			q.evidence = uniqueStrings(
				[...(q.evidence || []), "Auto-resolved to cap open-question ledger"],
				4,
			);
		}
	}

	const answered = Array.isArray(learningPayload.answeredQuestions)
		? learningPayload.answeredQuestions
		: [];
	for (const item of answered) {
		if (typeof item === "string") {
			closeQuestion(questions, item, { round: roundNumber });
			continue;
		}
		const id = item?.id || item?.question;
		if (!id && item?.question) {
			const added = addQuestion(questions, item.question, {
				reason: "Answered during learning extraction",
				round: roundNumber,
			});
			if (added) closeQuestion(questions, added.id, { round: roundNumber });
			continue;
		}
		closeQuestion(questions, id, {
			evidence: item?.evidence || item?.answer || "",
			sourceIds: Array.isArray(item?.sourceIds) ? item.sourceIds : [],
			round: roundNumber,
		});
	}

	// Keep STATUS.md as a true question ledger, not a dump of every search query
	// or caveat. Follow-up queries and raw gaps stay in their own fields; only
	// explicit newQuestions become open ledger items.
	const newQuestions = Array.isArray(learningPayload.newQuestions)
		? learningPayload.newQuestions
		: [];
	for (const question of newQuestions) {
		addQuestion(questions, question, {
			reason: "Discovered gap/follow-up",
			round: roundNumber,
		});
	}

	return questions;
}

/**
 * Pick direct-fetch targets from known academic source domains (arXiv,
 * semanticscholar.org, DOI redirect). Returns the canonical URL plus a
 * short label for the researchGoal. Filters out anything already fetched.
 */
function pickAcademicFetchTargets(combinedSources, usedUrls) {
	if (!Array.isArray(combinedSources) || combinedSources.length === 0)
		return [];
	const ACADEMIC_HOSTS = ["arxiv.org", "semanticscholar.org", "doi.org"];
	const seen = new Set();
	const targets = [];
	for (const source of combinedSources) {
		const url = source?.canonicalUrl || source?.finalUrl || source?.url || "";
		if (!url) continue;
		let domain = "";
		try {
			domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
		} catch {
			continue;
		}
		if (!ACADEMIC_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`))) {
			continue;
		}
		if (usedUrls.has(url) || seen.has(url)) continue;
		seen.add(url);
		// Prefer the HTML/abs page over PDF for direct fetch — the source
		// fetcher handles both, but the HTML page gives the synthesizer
		// readable text + abstract immediately.
		const htmlUrl = url.includes("/pdf/")
			? url.replace(/\/pdf\//, "/html/").replace(/\.pdf$/i, "")
			: url;
		targets.push({
			url: htmlUrl,
			label: source?.title || source?.id || domain,
		});
	}
	return targets.slice(0, 2);
}

export function reconcileQuestionsFromSynthesis(
	questions,
	synthesis,
	citationAudit,
) {
	if (!synthesis?.answer || citationAudit?.ok !== true) return questions;
	const claims = Array.isArray(synthesis.claims) ? synthesis.claims : [];
	const citedIds = Array.isArray(citationAudit.cited)
		? citationAudit.cited
		: [];
	if (claims.length === 0 || citedIds.length === 0) return questions;

	for (const question of questions) {
		if (question.status === "closed") continue;
		let bestClaim = null;
		let bestScore = 0;
		for (const claim of claims) {
			const score = jaccardSimilarity(
				question.question || "",
				claim.claim || "",
			);
			if (score > bestScore) {
				bestScore = score;
				bestClaim = claim;
			}
		}
		if (question.id === "Q1" || bestScore >= 0.18) {
			closeQuestion(questions, question.id, {
				evidence: bestClaim?.claim || "Answered in final cited synthesis",
				sourceIds: Array.isArray(bestClaim?.sourceIds)
					? bestClaim.sourceIds
					: citedIds.slice(0, 4),
			});
		}
	}
	return questions;
}

function renderQuestionStatus(questions) {
	if (!questions.length) return "No tracked questions.";
	return questions
		.map((q) => {
			const ids = q.sourceIds?.length ? ` (${q.sourceIds.join(", ")})` : "";
			return `- [${q.status === "closed" ? "x" : " "}] ${q.id}: ${q.question}${ids}`;
		})
		.join("\n");
}

function markdownList(items, fallback = "None recorded.") {
	const unique = uniqueStrings(items);
	return unique.length
		? unique.map((item) => `- ${item}`).join("\n")
		: fallback;
}

/**
 * Write a human-readable provenance sidecar next to the research bundle.
 * Records date, rounds, sources, verification status, and floor results.
 */
export function writeProvenanceSidecar(
	dir,
	{
		query,
		rounds,
		sources,
		fetchedSources,
		citationAudit,
		citationUrls,
		floor,
		manifest,
	},
) {
	const fetchedOk = (fetchedSources || []).filter(
		(s) => s?.contentChars > 100 || s?.fetch?.ok,
	);
	const primarySources = (sources || []).filter((s) =>
		["official-docs", "repo", "maintainer-blog", "academic"].includes(
			String(s?.sourceType || ""),
		),
	);
	const citedIds = new Set(citationAudit?.cited || []);
	const citedSources = (sources || []).filter((s) => citedIds.has(s?.id));

	const lines = [
		`# Provenance: ${query}`,
		"",
		`- **Date:** ${manifest?.startedAt || new Date().toISOString()}`,
		`- **Duration:** ${manifest?.durationMs ? `${(manifest.durationMs / 1000).toFixed(1)}s` : "unknown"}`,
		`- **Mode:** ${manifest?.terminationReason === "simple_single_pass" ? "simple (single-pass)" : "iterative"}`,
		`- **Rounds:** ${manifest?.rounds || rounds?.length || 1}`,
		"",
		"## Sources",
		"",
		`- **Consulted:** ${sources?.length || 0}`,
		`- **Fetched successfully:** ${fetchedOk.length}`,
		`- **Primary sources:** ${primarySources.length}`,
		`- **Cited in report:** ${citedSources.length}`,
		"",
	];

	// Cited source details
	if (citedSources.length > 0) {
		lines.push("### Cited sources", "");
		for (const source of citedSources) {
			const url = source.canonicalUrl || source.finalUrl || source.url || "";
			const fetched = source.fetch?.ok ? "✓" : "✗";
			lines.push(
				`- **${source.id}:** [${source.title || url}](${url}) (${source.sourceType || "unknown"}, fetched: ${fetched})`,
			);
		}
		lines.push("");
	}

	// URL reachability
	if (
		citationUrls &&
		(citationUrls.reachable.length > 0 || citationUrls.dead.length > 0)
	) {
		lines.push("## URL reachability", "");
		if (citationUrls.dead.length > 0) {
			lines.push("");
			lines.push("**Dead links:**");
			for (const d of citationUrls.dead) {
				lines.push(
					`- ${d.id}: ${d.url} (${d.httpStatus || d.error || "unknown"})`,
				);
			}
		}
		if (citationUrls.reachable.length > 0) {
			lines.push("");
			lines.push(
				`**Reachable:** ${citationUrls.reachable.length}/${citationUrls.reachable.length + citationUrls.dead.length}`,
			);
		}
		lines.push("");
	}

	// Verification status
	const verificationStatus = !citationAudit
		? "NOT CHECKED"
		: citationAudit.ok && (citationUrls?.ok ?? true)
			? "PASS"
			: citationAudit.ok === false
				? "FAIL (missing citations)"
				: "FAIL (dead links)";

	lines.push(
		"## Verification",
		"",
		`- **Citations:** ${citationAudit?.ok ? "PASS" : `FAIL — missing: ${(citationAudit?.missing || []).join(", ")}`}`,
		`- **URL reachability:** ${citationUrls ? (citationUrls.ok ? "PASS" : `FAIL — ${citationUrls.dead.length} dead`) : "SKIPPED"}`,
		`- **Floor:** ${floor?.floorMet ? "PASS" : "PARTIAL"}`,
		`- **Overall:** ${verificationStatus}`,
		"",
	);

	// Floor checks
	if (floor?.checks) {
		lines.push("## Floor checks", "");
		for (const [name, ok] of Object.entries(floor.checks)) {
			lines.push(`- [${ok ? "x" : " "}] ${name}`);
		}
		lines.push("");
	}

	writeFileSync(join(dir, "provenance.md"), lines.join("\n"), "utf8");
}

export async function writeResearchBundle({
	query,
	rounds,
	sources,
	fetchedSources,
	evidenceItems = [],
	synthesis,
	citationAudit,
	floor,
	manifest,
	allGaps = [],
	questions = [],
	citationUrls = null,
	outDir = null,
}) {
	const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-").slice(0, 19);
	const dir =
		outDir ||
		join(
			DEFAULT_RESEARCH_BUNDLE_ROOT,
			`${stamp}_${slugifyResearchName(query)}`,
		);
	const reportsDir = join(dir, "reports");
	const sourcesDir = join(dir, "sources");
	const dataDir = join(dir, "data");
	mkdirSync(reportsDir, { recursive: true });
	mkdirSync(sourcesDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });

	const sourceFiles = await writeResearchSourcesToFiles(
		fetchedSources,
		sourcesDir,
	);
	const gaps = uniqueStrings([
		...allGaps,
		...rounds.flatMap((round) => round.gaps || []),
	]);
	writeFileSync(
		join(dir, "STATUS.md"),
		[
			floor.floorMet ? "STATUS: DONE" : "STATUS: PARTIAL",
			"",
			`Query: ${query}`,
			`Stop reason: ${manifest.terminationReason || "max_rounds"}`,
			"",
			"## Deterministic floor checks",
			...Object.entries(floor.checks).map(
				([name, ok]) => `- [${ok ? "x" : " "}] ${name}`,
			),
			"",
			"## Questions",
			renderQuestionStatus(questions),
			"",
			"## Open gaps",
			markdownList(gaps),
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(dir, "OUTLINE.md"),
		[
			"# Research bundle outline",
			"",
			"- `reports/SUMMARY.md` — final cited report",
			"- `reports/CLAIMS.md` — extracted claims with support/source IDs",
			"- `reports/EVIDENCE.md` — goal-based source evidence",
			"- `reports/GAPS.md` — remaining caveats and uncertainties",
			"- `provenance.md` — human-readable run metadata and verification",
			"- `sources/` — fetched source markdown files",
			"- `data/manifest.json` — machine-readable run metadata",
			"- `data/rounds.json` — per-round actions/learnings/gaps",
			"- `data/sources.json` — ranked source registry",
			"- `data/questions.json` — open/closed question ledger",
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(reportsDir, "SUMMARY.md"),
		String(synthesis.answer || ""),
		"utf8",
	);
	writeFileSync(
		join(reportsDir, "CLAIMS.md"),
		[
			"# Key claims",
			"",
			...(Array.isArray(synthesis.claims) && synthesis.claims.length
				? synthesis.claims.map((claim) => {
						const ids = Array.isArray(claim.sourceIds)
							? claim.sourceIds.join(", ")
							: "";
						return `- ${claim.claim || ""} (${claim.support || "support unknown"}${ids ? `; ${ids}` : ""})`;
					})
				: ["No structured claims were extracted."]),
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(reportsDir, "EVIDENCE.md"),
		[
			"# Extracted evidence",
			"",
			...(evidenceItems.length
				? evidenceItems.map((item) =>
						[
							`## ${item.sourceId || item.url || "Source"}`,
							item.url ? `<${item.url}>` : "",
							item.rational ? `**Rational:** ${item.rational}` : "",
							item.evidence ? `**Evidence:** ${item.evidence}` : "",
							item.summary ? `**Summary:** ${item.summary}` : "",
							"",
						]
							.filter(Boolean)
							.join("\n"),
					)
				: ["No goal-based evidence was extracted."]),
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(reportsDir, "GAPS.md"),
		[
			"# Gaps and caveats",
			"",
			"## Caveats",
			markdownList(synthesis.caveats || []),
			"",
			"## Research gaps",
			markdownList(gaps),
			"",
		].join("\n"),
		"utf8",
	);
	writeFileSync(
		join(dataDir, "manifest.json"),
		JSON.stringify({ ...manifest, floor, citationAudit }, null, 2),
		"utf8",
	);
	writeFileSync(
		join(dataDir, "rounds.json"),
		JSON.stringify(rounds, null, 2),
		"utf8",
	);
	writeFileSync(
		join(dataDir, "sources.json"),
		JSON.stringify(sources, null, 2),
		"utf8",
	);
	writeFileSync(
		join(dataDir, "questions.json"),
		JSON.stringify(questions, null, 2),
		"utf8",
	);
	writeFileSync(
		join(dataDir, "evidence.json"),
		JSON.stringify(evidenceItems, null, 2),
		"utf8",
	);
	writeFileSync(
		join(sourcesDir, "index.md"),
		[
			"# Source index",
			"",
			...sourceFiles.map((source) => {
				const label = source.title || source.url;
				const url = source.finalUrl || source.url;
				const path = source.contentPath ? ` — ${source.contentPath}` : "";
				return `- ${source.id || "?"}: [${label}](${url})${path}`;
			}),
			"",
		].join("\n"),
		"utf8",
	);

	// Provenance sidecar — human-readable run metadata (non-critical)
	try {
		writeProvenanceSidecar(dir, {
			query,
			rounds,
			sources,
			fetchedSources,
			citationAudit,
			citationUrls,
			floor,
			manifest,
		});
	} catch (sidecarError) {
		process.stderr.write(
			`[greedysearch] Provenance sidecar write failed (non-critical): ${sidecarError.message}\n`,
		);
	}

	return {
		dir,
		statusPath: join(dir, "STATUS.md"),
		summaryPath: join(reportsDir, "SUMMARY.md"),
		manifestPath: join(dataDir, "manifest.json"),
		provenancePath: join(dir, "provenance.md"),
		sourceCount: sourceFiles.length,
		sourceFiles,
	};
}

export async function runResearchMode({
	query,
	breadth,
	iterations,
	maxSources,
	locale = null,
	short = false,
	qualityThreshold = 8.5,
	writeBundle = process.env.GREEDY_RESEARCH_BUNDLE !== "0",
	researchOutDir = null,
} = {}) {
	const options = clampResearchOptions({ breadth, iterations, maxSources });

	// ── Scale-aware fast path ────────────────────────────────────────────────
	// When breadth and iterations are at defaults (not user-specified), classify
	// the query complexity. Simple queries bypass the iterative loop entirely
	// for ~70% faster results and lower API cost.
	const userSpecifiedBreadth = breadth !== undefined && breadth !== null;
	const userSpecifiedIterations =
		iterations !== undefined && iterations !== null;
	const atDefaults = !userSpecifiedBreadth && !userSpecifiedIterations;

	if (atDefaults) {
		try {
			const classification = await classifyResearchComplexity(query);
			process.stderr.write(
				`[greedysearch] Complexity: ${classification.complexity} (${classification.reasoning})\n`,
			);
			if (classification.complexity === "simple") {
				process.stderr.write(
					`[greedysearch] Simple query detected — using fast single-pass path\n`,
				);
				return runSimpleResearchMode({
					query,
					locale,
					maxSources: Math.min(maxSources ?? 5, 5),
					qualityThreshold,
					writeBundle,
					researchOutDir,
				});
			}
			// For moderate/complex: use classifier suggestions as hints if user
			// didn't specify values. This tightens the loop for moderate queries
			// without changing the user-explicit path.
			if (!userSpecifiedBreadth) {
				options.breadth = classification.suggestedBreadth;
			}
			if (!userSpecifiedIterations) {
				options.iterations = classification.suggestedIterations;
			}
		} catch (error) {
			process.stderr.write(
				`[greedysearch] Scale classification failed, using defaults: ${error.message}\n`,
			);
		}
	}

	const rounds = [];
	let allLearnings = [];
	let allGaps = [];
	const questions = createQuestionLedger(query);
	let activeActions = null;
	let combinedSources = [];
	let fetchedSources = [];
	let evidenceItems = [];
	const extractedSourceKeys = new Set();
	const usedQueries = new Set();
	const usedUrls = new Set();
	const qualityHistory = [];
	let terminationReason = "max_rounds";

	// Manifest tracking
	const startedAt = new Date().toISOString();
	const startMs = Date.now();
	let totalActionsRun = 0;
	let totalSearches = 0;
	let totalFetches = 0;
	const engineFailures = [];

	// Progress bar with ETA — pre-compute totals from plan so the bar
	// reflects the full run, not just the current round. The actual
	// actions per round come from Gemini's plan; we estimate 1 fetch
	// per academic source found.
	const progressTracker = createProgressTracker({
		totalActions: options.iterations * options.breadth,
		totalRounds: options.iterations,
		totalFetches: options.iterations, // estimate: ~1 fetch per round
		silent: process.env.GREEDY_RESEARCH_QUIET === "1",
	});
	progressTracker.startRound(1);

	process.stderr.write(
		`[greedysearch] Research mode: breadth ${options.breadth}, iterations ${options.iterations}, qualityThreshold ${qualityThreshold}, engines ${RESEARCH_ENGINES.join(",")}, synthesizer gemini\n`,
	);

	for (let roundIndex = 0; roundIndex < options.iterations; roundIndex++) {
		const roundNumber = roundIndex + 1;
		const roundBreadth = Math.max(
			1,
			Math.ceil(options.breadth / 2 ** roundIndex),
		);
		process.stderr.write(`PROGRESS:research:round-${roundNumber}:planning\n`);

		if (!activeActions) {
			try {
				// Action-based planning: produces search + fetchUrl actions
				const rawPlan = await runGeminiPrompt(
					buildResearchActionPrompt(
						query,
						roundBreadth,
						allLearnings,
						allGaps,
						[...usedUrls],
					),
					{ timeoutMs: 120000 },
				);
				let planActions = parseActionPlan(rawPlan, roundBreadth);

				// On first round, ensure the original query is included
				if (roundIndex === 0) {
					planActions.unshift({
						type: "search",
						query,
						researchGoal: "Original user query",
					});
				}

				// Normalize GitHub root URLs into specific fetch targets
				planActions = await normalizeGitHubFetchActions(planActions, usedUrls);
				activeActions = planActions;
			} catch (error) {
				process.stderr.write(
					`[greedysearch] Action planning failed, using fallback queries: ${error.message}\n`,
				);
				// Fallback: use query-only planning
				const fallbackQueries = normalizeResearchQueries(
					null,
					query,
					roundBreadth,
					{
						includeOriginal: roundIndex === 0,
						exclude: usedQueries,
					},
				);
				activeActions = queriesToActions(fallbackQueries);
			}
		}

		// Novelty gate: reject exact and near-duplicate search actions
		const noveltyFiltered = (activeActions || []).filter((action) => {
			if (action.type === "search") {
				const pass = !isDuplicateQuery(action.query, usedQueries, {
					roundIndex,
					originalQuery: query,
				});
				if (!pass) {
					process.stderr.write(
						`[greedysearch] Novelty gate rejected search: ${action.query}\n`,
					);
				}
				return pass;
			}
			if (action.type === "fetchUrl") {
				const pass = !usedUrls.has(action.url);
				if (!pass) {
					process.stderr.write(
						`[greedysearch] Novelty gate rejected fetch: ${action.url}\n`,
					);
				}
				return pass;
			}
			return false;
		});

		const roundActions = noveltyFiltered.slice(0, roundBreadth);

		// Force at least one fetchUrl per round when a known academic source
		// (arXiv, semantic-scholar, DOI) is present in combinedSources. The
		// Gemini planner occasionally emits all-search actions even when the
		// answer is in a single arXiv PDF; direct fetching gives the synthesizer
		// real PDF text and reliably passes citation audits.
		const academicTargets = pickAcademicFetchTargets(combinedSources, usedUrls);
		const hasFetch = roundActions.some((a) => a.type === "fetchUrl");
		if (!hasFetch && academicTargets.length > 0) {
			const injectTarget = academicTargets[0];
			roundActions.push({
				type: "fetchUrl",
				url: injectTarget.url,
				researchGoal: `Direct fetch of known academic source: ${injectTarget.label || injectTarget.url}`,
			});
			process.stderr.write(
				`[greedysearch] Forced fetchUrl for academic source: ${injectTarget.url}\n`,
			);
		}

		const actionRuns = [];
		for (let i = 0; i < roundActions.length; i++) {
			const action = roundActions[i];
			process.stderr.write(
				`PROGRESS:research:round-${roundNumber}:action-${i + 1}/${roundActions.length}\n`,
			);
			process.stderr.write(
				`[greedysearch] Action ${i + 1}/${roundActions.length} [${action.type}]: ${(action.query || action.url).slice(0, 80)}\n`,
			);
			progressTracker.startAction(
				action.type,
				(action.query || action.url || "").slice(0, 60),
			);
			const run = await executeResearchAction(action, {
				locale,
				short,
				usedQueries,
				usedUrls,
				maxChars: 8000,
			});
			progressTracker.endAction();
			actionRuns.push(run);
			totalActionsRun++;
			if (action.type === "search") totalSearches++;
			if (action.type === "fetchUrl") {
				totalFetches++;
				progressTracker.endFetch(run.ok);
			}
			if (!run.ok) {
				engineFailures.push({
					round: roundNumber,
					type: action.type,
					target: action.query || action.url,
					error: run.error,
				});
				process.stderr.write(`[greedysearch] Action failed: ${run.error}\n`);
			}
		}

		// Collect sources from search actions
		const searchActionRuns = actionRuns.filter(
			(r) => r.action.type === "search",
		);
		const fetchActionRuns = actionRuns.filter(
			(r) => r.action.type === "fetchUrl",
		);
		updateQuestionLedger(questions, { roundNumber, actions: actionRuns });

		combinedSources = dedupeSources([
			combinedSources,
			searchActionRuns.flatMap((run) => run.sources || []),
			fetchActionRuns.flatMap((run) => run.sources || []),
		]);

		// Merge direct fetch results into fetchedSources
		for (const fetchRun of fetchActionRuns) {
			if (fetchRun.fetchResult) {
				fetchedSources.push(fetchRun.fetchResult);
			}
		}
		fetchedSources = dedupeFetchedSources(fetchedSources);

		// Fetch additional top-ranked sources from search results
		const remainingFetchBudget = Math.max(
			0,
			options.maxSources -
				fetchedSources.filter(
					(source) => source?.content || source?.contentChars > 100,
				).length,
		);
		if (remainingFetchBudget > 0 && combinedSources.length > 0) {
			process.stderr.write(`PROGRESS:research:round-${roundNumber}:fetching\n`);
			const fetchedUrlKeys = new Set();
			const safeNormalizeFetchUrl = (value) => {
				try {
					return normalizeUrl(value || "");
				} catch {
					return "";
				}
			};
			for (const source of fetchedSources) {
				for (const value of [
					source?.url,
					source?.finalUrl,
					source?.canonicalUrl,
				]) {
					const key = safeNormalizeFetchUrl(value);
					if (key) fetchedUrlKeys.add(key);
				}
			}
			const fetchCandidates = combinedSources.filter((source) => {
				const keys = [source?.canonicalUrl, source?.finalUrl, source?.url]
					.map((value) => safeNormalizeFetchUrl(value))
					.filter(Boolean);
				return keys.length > 0 && keys.every((key) => !fetchedUrlKeys.has(key));
			});
			const fetched = await fetchMultipleResearchSources(
				fetchCandidates,
				Math.min(remainingFetchBudget, fetchCandidates.length),
				8000,
				Math.min(3, remainingFetchBudget || 1),
			);
			fetchedSources = dedupeFetchedSources([...fetchedSources, ...fetched]);
			combinedSources = mergeFetchDataIntoSources(
				combinedSources,
				fetchedSources,
			);
		}
		fetchedSources = annotateFetchedSourcesWithIds(
			fetchedSources,
			combinedSources,
		);

		process.stderr.write(`PROGRESS:research:round-${roundNumber}:evidence\n`);
		const evidenceRun = await extractEvidenceFromSources({
			query,
			questions,
			fetchedSources,
			extractedSourceKeys,
		});
		if (evidenceRun.error) {
			process.stderr.write(
				`[greedysearch] Evidence extraction failed: ${evidenceRun.error}\n`,
			);
		}
		evidenceItems = [...evidenceItems, ...evidenceRun.evidence];
		for (const evidence of evidenceRun.evidence) {
			updateQuestionLedger(questions, {
				roundNumber,
				learningPayload: {
					answeredQuestions: evidence.answers || [],
					newQuestions: evidence.newQuestions || [],
				},
			});
		}

		// Build round query summary for learning extraction
		const roundQueries = actionRuns.map((run) => ({
			query: run.action.query || run.action.url || "",
			researchGoal: run.action.researchGoal || "",
		}));

		process.stderr.write(`PROGRESS:research:round-${roundNumber}:learning\n`);
		let learningPayload = { learnings: [], followUpQueries: [], gaps: [] };
		let learningError = "";
		try {
			const rawLearning = await runGeminiPrompt(
				buildLearningPrompt(
					query,
					roundQueries,
					searchActionRuns.map((run) => ({
						query: run.action.query,
						researchGoal: run.action.researchGoal,
						error: run.error || "",
						engines: summarizeEngineAnswers(run.result),
					})),
					fetchedSources,
					questions,
					evidenceItems,
				),
				{ timeoutMs: 120000 },
			);
			learningPayload = {
				...learningPayload,
				...parseGeminiJson(rawLearning, learningPayload),
			};
		} catch (error) {
			learningError = error.message;
			process.stderr.write(
				`[greedysearch] Learning extraction failed: ${error.message}\n`,
			);
		}

		const learnings = Array.isArray(learningPayload.learnings)
			? learningPayload.learnings
					.map((l) => String(l))
					.filter(Boolean)
					.slice(0, 8)
			: [];
		const gaps = Array.isArray(learningPayload.gaps)
			? learningPayload.gaps
					.map((g) => String(g))
					.filter(Boolean)
					.slice(0, 6)
			: [];
		allLearnings = uniqueStrings([...allLearnings, ...learnings]);
		allGaps = uniqueStrings([...allGaps, ...gaps]);
		updateQuestionLedger(questions, {
			roundNumber,
			actions: [],
			learningPayload,
			gaps,
		});
		rounds.push({
			round: roundNumber,
			actions: actionRuns.map((run) => ({
				type: run.action.type,
				query: run.action.query || "",
				url: run.action.url || "",
				researchGoal: run.action.researchGoal || "",
				error: run.error || "",
				sourceCount: run.sources?.length || 0,
			})),
			learnings,
			gaps,
			evidence: evidenceRun.evidence,
			evidenceError: evidenceRun.error,
			learningError,
		});

		// Quality evaluation
		process.stderr.write(`PROGRESS:research:round-${roundNumber}:evaluating\n`);
		progressTracker.endRound();
		if (roundNumber < options.iterations) {
			progressTracker.startRound(roundNumber + 1);
		}
		const evaluation = await evaluateResearchQuality(
			query,
			rounds,
			allLearnings,
			allGaps,
			qualityHistory,
		);
		qualityHistory.push(evaluation.score);
		allGaps = uniqueStrings([...allGaps, ...(evaluation.knowledgeGaps || [])]);
		updateQuestionLedger(questions, {
			roundNumber,
			gaps: evaluation.knowledgeGaps || [],
		});
		const preliminaryFloor = computeResearchFloor({
			sources: combinedSources,
			fetchedSources,
			gaps: allGaps,
			questions,
			rounds,
			qualityScore: evaluation.score,
			qualityThreshold,
			maxSources: options.maxSources,
			requireCitations: false,
			requireQuestions: false,
		});
		process.stderr.write(
			`[greedysearch] Quality score round ${roundNumber}: ${evaluation.score.toFixed(1)} (shouldContinue: ${evaluation.shouldContinue}, floor: ${preliminaryFloor.floorMet})\n`,
		);

		// Early termination is outcome-first: Gemini quality alone is not enough.
		// Stop early only when the score is high AND deterministic source/floor checks pass.
		if (
			evaluation.score >= qualityThreshold &&
			preliminaryFloor.floorMet &&
			(!evaluation.shouldContinue ||
				evaluation.terminationReason === "quality_threshold")
		) {
			terminationReason = evaluation.terminationReason || "quality_threshold";
			process.stderr.write(
				`[greedysearch] Research floor reached (score: ${evaluation.score.toFixed(1)}). Terminating early.\n`,
			);
			break;
		}

		const nextBreadth = Math.max(1, Math.ceil(roundBreadth / 2));

		// Convert learning follow-ups to search actions
		const followUpActions = (learningPayload.followUpQueries || [])
			.map((q) => ({
				type: "search",
				query: sanitizeResearchQuery(String(q)),
				researchGoal: "Follow-up from learning extraction",
			}))
			.filter((a) => a.query && a.query.toLowerCase() !== query.toLowerCase())
			.slice(0, nextBreadth);

		// Augment with evaluator's nextActions if follow-ups are insufficient
		let nextActiveActions = followUpActions;
		if (
			nextActiveActions.length < nextBreadth &&
			evaluation.nextActions.length > 0
		) {
			const evaluatorActions = evaluation.nextActions
				.map((a) => validateAction(a))
				.filter(Boolean);
			const merged = [...nextActiveActions, ...evaluatorActions];
			nextActiveActions = merged.slice(0, nextBreadth);
		}

		// Gap-driven fallback actions (search type)
		if (nextActiveActions.length < nextBreadth && allGaps.length > 0) {
			const fallbacks = buildFallbackQueriesFromGaps(
				allGaps,
				query,
				usedQueries,
				nextBreadth - nextActiveActions.length,
				roundIndex + 1,
			);
			const fallbackActions = fallbacks.map((f) => ({
				type: "search",
				query: f.query,
				researchGoal: f.researchGoal,
			}));
			nextActiveActions = [...nextActiveActions, ...fallbackActions].slice(
				0,
				nextBreadth,
			);
			if (fallbacks.length > 0) {
				process.stderr.write(
					`[greedysearch] Generated ${fallbacks.length} gap-driven fallback actions.\n`,
				);
			}
		}

		// If still insufficient, re-plan from accumulated learnings
		activeActions =
			nextActiveActions.length >= nextBreadth ? nextActiveActions : null;
	}

	process.stderr.write("PROGRESS:research:final-report\n");
	let synthesis = {
		answer: allLearnings.length
			? allLearnings.map((learning) => `- ${learning}`).join("\n")
			: "Research completed, but no structured learnings were extracted.",
		agreement: { level: "mixed", summary: "Research synthesis fallback." },
		differences: [],
		caveats: [],
		claims: [],
		recommendedSources: combinedSources.slice(0, 4).map((source) => source.id),
		synthesized: false,
	};
	try {
		const rawReport = await runGeminiPrompt(
			buildFinalReportPrompt(
				query,
				rounds,
				combinedSources,
				questions,
				evidenceItems,
			),
			{ timeoutMs: 180000 },
		);
		const parsed = parseGeminiJson(rawReport, {});
		const hasClaims = Array.isArray(parsed?.claims) && parsed.claims.length > 0;
		synthesis = {
			...synthesis,
			...parsed,
			rawAnswer: rawReport.answer || "",
			geminiSources: rawReport.sources || [],
			// Only mark as synthesized if Gemini actually returned structured
			// claims. An empty/minimal response should not block the evidence
			// fallback from running.
			synthesized: hasClaims,
		};
	} catch (error) {
		process.stderr.write(
			`[greedysearch] Final report failed: ${error.message}\n`,
		);
		synthesis.error = error.message;
	}

	// Fallback: when no structured learnings were produced but per-source
	// evidence was extracted successfully, ask Gemini to synthesize a final
	// report directly from the evidence. This rescues runs whose per-round
	// learning prompt failed (e.g. transient Gemini input field rejection)
	// but whose evidence extraction step still captured real data.
	const hasStructuredSynthesis =
		synthesis.synthesized === true &&
		Array.isArray(synthesis.claims) &&
		synthesis.claims.length > 0;
	if (!hasStructuredSynthesis && evidenceItems.length > 0) {
		process.stderr.write(
			"[greedysearch] Falling back to evidence-based synthesis (no per-round learnings).\n",
		);
		try {
			const evidencePrompt = buildSynthesisFromEvidencePrompt(
				query,
				combinedSources,
				questions,
				evidenceItems,
			);
			const rawEvidenceReport = await runGeminiPrompt(evidencePrompt, {
				timeoutMs: 180000,
			});
			const parsedEvidence = parseGeminiJson(rawEvidenceReport, {});
			synthesis = {
				...synthesis,
				...parsedEvidence,
				rawAnswer: rawEvidenceReport.answer || synthesis.answer || "",
				geminiSources:
					rawEvidenceReport.sources || synthesis.geminiSources || [],
				synthesized: true,
				synthesisMode: "evidence_fallback",
			};
		} catch (error) {
			process.stderr.write(
				`[greedysearch] Evidence-based synthesis failed: ${error.message}\n`,
			);
			synthesis.evidenceFallbackError = error.message;
		}
	}

	const finishedAt = new Date().toISOString();
	const durationMs = Date.now() - startMs;
	const qualityScore = qualityHistory.at(-1) || 0;
	fetchedSources = annotateFetchedSourcesWithIds(
		fetchedSources,
		combinedSources,
	);

	// Citation audit + final question reconciliation + deterministic completion floor
	process.stderr.write("PROGRESS:research:audit-citations\n");
	const citationAudit = auditCitations(synthesis.answer || "", combinedSources);

	// Citation URL reachability check
	const citationUrls = await runCitationUrlCheck(
		combinedSources,
		citationAudit,
	);

	reconcileQuestionsFromSynthesis(questions, synthesis, citationAudit);
	const floor = computeResearchFloor({
		sources: combinedSources,
		fetchedSources,
		synthesis,
		citationAudit,
		gaps: allGaps,
		questions,
		rounds,
		qualityScore,
		qualityThreshold,
		maxSources: options.maxSources,
	});
	if (floor.floorMet && terminationReason === "max_rounds") {
		terminationReason = "done_floor_met";
	} else if (!floor.floorMet && terminationReason === "quality_threshold") {
		terminationReason = "max_rounds_floor_unmet";
	}

	const manifest = {
		startedAt,
		finishedAt,
		durationMs,
		engines: RESEARCH_ENGINES,
		synthesizer: "gemini",
		rounds: rounds.length,
		actionsRun: totalActionsRun,
		searches: totalSearches,
		fetches: totalFetches,
		sourcesFetched: fetchedSources.filter((s) => s?.contentChars > 100).length,
		engineFailures,
		terminationReason,
		floorMet: floor.floorMet,
	};
	let bundle = null;
	let fetchedFiles;
	if (writeBundle) {
		process.stderr.write("PROGRESS:research:bundle\n");
		try {
			bundle = await writeResearchBundle({
				query,
				rounds,
				sources: combinedSources,
				fetchedSources,
				evidenceItems,
				synthesis,
				citationAudit,
				citationUrls,
				floor,
				manifest,
				allGaps,
				questions,
				outDir: researchOutDir,
			});
			fetchedFiles = bundle.sourceFiles;
			delete bundle.sourceFiles;
		} catch (error) {
			bundle = { error: error.message || String(error) };
			fetchedFiles = await writeResearchSourcesToFiles(fetchedSources);
		}
	} else {
		fetchedFiles = await writeResearchSourcesToFiles(fetchedSources);
	}

	process.stderr.write("PROGRESS:research:done\n");
	progressTracker.finish();

	return {
		query,
		_research: {
			mode: "iterative",
			breadth: options.breadth,
			iterations: options.iterations,
			maxSources: options.maxSources,
			rounds,
			learnings: allLearnings,
			gaps: allGaps,
			evidence: evidenceItems,
			questions,
			questionProgress: questionProgress(questions),
			qualityHistory,
			terminationReason,
			qualityThreshold,
			floor,
			bundle,
			manifest,
		},
		_citationAudit: citationAudit,
		_citationUrls: citationUrls,
		_sources: combinedSources,
		_fetchedSources: fetchedFiles,
		_synthesis: synthesis,
		_confidence: {
			sourcesCount: combinedSources.length,
			fetchedSourceSuccessRate:
				fetchedSources.length > 0
					? Number(
							(
								fetchedSources.filter((source) => source.contentChars > 100)
									.length / fetchedSources.length
							).toFixed(2),
						)
					: 0,
			agreementLevel: synthesis.agreement?.level || "mixed",
			floorMet: floor.floorMet,
		},
	};
}

function dedupeFetchedSources(sources) {
	const byUrl = new Map();
	for (const source of sources) {
		const key =
			source?.id || normalizeUrl(source?.finalUrl || source?.url || "");
		if (!key) continue;
		const existing = byUrl.get(key);
		if (
			!existing ||
			(source.contentChars || 0) > (existing.contentChars || 0)
		) {
			byUrl.set(key, source);
		}
	}

	const out = [];
	for (const source of byUrl.values()) {
		const content = String(source.content || source.snippet || "");
		const duplicateIndex = out.findIndex((existing) => {
			const other = String(existing.content || existing.snippet || "");
			if (content.length < 400 || other.length < 400) return false;
			return (
				jaccardSimilarity(content.slice(0, 4000), other.slice(0, 4000)) >= 0.9
			);
		});
		if (duplicateIndex === -1) {
			out.push(source);
			continue;
		}
		if ((source.contentChars || 0) > (out[duplicateIndex].contentChars || 0)) {
			out[duplicateIndex] = source;
		}
	}
	return out;
}

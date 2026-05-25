// src/search/research.mjs — Iterative deep-research orchestration
//
// Research mode borrows the small-loop architecture from open deep-research:
// plan focused queries, run broad search, extract compact learnings + follow-up
// directions, then produce a final report. It deliberately reuses GreedySearch's
// no-API browser engines and source fetchers instead of Firecrawl/OpenAI.

import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildSourceRegistry,
	computeCompositeScore,
	mergeFetchDataIntoSources,
	normalizeUrl,
	trimText,
} from "./sources.mjs";
import { parseStructuredJson } from "./synthesis.mjs";
import { runGeminiPrompt } from "./synthesis-runner.mjs";

const __dir = fileURLToPath(new URL(".", import.meta.url)).replace(
	/^\/([A-Z]:)/,
	"$1",
);
const SEARCH_BIN = join(__dir, "..", "..", "bin", "search.mjs");

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
				terminationReason:
					"quality_threshold" ||
					"max_rounds" ||
					"no_novel_actions" ||
					"insufficient_evidence",
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
		{ template: (g) => `${g} official documentation`, label: "official docs" },
		{
			template: (g) => `${g} GitHub issues discussions`,
			label: "community signals",
		},
		{
			template: (g) => `${g} benchmarks performance comparison`,
			label: "benchmarks",
		},
		{ template: (g) => `${g} limitations risks caveats`, label: "limitations" },
		{
			template: (g) => `${g} production deployment experience`,
			label: "production usage",
		},
		{
			template: (g) => `${originalQuery} ${g} counter evidence`,
			label: "counter-evidence",
		},
	];

	for (let i = 0; i < gaps.length && fallbacks.length < nextBreadth; i++) {
		const gap = gaps[i];
		const angle = angles[i % angles.length];
		const candidate = angle.template(originalQuery, gap);
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
	for (const engine of ["perplexity", "bing", "google"]) {
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
				sourceType: classifySourceTypeFromDomain(
					domain,
					fetchResult.title || "",
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

function classifySourceTypeFromDomain(domain, title = "") {
	const { matchesDomain, SOCIAL_HOSTS, COMMUNITY_HOSTS, NEWS_HOSTS } =
		require("./sources.mjs");
	const lowerTitle = title.toLowerCase();

	if (domain === "github.com" || domain === "gitlab.com") return "repo";
	if (matchesDomain(domain, SOCIAL_HOSTS)) return "social";
	if (matchesDomain(domain, COMMUNITY_HOSTS)) return "community";
	if (matchesDomain(domain, NEWS_HOSTS)) return "news";
	if (
		domain.startsWith("docs.") ||
		domain.startsWith("developer.") ||
		domain.startsWith("developers.") ||
		domain.startsWith("api.") ||
		lowerTitle.includes("documentation") ||
		lowerTitle.includes("docs") ||
		lowerTitle.includes("reference")
	) {
		return "official-docs";
	}
	if (domain.startsWith("blog.")) return "maintainer-blog";
	return "website";
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

function buildLearningPrompt(
	originalQuery,
	roundQueries,
	searchSummaries,
	fetchedSources,
) {
	const sourceSnippets = fetchedSources
		.filter((source) => source?.content || source?.snippet)
		.slice(0, 10)
		.map((source, index) => ({
			id: `F${index + 1}`,
			title: source.title || "",
			url: source.finalUrl || source.url || "",
			snippet: trimText(source.content || source.snippet || "", 1800),
		}));

	return [
		"You are extracting compact research state from live multi-engine search results.",
		"Create dense, non-overlapping learnings with exact names, numbers, dates, limitations, and caveats where available.",
		"Also propose follow-up search queries that would most improve confidence or fill gaps.",
		"",
		`Original research question: ${originalQuery}`,
		`Round queries: ${JSON.stringify(roundQueries, null, 2)}`,
		`Engine summaries: ${JSON.stringify(searchSummaries, null, 2)}`,
		`Fetched source snippets: ${JSON.stringify(sourceSnippets, null, 2)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				learnings: ["concise, information-dense learning"],
				followUpQueries: ["specific next search query"],
				gaps: ["important uncertainty or missing evidence"],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
}

function buildFinalReportPrompt(originalQuery, rounds, sources) {
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
					snippet: trimText(source.fetch.snippet || "", 700),
					publishedTime: source.fetch.publishedTime || "",
				}
			: undefined,
	}));

	return [
		"You are writing the final answer for an iterative deep-research run.",
		"Use the learnings and source registry below. Prefer concrete, sourced claims and call out uncertainty.",
		"Write a clear markdown report with: concise answer, key findings, evidence/citations using [S1] style IDs, caveats, and recommended next steps if useful.",
		"",
		`Original research question: ${originalQuery}`,
		`Learnings: ${JSON.stringify(learnings, null, 2)}`,
		`Known gaps/caveats: ${JSON.stringify(gaps, null, 2)}`,
		`Source registry: ${JSON.stringify(sourceRegistry, null, 2)}`,
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				answer: "markdown report with inline [S1] citations",
				agreement: {
					level: "high|medium|low|mixed|conflicting",
					summary: "one-sentence confidence summary",
				},
				caveats: ["important caveat"],
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
		/^\[(bing|perplexity|google|gemini)\]/.test(line) ||
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
	const idPattern = /\b[S F](\d+)\b/g;
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

export async function runResearchMode({
	query,
	breadth = 3,
	iterations = 2,
	maxSources,
	locale = null,
	short = true,
	qualityThreshold = 8.5,
} = {}) {
	const options = clampResearchOptions({ breadth, iterations, maxSources });
	const rounds = [];
	let allLearnings = [];
	let allGaps = [];
	let activeActions = null;
	let combinedSources = [];
	let fetchedSources = [];
	const usedQueries = new Set();
	const usedUrls = new Set();
	const qualityHistory = [];
	let terminationReason = "max_rounds";

	// Manifest tracking
	const startedAt = new Date().toISOString();
	const startMs = Date.now();
	const totalActionsRun = 0;
	const totalSearches = 0;
	const totalFetches = 0;
	const engineFailures = [];

	process.stderr.write(
		`[greedysearch] Research mode: breadth ${options.breadth}, iterations ${options.iterations}, qualityThreshold ${qualityThreshold}\n`,
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
		const actionRuns = [];
		for (let i = 0; i < roundActions.length; i++) {
			const action = roundActions[i];
			process.stderr.write(
				`PROGRESS:research:round-${roundNumber}:action-${i + 1}/${roundActions.length}\n`,
			);
			process.stderr.write(
				`[greedysearch] Action ${i + 1}/${roundActions.length} [${action.type}]: ${(action.query || action.url).slice(0, 80)}\n`,
			);
			const run = await executeResearchAction(action, {
				locale,
				short,
				usedQueries,
				usedUrls,
				maxChars: 8000,
			});
			actionRuns.push(run);
			totalActionsRun++;
			if (action.type === "search") totalSearches++;
			if (action.type === "fetchUrl") totalFetches++;
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
			const fetched = await fetchMultipleResearchSources(
				combinedSources,
				Math.min(remainingFetchBudget, combinedSources.length),
				8000,
				Math.min(3, remainingFetchBudget || 1),
			);
			fetchedSources = dedupeFetchedSources([...fetchedSources, ...fetched]);
			combinedSources = mergeFetchDataIntoSources(
				combinedSources,
				fetchedSources,
			);
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
		allLearnings = [...new Set([...allLearnings, ...learnings])];
		allGaps = [...new Set([...allGaps, ...gaps])];
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
			learningError,
		});

		// Quality evaluation
		process.stderr.write(`PROGRESS:research:round-${roundNumber}:evaluating\n`);
		const evaluation = await evaluateResearchQuality(
			query,
			rounds,
			allLearnings,
			allGaps,
			qualityHistory,
		);
		qualityHistory.push(evaluation.score);
		process.stderr.write(
			`[greedysearch] Quality score round ${roundNumber}: ${evaluation.score.toFixed(1)} (shouldContinue: ${evaluation.shouldContinue})\n`,
		);

		// Early termination
		if (
			evaluation.score >= qualityThreshold &&
			(!evaluation.shouldContinue ||
				evaluation.terminationReason === "quality_threshold")
		) {
			terminationReason = evaluation.terminationReason || "quality_threshold";
			process.stderr.write(
				`[greedysearch] Quality threshold ${qualityThreshold} reached (score: ${evaluation.score.toFixed(1)}). Terminating early.\n`,
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
		caveats: [],
		recommendedSources: combinedSources.slice(0, 4).map((source) => source.id),
		synthesized: false,
	};
	try {
		const rawReport = await runGeminiPrompt(
			buildFinalReportPrompt(query, rounds, combinedSources),
			{ timeoutMs: 180000 },
		);
		const parsed = parseGeminiJson(rawReport, {});
		synthesis = {
			...synthesis,
			...parsed,
			rawAnswer: rawReport.answer || "",
			geminiSources: rawReport.sources || [],
			synthesized: true,
		};
	} catch (error) {
		process.stderr.write(
			`[greedysearch] Final report failed: ${error.message}\n`,
		);
		synthesis.error = error.message;
	}

	const fetchedFiles = await writeResearchSourcesToFiles(fetchedSources);
	const finishedAt = new Date().toISOString();
	const durationMs = Date.now() - startMs;

	// Citation audit
	process.stderr.write("PROGRESS:research:audit-citations\n");
	const citationAudit = auditCitations(synthesis.answer || "", combinedSources);

	process.stderr.write("PROGRESS:research:done\n");

	return {
		query,
		_research: {
			mode: "iterative",
			breadth: options.breadth,
			iterations: options.iterations,
			maxSources: options.maxSources,
			rounds,
			learnings: allLearnings,
			qualityHistory,
			terminationReason,
			qualityThreshold,
			manifest: {
				startedAt,
				finishedAt,
				durationMs,
				rounds: rounds.length,
				actionsRun: totalActionsRun,
				searches: totalSearches,
				fetches: totalFetches,
				sourcesFetched: fetchedSources.filter((s) => s?.contentChars > 100)
					.length,
				engineFailures,
			},
		},
		_citationAudit: citationAudit,
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
		},
	};
}

function dedupeFetchedSources(sources) {
	const seen = new Map();
	for (const source of sources) {
		const key =
			source?.id || normalizeUrl(source?.finalUrl || source?.url || "");
		if (!key) continue;
		const existing = seen.get(key);
		if (
			!existing ||
			(source.contentChars || 0) > (existing.contentChars || 0)
		) {
			seen.set(key, source);
		}
	}
	return Array.from(seen.values());
}

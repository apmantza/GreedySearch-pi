#!/usr/bin/env node
// search.mjs — unified CLI for GreedySearch extractors
//
// Usage:
//   node search.mjs <engine> "<query>"
//   node search.mjs all "<query>"
//
// Engines:
//   perplexity | pplx | p
//   bing       | copilot | b
//   google     | g
//   gemini     | gem
//   all        — fan-out to all engines in parallel
//
// Output: JSON to stdout, errors to stderr
//
// Examples:
//   node search.mjs p "what is memoization"
//   node search.mjs gem "latest React features"
//   node search.mjs all "how does TCP congestion control work"

import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSourceHttp, shouldUseBrowser } from "./src/fetcher.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, "cdp.mjs");
const PAGES_CACHE = `${tmpdir().replace(/\\/g, "/")}/cdp-pages.json`;

const GREEDY_PORT = 9222;

const ENGINES = {
	perplexity: "perplexity.mjs",
	pplx: "perplexity.mjs",
	p: "perplexity.mjs",
	bing: "bing-copilot.mjs",
	copilot: "bing-copilot.mjs",
	b: "bing-copilot.mjs",
	google: "google-ai.mjs",
	g: "google-ai.mjs",
	gemini: "gemini.mjs",
	gem: "gemini.mjs",
};

const ALL_ENGINES = ["perplexity", "bing", "google"];

const ENGINE_DOMAINS = {
	perplexity: "perplexity.ai",
	bing: "copilot.microsoft.com",
	google: "google.com",
	gemini: "gemini.google.com",
};

const TRACKING_PARAMS = [
	"fbclid",
	"gclid",
	"ref",
	"ref_src",
	"ref_url",
	"source",
	"utm_campaign",
	"utm_content",
	"utm_medium",
	"utm_source",
	"utm_term",
];

const COMMUNITY_HOSTS = [
	"dev.to",
	"hashnode.com",
	"medium.com",
	"reddit.com",
	"stackoverflow.com",
	"stackexchange.com",
	"substack.com",
];

const NEWS_HOSTS = [
	"arstechnica.com",
	"techcrunch.com",
	"theverge.com",
	"venturebeat.com",
	"wired.com",
	"zdnet.com",
];

function trimText(text = "", maxChars = 240) {
	const clean = String(text).replace(/\s+/g, " ").trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, maxChars).replace(/\s+\S*$/, "")}...`;
}

function normalizeSourceTitle(title = "") {
	const clean = trimText(title, 180);
	if (!clean) return "";
	if (/^https?:\/\//i.test(clean)) return "";

	const wordCount = clean.split(/\s+/).filter(Boolean).length;
	const hasUppercase = /[A-Z]/.test(clean);
	const hasDigit = /\d/.test(clean);
	const looksLikeFragment =
		clean === clean.toLowerCase() &&
		wordCount <= 4 &&
		!hasUppercase &&
		!hasDigit;
	return looksLikeFragment ? "" : clean;
}

function pickPreferredTitle(currentTitle = "", nextTitle = "") {
	const current = normalizeSourceTitle(currentTitle);
	const next = normalizeSourceTitle(nextTitle);
	if (!next) return current;
	if (!current) return next;
	const currentLooksLikeUrl = /^https?:\/\//i.test(current);
	const nextLooksLikeUrl = /^https?:\/\//i.test(next);
	if (currentLooksLikeUrl && !nextLooksLikeUrl) return next;
	if (!currentLooksLikeUrl && nextLooksLikeUrl) return current;
	return next.length > current.length ? next : current;
}

function normalizeUrl(rawUrl) {
	if (!rawUrl) return null;
	try {
		const url = new URL(rawUrl);
		if (!["http:", "https:"].includes(url.protocol)) return null;
		url.hash = "";
		url.hostname = url.hostname.toLowerCase();
		if (
			(url.protocol === "https:" && url.port === "443") ||
			(url.protocol === "http:" && url.port === "80")
		) {
			url.port = "";
		}
		for (const key of [...url.searchParams.keys()]) {
			const lower = key.toLowerCase();
			if (TRACKING_PARAMS.includes(lower) || lower.startsWith("utm_")) {
				url.searchParams.delete(key);
			}
		}
		url.searchParams.sort();
		const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
		url.pathname = normalizedPath;
		const normalized = url.toString();
		return normalizedPath === "/" ? normalized.replace(/\/$/, "") : normalized;
	} catch {
		return null;
	}
}

function getDomain(rawUrl) {
	try {
		const domain = new URL(rawUrl).hostname.toLowerCase();
		return domain.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function matchesDomain(domain, hosts) {
	return hosts.some((host) => domain === host || domain.endsWith(`.${host}`));
}

function classifySourceType(domain, title = "", rawUrl = "") {
	const lowerTitle = title.toLowerCase();
	const lowerUrl = rawUrl.toLowerCase();

	if (domain === "github.com" || domain === "gitlab.com") return "repo";
	if (matchesDomain(domain, COMMUNITY_HOSTS)) return "community";
	if (matchesDomain(domain, NEWS_HOSTS)) return "news";
	if (
		domain.startsWith("docs.") ||
		domain.startsWith("developer.") ||
		domain.startsWith("developers.") ||
		domain.startsWith("api.") ||
		lowerTitle.includes("documentation") ||
		lowerTitle.includes("docs") ||
		lowerTitle.includes("reference") ||
		lowerUrl.includes("/docs/") ||
		lowerUrl.includes("/reference/") ||
		lowerUrl.includes("/api/")
	) {
		return "official-docs";
	}
	if (domain.startsWith("blog.") || lowerUrl.includes("/blog/"))
		return "maintainer-blog";
	return "website";
}

function sourceTypePriority(sourceType) {
	switch (sourceType) {
		case "official-docs":
			return 5;
		case "repo":
			return 4;
		case "maintainer-blog":
			return 3;
		case "website":
			return 2;
		case "community":
			return 1;
		case "news":
			return 0;
		default:
			return 0;
	}
}

function bestRank(source) {
	const ranks = Object.values(source.perEngine || {}).map((v) => v?.rank || 99);
	return ranks.length ? Math.min(...ranks) : 99;
}

function buildSourceRegistry(out) {
	const seen = new Map();
	const engineOrder = ["perplexity", "bing", "google"];

	for (const engine of engineOrder) {
		const result = out[engine];
		if (!result?.sources) continue;

		for (let i = 0; i < result.sources.length; i++) {
			const source = result.sources[i];
			const canonicalUrl = normalizeUrl(source.url);
			if (!canonicalUrl || canonicalUrl.length < 10) continue;

			const title = normalizeSourceTitle(source.title || "");
			const domain = getDomain(canonicalUrl);
			const sourceType = classifySourceType(domain, title, canonicalUrl);
			const existing = seen.get(canonicalUrl) || {
				id: "",
				canonicalUrl,
				displayUrl: source.url || canonicalUrl,
				domain,
				title: "",
				engines: [],
				engineCount: 0,
				perEngine: {},
				sourceType,
				isOfficial: sourceType === "official-docs",
			};

			existing.title = pickPreferredTitle(existing.title, title);
			existing.displayUrl = existing.displayUrl || source.url || canonicalUrl;
			existing.sourceType = existing.sourceType || sourceType;
			existing.isOfficial =
				existing.isOfficial || sourceType === "official-docs";

			if (!existing.engines.includes(engine)) {
				existing.engines.push(engine);
			}
			existing.perEngine[engine] = {
				rank: i + 1,
				title: pickPreferredTitle(
					existing.perEngine[engine]?.title || "",
					title,
				),
			};

			seen.set(canonicalUrl, existing);
		}
	}

	const sources = Array.from(seen.values())
		.map((source) => ({
			...source,
			engineCount: source.engines.length,
		}))
		.sort((a, b) => {
			if (b.engineCount !== a.engineCount) return b.engineCount - a.engineCount;
			if (
				sourceTypePriority(b.sourceType) !== sourceTypePriority(a.sourceType)
			) {
				return (
					sourceTypePriority(b.sourceType) - sourceTypePriority(a.sourceType)
				);
			}
			if (bestRank(a) !== bestRank(b)) return bestRank(a) - bestRank(b);
			return a.domain.localeCompare(b.domain);
		})
		.slice(0, 12)
		.map((source, index) => ({
			...source,
			id: `S${index + 1}`,
			title: source.title || source.domain || source.canonicalUrl,
		}));

	return sources;
}

function mergeFetchDataIntoSources(sources, fetchedSources) {
	const byId = new Map(fetchedSources.map((source) => [source.id, source]));
	return sources.map((source) => {
		const fetched = byId.get(source.id);
		if (!fetched) return source;

		const title = pickPreferredTitle(source.title, fetched.title || "");
		return {
			...source,
			title: title || source.title,
			fetch: {
				attempted: true,
				ok: !fetched.error,
				status: fetched.status || null,
				finalUrl: fetched.finalUrl || fetched.url || source.canonicalUrl,
				contentType: fetched.contentType || "",
				lastModified: fetched.lastModified || "",
				title: fetched.title || "",
				snippet: fetched.snippet || "",
				contentChars: fetched.contentChars || 0,
				error: fetched.error || "",
			},
		};
	});
}

function parseStructuredJson(text) {
	if (!text) return null;
	const trimmed = String(text).trim();
	const candidates = [
		trimmed,
		trimmed
			.replace(/^```json\s*/i, "")
			.replace(/^```\s*/i, "")
			.replace(/```$/i, "")
			.trim(),
	];

	const objectMatch = trimmed.match(/\{[\s\S]*\}/);
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

function normalizeSynthesisPayload(payload, sources, fallbackAnswer = "") {
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

	return {
		answer: trimText(payload?.answer || fallbackAnswer, 4000),
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

function buildSynthesisPrompt(
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
		fetch:
			grounded && source.fetch?.attempted
				? {
						ok: source.fetch.ok,
						status: source.fetch.status,
						lastModified: source.fetch.lastModified,
						snippet: trimText(source.fetch.snippet || "", 700),
					}
				: undefined,
	}));

	return [
		"You are synthesizing results from Perplexity, Bing Copilot, and Google AI.",
		grounded
			? "Use the fetched source snippets as the strongest evidence. Use engine answers for perspective and conflict detection."
			: "Use the engine answers for perspective. Use the source registry for provenance and citations.",
		"Prefer official docs, release notes, repositories, and maintainer-authored sources when available.",
		"If the engines disagree, say so explicitly.",
		"Do not invent sources. Only reference source IDs from the source registry.",
		"Return valid JSON only. No markdown fences, no prose outside the JSON object.",
		"",
		"JSON schema:",
		"{",
		'  "answer": "short direct answer",',
		'  "agreement": { "level": "high|medium|low|mixed|conflicting", "summary": "..." },',
		'  "differences": ["..."],',
		'  "caveats": ["..."],',
		'  "claims": [',
		'    { "claim": "...", "support": "strong|moderate|weak|conflicting", "sourceIds": ["S1"] }',
		"  ],",
		'  "recommendedSources": ["S1", "S2"]',
		"}",
		"",
		`User query: ${query}`,
		"",
		`Engine results:\n${JSON.stringify(engineSummaries, null, 2)}`,
		"",
		`Source registry:\n${JSON.stringify(sourceRegistry, null, 2)}`,
	].join("\n");
}

function buildConfidence(out) {
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

function getFullTabFromCache(engine) {
	try {
		if (!existsSync(PAGES_CACHE)) return null;
		const pages = JSON.parse(readFileSync(PAGES_CACHE, "utf8"));
		const found = pages.find((p) => p.url.includes(ENGINE_DOMAINS[engine]));
		return found ? found.targetId : null;
	} catch {
		return null;
	}
}

function cdp(args, timeoutMs = 15000) {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [CDP, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "",
			err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const t = setTimeout(() => {
			proc.kill();
			reject(new Error(`cdp timeout: ${args[0]}`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0) reject(new Error(err.trim() || `cdp exit ${code}`));
			else resolve(out.trim());
		});
	});
}

async function getAnyTab() {
	const list = await cdp(["list"]);
	const first = list.split("\n")[0];
	if (!first) throw new Error("No Chrome tabs found");
	return first.slice(0, 8);
}

async function _getOrReuseBlankTab() {
	// Reuse an existing about:blank tab rather than always creating a new one
	const listOut = await cdp(["list"]);
	const lines = listOut.split("\n").filter(Boolean);
	for (const line of lines) {
		if (line.includes("about:blank")) {
			return line.slice(0, 8); // prefix of the blank tab's targetId
		}
	}
	// No blank tab — open a new one
	const anchor = await getAnyTab();
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		'{"url":"about:blank"}',
	]);
	const { targetId } = JSON.parse(raw);
	return targetId;
}

async function openNewTab() {
	const anchor = await getAnyTab();
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		'{"url":"about:blank"}',
	]);
	const { targetId } = JSON.parse(raw);
	return targetId;
}

async function _getOrOpenEngineTab(engine) {
	await cdp(["list"]);
	return getFullTabFromCache(engine) || openNewTab();
}

async function activateTab(targetId) {
	try {
		const anchor = await getAnyTab();
		await cdp([
			"evalraw",
			anchor,
			"Target.activateTarget",
			JSON.stringify({ targetId }),
		]);
	} catch {
		// best-effort
	}
}

async function closeTabs(targetIds = []) {
	for (const targetId of targetIds) {
		if (!targetId) continue;
		await closeTab(targetId);
	}
	if (targetIds.length > 0) {
		await new Promise((r) => setTimeout(r, 300));
		await cdp(["list"]).catch(() => null);
	}
}

async function closeTab(targetId) {
	try {
		const anchor = await getAnyTab();
		await cdp([
			"evalraw",
			anchor,
			"Target.closeTarget",
			JSON.stringify({ targetId }),
		]);
	} catch {
		/* best-effort */
	}
}

function runExtractor(
	script,
	query,
	tabPrefix = null,
	short = false,
	timeoutMs = null, // null = auto-select based on engine
) {
	// Gemini is slower - use longer timeout
	if (timeoutMs === null) {
		timeoutMs = script.includes("gemini") ? 180000 : 90000;
	}
	const extraArgs = [
		...(tabPrefix ? ["--tab", tabPrefix] : []),
		...(short ? ["--short"] : []),
	];
	return new Promise((resolve, reject) => {
		const proc = spawn(
			"node",
			[join(__dir, "extractors", script), query, ...extraArgs],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, CDP_PROFILE_DIR: GREEDY_PROFILE_DIR },
			},
		);
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const t = setTimeout(() => {
			proc.kill();
			reject(new Error(`${script} timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0) reject(new Error(err.trim() || `extractor exit ${code}`));
			else {
				try {
					resolve(JSON.parse(out.trim()));
				} catch {
					reject(new Error(`bad JSON from ${script}: ${out.slice(0, 100)}`));
				}
			}
		});
	});
}

async function fetchTopSource(url) {
	const tab = await openNewTab();
	await cdp(["list"]); // refresh cache so the new tab is findable
	try {
		await cdp(["nav", tab, url], 30000);
		await new Promise((r) => setTimeout(r, 1500));
		const content = await cdp([
			"eval",
			tab,
			`
      (function(){
        var el = document.querySelector('article, [role="main"], main, .post-content, .article-body, #content, .content');
        var text = (el || document.body).innerText;
        return text.replace(/\\s+/g, ' ').trim();
      })()
    `,
		]);
		return { url, content };
	} catch (e) {
		return { url, content: null, error: e.message };
	} finally {
		await closeTab(tab);
	}
}

/**
 * Fetch source content via HTTP with Readability extraction.
 * Falls back to browser if HTTP fails or content quality is low.
 * @param {string} url - URL to fetch
 * @param {number} maxChars - Max characters to return
 * @returns {Promise<object>} Fetch result
 */
async function fetchSourceContent(url, maxChars = 8000) {
	const start = Date.now();

	// Try HTTP first
	const httpResult = await fetchSourceHttp(url, { timeoutMs: 15000 });

	if (httpResult.ok) {
		const content = httpResult.markdown.slice(0, maxChars);
		return {
			url,
			finalUrl: httpResult.finalUrl,
			status: httpResult.status,
			contentType: "text/markdown",
			lastModified: "",
			title: httpResult.title,
			snippet: httpResult.excerpt,
			content,
			contentChars: content.length,
			source: "http",
			duration: Date.now() - start,
		};
	}

	// HTTP failed or blocked - fall back to browser
	process.stderr.write(
		`[greedysearch] HTTP failed for ${url.slice(0, 60)}, trying browser...\n`,
	);
	return await fetchSourceContentBrowser(url, maxChars);
}

/**
 * Browser fallback for source fetching (original CDP-based method)
 */
async function fetchSourceContentBrowser(url, maxChars = 8000) {
	const start = Date.now();
	const tab = await openNewTab();

	try {
		await cdp(["nav", tab, url], 30000);
		await new Promise((r) => setTimeout(r, 1500));

		const content = await cdp([
			"eval",
			tab,
			`
			(function(){
				var el = document.querySelector('article, [role="main"], main, .post-content, .article-body, #content, .content');
				var text = (el || document.body).innerText;
				return JSON.stringify({
					title: document.title,
					content: text.replace(/\\s+/g, ' ').trim(),
					url: location.href
				});
			})()
		`,
		]);

		const parsed = JSON.parse(content);
		const finalContent = parsed.content.slice(0, maxChars);

		return {
			url,
			finalUrl: parsed.url || url,
			status: 200,
			contentType: "text/plain",
			lastModified: "",
			title: parsed.title,
			snippet: trimText(finalContent, 320),
			content: finalContent,
			contentChars: finalContent.length,
			source: "browser",
			duration: Date.now() - start,
		};
	} catch (error) {
		return {
			url,
			title: "",
			content: null,
			snippet: "",
			contentChars: 0,
			error: error.message,
			source: "browser",
			duration: Date.now() - start,
		};
	} finally {
		await closeTab(tab);
	}
}

async function fetchMultipleSources(sources, maxSources = 5, maxChars = 8000) {
	process.stderr.write(
		`[greedysearch] Fetching content from ${Math.min(sources.length, maxSources)} sources via HTTP (parallel)...\n`,
	);

	const toFetch = sources.slice(0, maxSources);

	// Fetch all sources in parallel via HTTP
	const fetchPromises = toFetch.map(async (s, index) => {
		const url = s.canonicalUrl || s.url;
		process.stderr.write(
			`[greedysearch] [${index + 1}/${toFetch.length}] Fetching: ${url.slice(0, 60)}...\n`,
		);

		const result = await fetchSourceContent(url, maxChars);

		if (result.content && result.content.length > 100) {
			process.stderr.write(
				`[greedysearch] ✓ ${result.source}: ${result.content.length} chars\n`,
			);
		} else if (result.error) {
			process.stderr.write(`[greedysearch] ✗ ${result.error.slice(0, 80)}\n`);
		}
		process.stderr.write(`PROGRESS:fetch:${index + 1}/${toFetch.length}\n`);

		return {
			id: s.id,
			...result,
		};
	});

	const fetched = await Promise.all(fetchPromises);

	// Log summary
	const successful = fetched.filter((f) => f.content && f.content.length > 100);
	const httpCount = fetched.filter((f) => f.source === "http").length;
	const browserCount = fetched.filter((f) => f.source === "browser").length;

	process.stderr.write(
		`[greedysearch] Fetched ${successful.length}/${fetched.length} sources ` +
			`(HTTP: ${httpCount}, Browser: ${browserCount})\n`,
	);

	return fetched;
}

function pickTopSource(out) {
	if (Array.isArray(out._sources) && out._sources.length > 0)
		return out._sources[0];
	for (const engine of ["perplexity", "google", "bing"]) {
		const r = out[engine];
		if (r?.sources?.length > 0) return r.sources[0];
	}
	return null;
}

async function synthesizeWithGemini(
	query,
	results,
	{ grounded = false, tabPrefix = null } = {},
) {
	const sources = Array.isArray(results._sources)
		? results._sources
		: buildSourceRegistry(results);
	const prompt = buildSynthesisPrompt(query, results, sources, { grounded });

	return new Promise((resolve, reject) => {
		const extraArgs = tabPrefix ? ["--tab", String(tabPrefix)] : [];
		const proc = spawn(
			"node",
			[join(__dir, "extractors", "gemini.mjs"), prompt, ...extraArgs],
			{
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, CDP_PROFILE_DIR: GREEDY_PROFILE_DIR },
			},
		);
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const t = setTimeout(() => {
			proc.kill();
			reject(new Error("Gemini synthesis timed out after 180s"));
		}, 180000);
		proc.on("close", (code) => {
			clearTimeout(t);
			if (code !== 0)
				reject(new Error(err.trim() || "gemini extractor failed"));
			else {
				try {
					const raw = JSON.parse(out.trim());
					const structured = parseStructuredJson(raw.answer || "");
					resolve({
						...normalizeSynthesisPayload(structured, sources, raw.answer || ""),
						rawAnswer: raw.answer || "",
						geminiSources: raw.sources || [],
					});
				} catch {
					reject(new Error(`bad JSON from gemini: ${out.slice(0, 100)}`));
				}
			}
		});
	});
}

function slugify(query) {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

function resultsDir() {
	const dir = join(__dir, "results");
	mkdirSync(dir, { recursive: true });
	return dir;
}

function writeOutput(
	data,
	outFile,
	{ inline = false, synthesize = false, query = "" } = {},
) {
	const json = `${JSON.stringify(data, null, 2)}\n`;

	if (outFile) {
		writeFileSync(outFile, json, "utf8");
		process.stderr.write(`Results written to ${outFile}\n`);
		return;
	}

	if (inline) {
		process.stdout.write(json);
		return;
	}

	const ts = new Date()
		.toISOString()
		.replace("T", "_")
		.replace(/[:.]/g, "-")
		.slice(0, 19);
	const slug = slugify(query);
	const base = join(resultsDir(), `${ts}_${slug}`);

	writeFileSync(`${base}.json`, json, "utf8");

	if (synthesize && data._synthesis?.answer) {
		writeFileSync(`${base}-synthesis.md`, data._synthesis.answer, "utf8");
		process.stdout.write(`${base}-synthesis.md\n`);
	} else {
		process.stdout.write(`${base}.json\n`);
	}
}

const GREEDY_PROFILE_DIR = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
const ACTIVE_PORT_FILE = `${GREEDY_PROFILE_DIR}/DevToolsActivePort`;

// Tell cdp.mjs to prefer the GreedySearch Chrome profile's DevToolsActivePort,
// so searches never accidentally attach to the user's main Chrome session.
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;

function probeGreedyChrome(timeoutMs = 3000) {
	return new Promise((resolve) => {
		const req = http.get(
			`http://localhost:${GREEDY_PORT}/json/version`,
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			},
		);
		req.on("error", () => resolve(false));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve(false);
		});
	});
}

// Write (or refresh) the DevToolsActivePort file for the GreedySearch Chrome so
// cdp.mjs always connects to the right port rather than the user's main Chrome.
// Uses atomic write (write to temp + rename) to prevent corruption from parallel processes.
async function refreshPortFile() {
	const LOCK_FILE = `${ACTIVE_PORT_FILE}.lock`;
	const TEMP_FILE = `${ACTIVE_PORT_FILE}.tmp`;

	// Simple file-based lock with timeout (prevents parallel writes from corrupting the port file)
	const lockAcquired = await new Promise((resolve) => {
		const start = Date.now();
		const tryLock = () => {
			try {
				writeFileSync(LOCK_FILE, `${process.pid}`, "utf8");
				resolve(true);
			} catch {
				// Lock file exists - check if stale (older than 5 seconds)
				try {
					const lockTime = parseInt(readFileSync(LOCK_FILE, "utf8"), 10);
					if (Date.now() - lockTime > 5000) {
						// Stale lock - overwrite
						writeFileSync(LOCK_FILE, `${process.pid}`, "utf8");
						resolve(true);
					} else if (Date.now() - start < 1000) {
						setTimeout(tryLock, 50);
					} else {
						resolve(false); // Give up after 1s
					}
				} catch {
					setTimeout(tryLock, 50);
				}
			}
		};
		tryLock();
	});

	try {
		const body = await new Promise((res, rej) => {
			const req = http.get(
				`http://localhost:${GREEDY_PORT}/json/version`,
				(r) => {
					let b = "";
					r.on("data", (d) => (b += d));
					r.on("end", () => res(b));
				},
			);
			req.on("error", rej);
			req.setTimeout(3000, () => {
				req.destroy();
				rej(new Error("timeout"));
			});
		});
		const { webSocketDebuggerUrl } = JSON.parse(body);
		const wsPath = new URL(webSocketDebuggerUrl).pathname;

		// Atomic write: write to temp file, then rename
		if (lockAcquired) {
			writeFileSync(TEMP_FILE, `${GREEDY_PORT}\n${wsPath}`, "utf8");
			try {
				unlinkSync(ACTIVE_PORT_FILE);
			} catch {}
			renameSync(TEMP_FILE, ACTIVE_PORT_FILE);
		}
	} catch {
		/* best-effort — launch.mjs already wrote the file on first start */
	} finally {
		if (lockAcquired) {
			try {
				unlinkSync(LOCK_FILE);
			} catch {}
		}
	}
}

async function ensureChrome() {
	const ready = await probeGreedyChrome();
	if (!ready) {
		process.stderr.write(
			`GreedySearch Chrome not running on port ${GREEDY_PORT} — auto-launching...\n`,
		);
		await new Promise((resolve, reject) => {
			const proc = spawn("node", [join(__dir, "launch.mjs")], {
				stdio: ["ignore", process.stderr, process.stderr],
			});
			proc.on("close", (code) =>
				code === 0 ? resolve() : reject(new Error("launch.mjs failed")),
			);
		});
	} else {
		// Chrome already running — refresh the port file so cdp.mjs always picks
		// up the right port, even if the file was stale from a previous session.
		await refreshPortFile();
	}
}

async function main() {
	const args = process.argv.slice(2);
	if (args.length < 2 || args[0] === "--help") {
		process.stderr.write(
			`${[
				'Usage: node search.mjs <engine> "<query>"',
				"",
				"Engines: perplexity (p), bing (b), google (g), gemini (gem), all",
				"",
				"Flags:",
				"  --fast              Quick mode: no source fetching or synthesis",
				"  --synthesize        Deprecated: synthesis is now default for multi-engine",
				"  --deep-research     Deprecated: source fetching is now default",
				"  --fetch-top-source  Fetch content from top source",
				"  --inline            Output JSON to stdout (for piping)",
				"",
				"Examples:",
				'  node search.mjs all "Node.js streams"           # Default: sources + synthesis',
				'  node search.mjs all "quick check" --fast        # Fast: no sources/synthesis',
				'  node search.mjs p "what is memoization"         # Single engine: fast mode',
			].join("\n")}\n`,
		);
		process.exit(1);
	}

	await ensureChrome();

	// Depth modes: fast (no synthesis/fetch), standard (synthesis+fetch 5 sources)
	const depthIdx = args.indexOf("--depth");
	let depth = "standard"; // DEFAULT: all "all" searches now include synthesis + source fetch

	if (depthIdx !== -1 && args[depthIdx + 1]) {
		depth = args[depthIdx + 1];
	} else if (args.includes("--fast")) {
		depth = "fast"; // Explicit fast mode requested
	}

	// For single engine (not "all"), default to fast unless explicit
	const engineArg = args.find((a) => !a.startsWith("--"))?.toLowerCase();
	if (engineArg !== "all" && depthIdx === -1 && !args.includes("--fast")) {
		// Single engine: default to fast for speed (no synthesis overhead)
		depth = "fast";
	}

	// --deep-research flag maps to standard (backward compat)
	if (args.includes("--deep-research")) {
		depth = "standard";
	}

	// For "all" engine with no explicit flags, standard is already default

	const full = args.includes("--full");
	const short = !full;
	const fetchSource = args.includes("--fetch-top-source");
	const inline = args.includes("--inline");
	const outIdx = args.indexOf("--out");
	const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
	const rest = args.filter(
		(a, i) =>
			a !== "--full" &&
			a !== "--short" &&
			a !== "--fast" &&
			a !== "--fetch-top-source" &&
			a !== "--synthesize" &&
			a !== "--deep-research" &&
			a !== "--inline" &&
			a !== "--depth" &&
			a !== "--out" &&
			(depthIdx === -1 || i !== depthIdx + 1) &&
			(outIdx === -1 || i !== outIdx + 1),
	);
	const engine = rest[0].toLowerCase();
	const query = rest.slice(1).join(" ");

	if (engine === "all") {
		await cdp(["list"]); // refresh pages cache

		// PARALLEL-SAFE: Always create fresh tabs for each engine to avoid race conditions
		// when multiple "all" searches run concurrently. Previously, reusing cached tabs
		// caused ERR_ABORTED and Uncaught errors as multiple processes fought over the same tab.
		const tabs = [];
		for (let i = 0; i < ALL_ENGINES.length; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, 300)); // small delay between tab opens
			const tab = await openNewTab();
			tabs.push(tab);
		}

		// All tabs assigned — run extractors in parallel
		try {
			const results = await Promise.allSettled(
				ALL_ENGINES.map((e, i) =>
					runExtractor(ENGINES[e], query, tabs[i], short)
						.then((r) => {
							process.stderr.write(`PROGRESS:${e}:done\n`);
							return { engine: e, ...r };
						})
						.catch((err) => {
							process.stderr.write(`PROGRESS:${e}:error\n`);
							throw err;
						}),
				),
			);

			const out = {};
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r.status === "fulfilled") {
					out[r.value.engine] = r.value;
				} else {
					out[ALL_ENGINES[i]] = { error: r.reason?.message || "unknown error" };
				}
			}

			await closeTabs(tabs);

			// Build a canonical source registry across all engines
			out._sources = buildSourceRegistry(out);

			// Source fetching: default for all "all" searches (was deep-research only)
			if (depth !== "fast" && out._sources.length > 0) {
				process.stderr.write("PROGRESS:source-fetch:start\n");
				const fetchedSources = await fetchMultipleSources(
					out._sources,
					5,
					8000,
				);

				out._sources = mergeFetchDataIntoSources(out._sources, fetchedSources);
				out._fetchedSources = fetchedSources;
				process.stderr.write("PROGRESS:source-fetch:done\n");
			}

			// Synthesize with Gemini for all non-fast modes (now default)
			if (depth !== "fast") {
				process.stderr.write("PROGRESS:synthesis:start\n");
				process.stderr.write(
					"[greedysearch] Synthesizing results with Gemini...\n",
				);
				try {
					// Create fresh Gemini tab per search (not cached) to avoid conflicts in parallel searches
					const geminiTab = await openNewTab();
					tabs.push(geminiTab); // ensure cleanup in finally block
					await activateTab(geminiTab);
					const synthesis = await synthesizeWithGemini(query, out, {
						grounded: depth === "deep",
						tabPrefix: geminiTab,
					});
					out._synthesis = {
						...synthesis,
						synthesized: true,
					};
					process.stderr.write("PROGRESS:synthesis:done\n");
				} catch (e) {
					process.stderr.write(
						`[greedysearch] Synthesis failed: ${e.message}\n`,
					);
					out._synthesis = { error: e.message, synthesized: false };
				}
			}

			if (fetchSource) {
				const top = pickTopSource(out);
				if (top)
					out._topSource = await fetchTopSource(top.canonicalUrl || top.url);
			}

			// Always include confidence metrics for non-fast searches
			if (depth !== "fast") out._confidence = buildConfidence(out);

			writeOutput(out, outFile, {
				inline,
				synthesize: depth !== "fast",
				query,
			});
			return;
		} finally {
			await closeTabs(tabs);
		}
	}

	const script = ENGINES[engine];
	if (!script) {
		process.stderr.write(
			`Unknown engine: "${engine}"\nAvailable: ${Object.keys(ENGINES).join(", ")}\n`,
		);
		process.exit(1);
	}

	try {
		const result = await runExtractor(script, query, null, short);
		if (fetchSource && result.sources?.length > 0) {
			result.topSource = await fetchTopSource(result.sources[0].url);
		}
		writeOutput(result, outFile, { inline, synthesize: false, query });
	} catch (e) {
		process.stderr.write(`Error: ${e.message}\n`);
		process.exit(1);
	}
}

main();

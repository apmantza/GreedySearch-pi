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

async function fetchSourceContent(url, maxChars = 5000) {
	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 15000);

		const res = await fetch(url, {
			signal: controller.signal,
			headers: {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
		});
		clearTimeout(timeout);

		if (!res.ok) throw new Error(`HTTP ${res.status}`);

		const html = await res.text();

		// Simple HTML extraction - remove tags and extract text
		const content = html
			.replace(/<script[\s\S]*?<\/script>/gi, "")
			.replace(/<style[\s\S]*?<\/style>/gi, "")
			.replace(/<nav[\s\S]*?<\/nav>/gi, "")
			.replace(/<header[\s\S]*?<\/header>/gi, "")
			.replace(/<footer[\s\S]*?<\/footer>/gi, "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&[a-z]+;/gi, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, maxChars);

		// Extract title
		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
		const title = titleMatch ? titleMatch[1].trim() : "";
		const finalUrl = res.url || url;
		const snippet = trimText(content, 320);

		return {
			url,
			finalUrl,
			status: res.status,
			contentType: res.headers.get("content-type") || "",
			lastModified: res.headers.get("last-modified") || "",
			title,
			snippet,
			content,
			contentChars: content.length,
		};
	} catch (e) {
		return {
			url,
			title: "",
			content: null,
			snippet: "",
			contentChars: 0,
			error: e.message,
		};
	}
}

async function fetchMultipleSources(sources, maxSources = 5, maxChars = 5000) {
	process.stderr.write(
		`[greedysearch] Fetching content from ${Math.min(sources.length, maxSources)} sources...\n`,
	);

	// Fetch sources sequentially (CDP doesn't handle parallel tab operations well)
	const toFetch = sources.slice(0, maxSources);
	const fetched = [];

	for (let i = 0; i < toFetch.length; i++) {
		const s = toFetch[i];
		process.stderr.write(
			`[greedysearch] Fetching ${i + 1}/${toFetch.length}: ${(s.canonicalUrl || s.url).slice(0, 60)}...\n`,
		);
		try {
			const result = await fetchSourceContent(
				s.canonicalUrl || s.url,
				maxChars,
			);
			fetched.push({ id: s.id, ...result });
			if (result.content && result.content.length > 100) {
				process.stderr.write(
					`[greedysearch] ✓ Got ${result.content.length} chars\n`,
				);
			} else {
				process.stderr.write(`[greedysearch] ✗ Empty or too short\n`);
			}
		} catch (e) {
			fetched.push({
				id: s.id,
				url: s.canonicalUrl || s.url,
				error: e.message,
			});
			process.stderr.write(
				`[greedysearch] ✗ Failed: ${e.message.slice(0, 80)}\n`,
			);
		}
		process.stderr.write(`PROGRESS:fetch:${i + 1}/${toFetch.length}\n`);
	}

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
				"  --full              Return complete answers (~3000+ chars)",
				"  --synthesize        Synthesize results via Gemini (adds ~30s)",
				"  --deep-research     Full research: full answers + source fetching + synthesis",
				"  --fetch-top-source  Fetch content from top source",
				"  --inline            Output JSON to stdout (for piping)",
				"",
				"Examples:",
				'  node search.mjs p "what is memoization"',
				'  node search.mjs all "TCP congestion control"',
				'  node search.mjs all "RAG vs fine-tuning" --deep-research',
			].join("\n")}\n`,
		);
		process.exit(1);
	}

	await ensureChrome();

	const full = args.includes("--full") || args.includes("--deep-research");
	const short = !full;
	const fetchSource = args.includes("--fetch-top-source");
	const synthesize =
		args.includes("--synthesize") || args.includes("--deep-research");
	const deepResearch = args.includes("--deep-research");
	const inline = args.includes("--inline");
	const outIdx = args.indexOf("--out");
	const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
	const rest = args.filter(
		(a, i) =>
			a !== "--full" &&
			a !== "--short" &&
			a !== "--fetch-top-source" &&
			a !== "--synthesize" &&
			a !== "--deep-research" &&
			a !== "--inline" &&
			a !== "--out" &&
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

			if (deepResearch) {
				process.stderr.write("PROGRESS:deep-research:start\n");
				const fetchedSources =
					out._sources.length > 0
						? await fetchMultipleSources(out._sources, 5, 8000)
						: [];

				out._sources = mergeFetchDataIntoSources(out._sources, fetchedSources);
				out._fetchedSources = fetchedSources;
				process.stderr.write(
					out._sources.length > 0
						? "PROGRESS:deep-research:done\n"
						: "PROGRESS:deep-research:no-sources\n",
				);
			}

			// Synthesize with Gemini if requested
			if (synthesize) {
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
						grounded: deepResearch,
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

			if (deepResearch) out._confidence = buildConfidence(out);

			writeOutput(out, outFile, { inline, synthesize, query });
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
		writeOutput(result, outFile, { inline, synthesize, query });
	} catch (e) {
		process.stderr.write(`Error: ${e.message}\n`);
		process.exit(1);
	}
}

main();

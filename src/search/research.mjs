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
	return String(query)
		.replace(/site:\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, "site:$1")
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, "$1")
		.replaceAll(/\s+/g, " ")
		.trim();
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

function buildResearchPlanningPrompt(query, breadth, learnings = []) {
	return [
		"You are planning web research for a multi-engine search agent.",
		"Generate focused, diverse SERP-style queries that will uncover primary sources, recent facts, and practical implementation details.",
		`Return at most ${breadth} queries. Include the user's original topic if it is already specific enough.`,
		"Avoid near-duplicates.",
		"",
		`User topic: ${query}`,
		learnings.length
			? `\nPrior learnings to build on:\n${learnings.map((l) => `- ${l}`).join("\n")}`
			: "",
		"",
		"Respond ONLY with JSON wrapped in BEGIN_JSON / END_JSON markers:",
		"BEGIN_JSON",
		JSON.stringify(
			{
				queries: [
					{
						query: "specific search query",
						researchGoal:
							"what this query should clarify and what follow-ups it may unlock",
					},
				],
			},
			null,
			2,
		),
		"END_JSON",
	].join("\n");
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

export async function runResearchMode({
	query,
	breadth = 3,
	iterations = 2,
	maxSources,
	locale = null,
	short = true,
} = {}) {
	const options = clampResearchOptions({ breadth, iterations, maxSources });
	const rounds = [];
	let allLearnings = [];
	let activeQueries = null;
	let combinedSources = [];
	let fetchedSources = [];
	const usedQueries = new Set();

	process.stderr.write(
		`[greedysearch] Research mode: breadth ${options.breadth}, iterations ${options.iterations}\n`,
	);

	for (let roundIndex = 0; roundIndex < options.iterations; roundIndex++) {
		const roundNumber = roundIndex + 1;
		const roundBreadth = Math.max(
			1,
			Math.ceil(options.breadth / 2 ** roundIndex),
		);
		process.stderr.write(`PROGRESS:research:round-${roundNumber}:planning\n`);

		if (!activeQueries) {
			try {
				const rawPlan = await runGeminiPrompt(
					buildResearchPlanningPrompt(query, roundBreadth, allLearnings),
					{ timeoutMs: 120000 },
				);
				activeQueries = normalizeResearchQueries(
					parseGeminiJson(rawPlan),
					query,
					roundBreadth,
					{
						includeOriginal: roundIndex === 0,
						exclude: usedQueries,
					},
				);
			} catch (error) {
				process.stderr.write(
					`[greedysearch] Research planning failed, using fallback queries: ${error.message}\n`,
				);
				activeQueries = normalizeResearchQueries(null, query, roundBreadth, {
					includeOriginal: roundIndex === 0,
					exclude: usedQueries,
				});
			}
		}

		const roundQueries = activeQueries.slice(0, roundBreadth);
		for (const planned of roundQueries) {
			usedQueries.add(sanitizeResearchQuery(planned.query).toLowerCase());
		}
		const searchRuns = [];
		for (let i = 0; i < roundQueries.length; i++) {
			const planned = roundQueries[i];
			process.stderr.write(
				`PROGRESS:research:round-${roundNumber}:query-${i + 1}/${roundQueries.length}\n`,
			);
			process.stderr.write(
				`[greedysearch] Research query ${i + 1}/${roundQueries.length}: ${planned.query}\n`,
			);
			try {
				const result = await runFastAllSearch(planned.query, { locale, short });
				const sources = buildSourceRegistry(result, planned.query);
				searchRuns.push({ ...planned, result, sources });
			} catch (error) {
				searchRuns.push({ ...planned, error: error.message, sources: [] });
				process.stderr.write(
					`[greedysearch] Research query failed: ${error.message}\n`,
				);
			}
		}

		combinedSources = dedupeSources([
			combinedSources,
			searchRuns.flatMap((run) => run.sources || []),
		]);

		const remainingFetchBudget = Math.max(
			0,
			options.maxSources -
				fetchedSources.filter((source) => source?.content).length,
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

		process.stderr.write(`PROGRESS:research:round-${roundNumber}:learning\n`);
		let learningPayload = { learnings: [], followUpQueries: [], gaps: [] };
		let learningError = "";
		try {
			const rawLearning = await runGeminiPrompt(
				buildLearningPrompt(
					query,
					roundQueries,
					searchRuns.map((run) => ({
						query: run.query,
						researchGoal: run.researchGoal,
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
		rounds.push({
			round: roundNumber,
			queries: roundQueries,
			learnings,
			gaps,
			learningError,
			searches: searchRuns.map((run) => ({
				query: run.query,
				researchGoal: run.researchGoal,
				error: run.error || "",
				sourceCount: run.sources?.length || 0,
			})),
		});

		const nextBreadth = Math.max(1, Math.ceil(roundBreadth / 2));
		const followUps = normalizeResearchQueries(
			{ queries: learningPayload.followUpQueries || [] },
			query,
			nextBreadth,
			{ expand: false },
		).filter((item) => item.query.toLowerCase() !== query.toLowerCase());
		// If Gemini only proposes one weak follow-up for a wider next round, re-plan
		// from accumulated learnings instead of shrinking the user's requested breadth.
		activeQueries = followUps.length >= nextBreadth ? followUps : null;
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
		},
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

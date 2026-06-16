// src/search/simple-research.mjs — Fast-path research for simple queries
//
// Runs a single all-engine search, fetches top sources, and produces a cited
// synthesis in one pass. Returns the same shape as runResearchMode() for
// compatibility with the rest of the pipeline.

import { ALL_ENGINES, RESEARCH_ENGINES } from "./constants.mjs";
import {
	buildSourceRegistry,
	mergeFetchDataIntoSources,
	trimText,
} from "./sources.mjs";
import {
	auditCitations,
	buildFinalReportPrompt,
	buildSynthesisFromEvidencePrompt,
	computeResearchFloor,
	createQuestionLedger,
	extractEvidenceFromSources,
	reconcileQuestionsFromSynthesis,
	runCitationUrlCheck,
	writeResearchBundle,
} from "./research.mjs";
import { parseStructuredJson } from "./synthesis.mjs";
import { writeSourcesToFiles } from "./file-sources.mjs";
import { fetchMultipleSources } from "./fetch-source.mjs";
import { runGeminiPrompt } from "./synthesis-runner.mjs";
import { createProgressTracker } from "./progress.mjs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = fileURLToPath(new URL(".", import.meta.url)).replace(
	/^\/([A-Z]:)/,
	"$1",
);
const SEARCH_BIN = join(__dir, "..", "..", "bin", "search.mjs");

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

// Build 3 distinct search angles for direct-mode research. Inspired by
// Feynman's deepresearch prompt: definition, mechanism, current usage.
export function buildSearchAngles(query) {
	const trimmed = String(query || "").trim();
	if (!trimmed) return [];
	return [
		`${trimmed} — definition and overview`,
		`${trimmed} — how it works, mechanism, or key details`,
		`${trimmed} — current usage, comparison, or best practices`,
	];
}

// Merge sources from multiple search angles, deduplicating by URL.
export function mergeSourcesByUrl(existing, incoming) {
	const urlMap = new Map();
	for (const s of existing || []) {
		const key = s?.canonicalUrl || s?.finalUrl || s?.url;
		if (key) urlMap.set(key, s);
	}
	for (const s of incoming || []) {
		const key = s?.canonicalUrl || s?.finalUrl || s?.url;
		if (!key) continue;
		if (urlMap.has(key)) {
			// Merge: keep existing but note the new angle
			const merged = {
				...urlMap.get(key),
				angles: [
					...(urlMap.get(key).angles || [urlMap.get(key).query || ""]),
					s.query || "",
				],
			};
			urlMap.set(key, merged);
		} else {
			urlMap.set(key, s);
		}
	}
	return Array.from(urlMap.values());
}

// Build engine-matching regex from ALL_ENGINES so new engines are auto-forwarded
const _enginePattern = ALL_ENGINES.join("|");
const _engineRegex = new RegExp(`^\\[(${_enginePattern})\\]`);

function shouldForwardChildStderr(line) {
	return (
		/^PROGRESS:/.test(line) ||
		/^\[greedysearch\]/.test(line) ||
		_engineRegex.test(line) ||
		/^GreedySearch Chrome/.test(line) ||
		/^Launching GreedySearch Chrome/.test(line) ||
		/^Headless mode/.test(line) ||
		/^Ready\.?$/.test(line)
	);
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

function annotateFetchedSourcesWithIds(fetchedSources, sources) {
	const byUrl = new Map();
	for (const source of sources || []) {
		const key = source?.canonicalUrl || source?.finalUrl || source?.url || "";
		if (key && source?.id) byUrl.set(key, source.id);
	}
	return (fetchedSources || []).map((source, index) => {
		const key = source?.finalUrl || source?.canonicalUrl || source?.url || "";
		return {
			...source,
			id: source?.id || byUrl.get(key) || `F${index + 1}`,
		};
	});
}

function questionProgress(questions) {
	const total = questions.length;
	const closed = questions.filter((q) => q.status === "closed").length;
	return { total, closed, open: Math.max(0, total - closed) };
}

/**
 * Fast-path research for simple queries. Runs a single all-engine search,
 * fetches top sources, and produces a cited synthesis in one pass.
 * Returns the same shape as runResearchMode() for compatibility.
 */
export async function runSimpleResearchMode({
	query,
	locale = null,
	maxSources = 5,
	qualityThreshold = 8.5,
	writeBundle = process.env.GREEDY_RESEARCH_BUNDLE !== "0",
	researchOutDir = null,
} = {}) {
	const startedAt = new Date().toISOString();
	const startMs = Date.now();
	const questions = createQuestionLedger(query);
	const extractedSourceKeys = new Set();

	process.stderr.write(
		`[greedysearch] Simple research mode: single-pass for "${trimText(query, 80)}"\n`,
	);

	// Progress bar with ETA — simple path does 3 search angles + 1 fetch
	// batch + 1-2 synthesis calls. Use a conservative total so the ETA
	// doesn't start at zero.
	const searchAnglesCount = 3;
	const totalSteps = searchAnglesCount + 1 + 2; // searches + fetch + 2 synth calls
	const progressTracker = createProgressTracker({
		totalActions: totalSteps,
		totalRounds: 1,
		totalFetches: 1,
		silent: process.env.GREEDY_RESEARCH_QUIET === "1",
	});
	progressTracker.startRound(1);

	// Step 1: Multi-angle search. Feynman's deepresearch pattern: for
	// direct-mode research, run a minimum of 3 distinct search angles
	// (definition, mechanism, current usage/comparison) to get broader
	// source coverage than a single query.
	let combinedSources = [];
	let fetchedSources = [];
	const searchAngles = buildSearchAngles(query);
	const searchResults = [];
	for (const angle of searchAngles) {
		try {
			progressTracker.startAction("search", angle.slice(0, 50));
			const result = await runFastAllSearch(angle, { locale, short: true });
			progressTracker.endAction();
			searchResults.push({ angle, result });
			const sources = buildSourceRegistry(result, angle);
			combinedSources = mergeSourcesByUrl(combinedSources, sources);
		} catch (error) {
			progressTracker.endAction();
			process.stderr.write(
				`[greedysearch] Simple search angle "${angle}" failed: ${error.message}\n`,
			);
		}
	}

	// Step 2: Fetch top sources
	process.stderr.write("PROGRESS:research:simple:fetching\n");
	if (combinedSources.length > 0) {
		try {
			progressTracker.startFetch(
				`top ${Math.min(maxSources, combinedSources.length)} sources`,
			);
			fetchedSources = await fetchMultipleSources(
				combinedSources,
				Math.min(maxSources, combinedSources.length),
				8000,
				Math.min(3, maxSources),
			);
			progressTracker.endFetch(true);
			combinedSources = mergeFetchDataIntoSources(
				combinedSources,
				fetchedSources,
			);
		} catch (error) {
			progressTracker.endFetch(false);
			process.stderr.write(
				`[greedysearch] Source fetching failed: ${error.message}\n`,
			);
		}
	}
	fetchedSources = annotateFetchedSourcesWithIds(
		fetchedSources,
		combinedSources,
	);

	// Step 3: Goal-based evidence extraction (single pass)
	process.stderr.write("PROGRESS:research:simple:evidence\n");
	let evidenceItems = [];
	try {
		const evidenceRun = await extractEvidenceFromSources({
			query,
			questions,
			fetchedSources,
			extractedSourceKeys,
		});
		evidenceItems = evidenceRun.evidence || [];
		for (const evidence of evidenceRun.evidence) {
			const answered = Array.isArray(evidence.answers) ? evidence.answers : [];
			for (const ans of answered) {
				const id = ans?.id || ans?.question;
				if (id) {
					const target = questions.find((q) => q.id === id);
					if (target) {
						target.status = "closed";
						target.closedRound = 1;
						if (ans.evidence)
							target.evidence = uniqueStrings(
								[...(target.evidence || []), ans.evidence],
								4,
							);
					}
				}
			}
			const newQs = Array.isArray(evidence.newQuestions)
				? evidence.newQuestions
				: [];
			for (const q of newQs) {
				const clean = trimText(String(q), 320);
				if (clean && !questions.some((x) => x.question === clean)) {
					questions.push({
						id: `Q${questions.length + 1}`,
						question: clean,
						status: "open",
						reason: "Discovered gap/follow-up",
						createdRound: 1,
						evidence: [],
						sourceIds: [],
					});
				}
			}
		}
	} catch (error) {
		process.stderr.write(
			`[greedysearch] Evidence extraction failed: ${error.message}\n`,
		);
	}

	// Step 4: Single-pass synthesis
	process.stderr.write("PROGRESS:research:simple:synthesizing\n");
	let synthesis = {
		answer: "",
		agreement: { level: "mixed", summary: "Single-pass synthesis." },
		differences: [],
		caveats: [],
		claims: [],
		recommendedSources: combinedSources.slice(0, 4).map((s) => s.id),
		synthesized: false,
	};

	if (evidenceItems.length > 0) {
		try {
			progressTracker.startAction("synth-evidence", "from evidence");
			const rawReport = await runGeminiPrompt(
				buildSynthesisFromEvidencePrompt(
					query,
					combinedSources,
					questions,
					evidenceItems,
				),
				{ timeoutMs: 120_000 },
			);
			progressTracker.endAction();
			synthesis = {
				...synthesis,
				...(parseStructuredJson(rawReport?.answer || "") || {}),
			};
			synthesis.synthesized =
				Array.isArray(synthesis.claims) && synthesis.claims.length > 0;
		} catch (error) {
			process.stderr.write(
				`[greedysearch] Evidence synthesis failed: ${error.message}\n`,
			);
		}
	}

	if (!synthesis.synthesized && combinedSources.length > 0) {
		try {
			progressTracker.startAction("synth-final", "fallback report");
			const rawReport = await runGeminiPrompt(
				buildFinalReportPrompt(
					query,
					[{ round: 1, learnings: [], gaps: [], actions: [] }],
					combinedSources,
					questions,
					evidenceItems,
				),
				{ timeoutMs: 120_000 },
			);
			progressTracker.endAction();
			synthesis = {
				...synthesis,
				...(parseStructuredJson(rawReport?.answer || "") || {}),
			};
			synthesis.synthesized =
				Array.isArray(synthesis.claims) && synthesis.claims.length > 0;
		} catch (error) {
			process.stderr.write(
				`[greedysearch] Final synthesis failed: ${error.message}\n`,
			);
		}
	}

	// Step 5: Citation audit + floor check
	process.stderr.write("PROGRESS:research:simple:audit\n");
	const citationAudit = auditCitations(synthesis.answer || "", combinedSources);

	// Citation URL reachability check
	const citationUrls = await runCitationUrlCheck(combinedSources);

	reconcileQuestionsFromSynthesis(questions, synthesis, citationAudit);
	const allGaps = uniqueStrings(synthesis.caveats || []);
	const floor = computeResearchFloor({
		sources: combinedSources,
		fetchedSources,
		synthesis,
		citationAudit,
		gaps: allGaps,
		questions,
		rounds: [{ round: 1, actions: [], learnings: [], gaps: allGaps }],
		qualityScore: synthesis.synthesized ? 8 : 5,
		qualityThreshold,
		maxSources,
	});

	const finishedAt = new Date().toISOString();
	const durationMs = Date.now() - startMs;

	// Shared manifest fields
	const baseManifest = {
		startedAt,
		finishedAt,
		durationMs,
		rounds: 1,
		terminationReason: "simple_single_pass",
	};

	// Step 6: Write bundle (lightweight)
	let bundle = null;
	let fetchedFiles;
	if (writeBundle) {
		process.stderr.write("PROGRESS:research:simple:bundle\n");
		try {
			bundle = await writeResearchBundle({
				query,
				rounds: [
					{
						round: 1,
						actions: [],
						learnings: [],
						gaps: allGaps,
						evidence: evidenceItems,
					},
				],
				sources: combinedSources,
				fetchedSources,
				evidenceItems,
				synthesis,
				citationAudit,
				citationUrls,
				floor,
				manifest: {
					...baseManifest,
					engines: RESEARCH_ENGINES,
					synthesizer: "gemini",
					actionsRun: 1,
					searches: 1,
					fetches: fetchedSources.length,
					sourcesFetched: fetchedSources.filter((s) => s?.contentChars > 100)
						.length,
					engineFailures: [],
					floorMet: floor.floorMet,
				},
				allGaps,
				questions,
				outDir: researchOutDir,
			});
			fetchedFiles = bundle.sourceFiles;
			delete bundle.sourceFiles;
		} catch (error) {
			process.stderr.write(
				`[greedysearch] Research bundle write failed: ${error.message}\n`,
			);
			bundle = { error: error.message || String(error) };
			fetchedFiles = await writeSourcesToFiles(fetchedSources);
		}
	} else {
		fetchedFiles = await writeSourcesToFiles(fetchedSources);
	}

	process.stderr.write("PROGRESS:research:done\n");
	progressTracker.endRound();
	progressTracker.finish();

	return {
		query,
		_research: {
			mode: "simple",
			breadth: 1,
			iterations: 1,
			maxSources,
			rounds: [
				{
					round: 1,
					actions: [],
					learnings: [],
					gaps: allGaps,
					evidence: evidenceItems,
				},
			],
			learnings: [],
			gaps: allGaps,
			evidence: evidenceItems,
			questions,
			questionProgress: questionProgress(questions),
			qualityHistory: [synthesis.synthesized ? 8 : 5],
			terminationReason: "simple_single_pass",
			qualityThreshold,
			floor,
			bundle,
			manifest: baseManifest,
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
					? fetchedSources.filter((source) => source.contentChars > 100)
							.length / fetchedSources.length
					: 0,
			agreementLevel: synthesis.agreement?.level || "mixed",
			floorMet: floor.floorMet,
		},
	};
}

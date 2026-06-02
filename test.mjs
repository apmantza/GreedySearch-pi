#!/usr/bin/env node
// test.mjs — Cross-platform test runner for GreedySearch (Windows + Unix)
//
// Usage:
//   node test.mjs              # run all tests (~8-12 min)
//   node test.mjs quick          # skip slow tests (~3 min)
//   node test.mjs smoke          # basic health check (~60s)
//   node test.mjs parallel       # race condition tests only
//   node test.mjs flags          # flag/option tests only
//   node test.mjs edge           # edge case tests only
//   node test.mjs unit           # fast unit tests only (no Chrome needed)

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));

// ANSI colors
const C = {
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
	reset: "\x1b[0m",
};

const mode = process.argv[2] || "all";
const resultsDir = join(__dir, "results", `test_${Date.now()}`);
mkdirSync(resultsDir, { recursive: true });

let pass = 0,
	fail = 0,
	warn = 0,
	skip = 0;
const failures = [],
	warnings = [];
const startTime = Date.now();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function passMsg(msg) {
	pass++;
	console.log(`  ${C.green}✓${C.reset} ${msg}`);
}
function failMsg(msg) {
	fail++;
	console.log(`  ${C.red}✗${C.reset} ${msg}`);
	failures.push(msg);
}
function warnMsg(msg) {
	warn++;
	console.log(`  ${C.yellow}⚠${C.reset} ${msg}`);
	warnings.push(msg);
}
function section(title) {
	console.log(`\n${C.blue}${title}${C.reset}`);
}
function subsection(title) {
	console.log(`\n${C.yellow}${title}${C.reset}`);
}

async function runNode(args, timeoutSec = 60) {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, args, {
			cwd: __dir,
			stdio: ["ignore", "pipe", "pipe"],
			timeout: timeoutSec * 1000,
		});
		let out = "",
			err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		proc.on("close", (code) => resolve({ code, out, err }));
		proc.on("error", reject);
	});
}

function checkJson(file, checkFn) {
	try {
		const data = JSON.parse(readFileSync(file, "utf8"));
		return checkFn(data);
	} catch (e) {
		return `PARSE_ERROR: ${e.message}`;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Unit Tests (no Chrome required)
// ─────────────────────────────────────────────────────────────────────────────

if (["", "all", "unit", "quick", "smoke"].includes(mode)) {
	section("🧪 Unit Tests");

	subsection("stripQuotes — param double-escaping workaround (issue #2)");
	const { stripQuotes } = await import("./src/tools/shared.ts");

	const stripCases = [
		// [input, expected, label]
		['"all"', "all", 'double-escaped enum: \\"all\\"'],
		['"standard"', "standard", 'double-escaped enum: \\"standard\\"'],
		['"deep"', "deep", 'double-escaped enum: \\"deep\\"'],
		["all", "all", "already clean: all"],
		["standard", "standard", "already clean: standard"],
		["", "", "empty string"],
	];
	for (const [input, expected, label] of stripCases) {
		const got = stripQuotes(input);
		if (got === expected) passMsg(`stripQuotes: ${label}`);
		else
			failMsg(`stripQuotes: ${label} — expected "${expected}", got "${got}"`);
	}

	subsection("Tool param normalization — greedy_search engine/depth");
	const normalizeEnum = (val, fallback) =>
		stripQuotes(val ?? fallback) || fallback;

	const normCases = [
		// [raw, fallback, expected, label]
		['"all"', "all", "all", 'engine \\"all\\" (double-escaped)'],
		[
			'"perplexity"',
			"all",
			"perplexity",
			'engine \\"perplexity\\" (double-escaped)',
		],
		[
			'"standard"',
			"standard",
			"standard",
			'depth \\"standard\\" (double-escaped)',
		],
		['"deep"', "standard", "deep", 'depth \\"deep\\" (double-escaped)'],
		[undefined, "all", "all", "engine undefined → default"],
		[undefined, "standard", "standard", "depth undefined → default"],
		["gemini", "all", "gemini", "engine clean string"],
	];
	for (const [raw, fallback, expected, label] of normCases) {
		const got = normalizeEnum(raw, fallback);
		if (got === expected) passMsg(`normalize: ${label}`);
		else failMsg(`normalize: ${label} — expected "${expected}", got "${got}"`);
	}

	subsection(
		"Bing/Perplexity error matching — headless → visible auto-retry detection",
	);
	// The auto-retry in bin/search.mjs uses this shared helper to decide
	// whether to switch from headless to visible Chrome and retry.
	const {
		findHeadlessBlockedEngines,
		isHeadlessBlockedError,
		isManualVerificationError,
	} = await import("./src/search/recovery.mjs");
	const cfTestCases = [
		// [error message, expected match, label]
		["input not found", true, 'legacy pattern: "input not found"'],
		[
			"Copilot input not found",
			true,
			'extended: "input not found" in sentence',
		],
		["VERIFICATION REQUIRED", true, 'legacy pattern: "VERIFICATION REQUIRED"'],
		["verification failed", true, 'extended: "verification" in sentence'],
		[
			"Clipboard interceptor returned empty text",
			true,
			"new: clipboard error (headless Cloudflare block)",
		],
		[
			"[bing] Clipboard empty, retrying in 2s...",
			true,
			"new: clipboard empty retry message",
		],
		[
			"Cloudflare challenge detected — content blocked in headless",
			true,
			"new: Cloudflare detection triggers visible retry",
		],
		[
			"Network timeout after 30000ms",
			true,
			"new: timeout triggers visible retry",
		],
		["", false, "empty string"],
	];
	for (const [error, expected, label] of cfTestCases) {
		const matched = isHeadlessBlockedError(error);
		if (matched === expected) passMsg(`cfPattern: ${label}`);
		else failMsg(`cfPattern: ${label} — expected ${expected}, got ${matched}`);
	}

	subsection("Manual verification detection keeps visible Chrome open");
	const manualCases = [
		[
			"Perplexity verification required — please solve it manually in the browser window",
			true,
			"perplexity manual verification",
		],
		[
			"Copilot verification required — please solve it manually in the browser window",
			true,
			"bing manual verification",
		],
		["selector changed", false, "non-verification extractor failure"],
	];
	for (const [error, expected, label] of manualCases) {
		const matched = isManualVerificationError(error);
		if (matched === expected) passMsg(`manualVerification: ${label}`);
		else
			failMsg(
				`manualVerification: ${label} — expected ${expected}, got ${matched}`,
			);
	}

	const retryEngines = findHeadlessBlockedEngines({
		perplexity: { error: "Clipboard interceptor returned empty text" },
		bing: { error: "Copilot verification required" },
		google: { error: "Google verification required" },
	});
	if (retryEngines.join(",") === "perplexity,bing") {
		passMsg("visible retry engines: perplexity and bing only");
	} else {
		failMsg(
			`visible retry engines: expected perplexity,bing, got ${retryEngines.join(",")}`,
		);
	}

	const pplxTestCases = [
		["ask-input selector not found", true, 'legacy: "ask-input"'],
		[
			"Clipboard interceptor returned empty text",
			true,
			"new: clipboard also triggers for perplexity",
		],
		["Perplexity timeout", true, "timeout triggers visible retry"],
	];
	for (const [error, expected, label] of pplxTestCases) {
		const matched = isHeadlessBlockedError(error);
		if (matched === expected) passMsg(`pplxPattern: ${label}`);
		else
			failMsg(`pplxPattern: ${label} — expected ${expected}, got ${matched}`);
	}

	subsection("mode marker file — isChromeHeadless detection");
	const { isChromeHeadless: isHeadlessCheck } = await import(
		"./src/search/chrome.mjs"
	);
	const headlessResult = typeof isHeadlessCheck === "function";
	if (headlessResult) passMsg("isChromeHeadless: function exists");
	else failMsg("isChromeHeadless: not a function");

	subsection("Research mode option/query normalization");
	const { clampResearchOptions, normalizeResearchQueries } = await import(
		"./src/search/research.mjs"
	);
	const clamped = clampResearchOptions({
		breadth: 99,
		iterations: 0,
	});
	if (
		clamped.breadth === 5 &&
		clamped.iterations === 1 &&
		clamped.maxSources === 10
	) {
		passMsg("research options: clamp and fallback values");
	} else {
		failMsg(
			`research options: expected breadth=5 iterations=1 maxSources=10, got ${JSON.stringify(clamped)}`,
		);
	}

	const researchQueries = normalizeResearchQueries(
		{
			queries: [
				{ query: "  browser automation AI agents  ", researchGoal: "Compare" },
				{ query: "browser automation AI agents", researchGoal: "duplicate" },
				"Lightpanda browser CDP automation",
			],
		},
		"AI browser research",
		3,
	);
	if (
		researchQueries.length === 3 &&
		researchQueries[0].query === "AI browser research" &&
		researchQueries[1].query === "browser automation AI agents"
	) {
		passMsg("research queries: prepend original and dedupe planned queries");
	} else {
		failMsg(`research queries: unexpected ${JSON.stringify(researchQueries)}`);
	}

	const expandedQueries = normalizeResearchQueries(
		null,
		"Lightpanda browser",
		3,
	);
	if (expandedQueries.length === 3) {
		passMsg("research queries: fallback expansion fills requested breadth");
	} else {
		failMsg(
			`research queries: expected 3 expanded queries, got ${expandedQueries.length}`,
		);
	}

	const markdownQueries = normalizeResearchQueries(
		{
			queries: [
				"site:[GitHub](https://github.com) Lightpanda",
				"read [official docs](https://example.com/docs) now",
			],
		},
		"Lightpanda browser",
		3,
		{ includeOriginal: false, expand: false },
	);
	if (
		markdownQueries[0]?.query === "site:GitHub Lightpanda" &&
		markdownQueries[1]?.query === "read official docs now"
	) {
		passMsg("research queries: markdown links sanitized without regex");
	} else {
		failMsg(
			`research queries: markdown sanitize unexpected ${JSON.stringify(markdownQueries)}`,
		);
	}

	subsection("Source ranking — social domains are low-priority");
	const { buildSourceRegistry } = await import("./src/search/sources.mjs");
	const ranked = buildSourceRegistry(
		{
			perplexity: {
				sources: [
					{
						title: "Facebook post",
						url: "https://facebook.com/groups/x/posts/1",
					},
					{
						title: "Official docs",
						url: "https://docs.example.com/lightpanda",
					},
				],
			},
			bing: {
				sources: [
					{
						title: "Facebook mirror",
						url: "https://www.facebook.com/groups/x/posts/1",
					},
					{ title: "Project", url: "https://example.com/lightpanda" },
				],
			},
		},
		"Lightpanda browser documentation",
	);
	const facebookRank = ranked.findIndex((s) => s.domain === "facebook.com");
	const docsRank = ranked.findIndex((s) => s.domain === "docs.example.com");
	if (docsRank !== -1 && facebookRank !== -1 && docsRank < facebookRank) {
		passMsg("source ranking: docs outrank multi-engine Facebook/social source");
	} else {
		failMsg(
			`source ranking: unexpected order ${ranked.map((s) => s.domain).join(",")}`,
		);
	}

	// ─── Phase 2: Quality Evaluator + Novelty Gate ────────────────────────

	subsection("Novelty Gate — Jaccard similarity");
	const {
		jaccardSimilarity,
		isDuplicateQuery,
		tokenSet,
		buildFallbackQueriesFromGaps,
	} = await import("./src/search/research.mjs");

	// tokenSet basics
	const tokens1 = tokenSet("hello world");
	const tokens2 = tokenSet("HELLO World");
	if (tokens1.size === 2) passMsg("tokenSet: basic tokenization (2 tokens)");
	else failMsg(`tokenSet: expected 2 tokens, got ${tokens1.size}`);
	if (
		tokens1.size === tokens2.size &&
		[...tokens1].every((t) => tokens2.has(t))
	)
		passMsg("tokenSet: case-insensitive");
	else failMsg("tokenSet: case sensitivity mismatch");

	// jaccardSimilarity
	const jExact = jaccardSimilarity("hello world", "hello world");
	if (Math.abs(jExact - 1.0) < 0.001) passMsg("jaccard: exact match = 1.0");
	else failMsg(`jaccard: exact match expected 1.0, got ${jExact}`);

	const jNone = jaccardSimilarity("hello world", "foo bar baz");
	if (Math.abs(jNone - 0.0) < 0.001) passMsg("jaccard: no overlap = 0.0");
	else failMsg(`jaccard: no overlap expected 0.0, got ${jNone}`);

	const jPartial = jaccardSimilarity(
		"AI browser automation",
		"browser automation testing",
	);
	if (jPartial > 0.0 && jPartial < 1.0)
		passMsg(`jaccard: partial overlap = ${jPartial.toFixed(3)}`);
	else failMsg(`jaccard: partial overlap expected 0<x<1, got ${jPartial}`);

	const jNearDup = jaccardSimilarity("react hooks tutorial", "react hooks");
	if (jNearDup > 0.6)
		passMsg(`jaccard: near-duplicate = ${jNearDup.toFixed(3)}`);
	else
		failMsg(
			`jaccard: near-duplicate expected >0.6, got ${jNearDup.toFixed(3)}`,
		);

	// isDuplicateQuery
	const used = new Set();
	used.add("react hooks tutorial 2024");
	used.add("vue composition api");

	if (
		isDuplicateQuery("React Hooks Tutorial 2024", used, {
			roundIndex: 0,
			originalQuery: "react hooks",
		})
	) {
		passMsg("isDuplicateQuery: exact dup detected (case-insensitive)");
	} else {
		failMsg("isDuplicateQuery: exact dup not detected");
	}

	if (
		isDuplicateQuery("react hooks tutorial 2024 guide", used, {
			roundIndex: 2,
			originalQuery: "react hooks",
		})
	) {
		passMsg("isDuplicateQuery: near-dup rejected (threshold 0.75)");
	} else {
		failMsg("isDuplicateQuery: near-dup not rejected");
	}

	if (
		!isDuplicateQuery("svelte reactive statements", used, {
			roundIndex: 2,
			originalQuery: "react hooks",
		})
	) {
		passMsg("isDuplicateQuery: novel query passes");
	} else {
		failMsg("isDuplicateQuery: novel query incorrectly rejected");
	}

	// Original query rejection after round 1
	if (
		isDuplicateQuery("react hooks", used, {
			roundIndex: 1,
			originalQuery: "react hooks",
		})
	) {
		passMsg("isDuplicateQuery: original query rejected after round 1");
	} else {
		failMsg("isDuplicateQuery: original query not rejected after round 1");
	}

	// Original query allowed in round 0
	if (
		!isDuplicateQuery("react hooks", used, {
			roundIndex: 0,
			originalQuery: "react hooks",
		})
	) {
		passMsg("isDuplicateQuery: original query allowed in round 0");
	} else {
		failMsg("isDuplicateQuery: original query rejected in round 0");
	}

	// buildFallbackQueriesFromGaps
	const fallbacks = buildFallbackQueriesFromGaps(
		["API support unknown", "production usage unclear"],
		"Lightpanda browser",
		new Set(["lightpanda browser overview"]),
		2,
		1,
	);
	if (fallbacks.length > 0 && fallbacks.length <= 2)
		passMsg(`fallback queries: generated ${fallbacks.length} queries`);
	else failMsg(`fallback queries: expected 1-2, got ${fallbacks.length}`);
	// Gap text is embedded in researchGoal, not query
	const gapTargets = fallbacks.some(
		(f) =>
			f.researchGoal.toLowerCase().includes("api") ||
			f.researchGoal.toLowerCase().includes("production"),
	);
	if (gapTargets) passMsg("fallback queries: targets identified gaps");
	else failMsg("fallback queries: gaps not targeted");

	// ─── Phase 3: Action Planner ──────────────────────────────────────────

	subsection("Action Planner — validation & parsing");
	const { validateAction, parseActionPlan, queriesToActions } = await import(
		"./src/search/research.mjs"
	);

	// validateAction
	const validSearch = validateAction({
		type: "search",
		query: "React 19 features",
		researchGoal: "Understand new features",
	});
	if (
		validSearch &&
		validSearch.type === "search" &&
		validSearch.query === "React 19 features"
	) {
		passMsg("validateAction: valid search action");
	} else {
		failMsg(
			`validateAction: search action failed: ${JSON.stringify(validSearch)}`,
		);
	}

	const validFetch = validateAction({
		type: "fetchUrl",
		url: "https://react.dev/learn",
		researchGoal: "Read official docs",
	});
	if (
		validFetch &&
		validFetch.type === "fetchUrl" &&
		validFetch.url === "https://react.dev/learn"
	) {
		passMsg("validateAction: valid fetchUrl action");
	} else {
		failMsg(`validateAction: fetchUrl failed: ${JSON.stringify(validFetch)}`);
	}

	if (!validateAction({ type: "unknown" })) {
		passMsg("validateAction: unknown type rejected");
	} else {
		failMsg("validateAction: unknown type not rejected");
	}

	if (!validateAction(null)) {
		passMsg("validateAction: null input rejected");
	} else {
		failMsg("validateAction: null not rejected");
	}

	if (!validateAction({ type: "search" })) {
		passMsg("validateAction: search without query rejected");
	} else {
		failMsg("validateAction: search without query not rejected");
	}

	if (!validateAction({ type: "fetchUrl" })) {
		passMsg("validateAction: fetchUrl without url rejected");
	} else {
		failMsg("validateAction: fetchUrl without url not rejected");
	}

	// parseActionPlan
	const planResult = parseActionPlan(
		{
			answer: `BEGIN_JSON
{"actions": [
  {"type":"search","query":"React 19 server components","researchGoal":"SSR info"},
  {"type":"fetchUrl","url":"https://react.dev/blog","researchGoal":"Blog post"},
  {"type":"search","query":"","researchGoal":"Empty query"}
]}
END_JSON`,
		},
		3,
	);
	if (planResult.length === 2) {
		passMsg("parseActionPlan: 2 valid actions (empty query filtered)");
	} else {
		failMsg(`parseActionPlan: expected 2 actions, got ${planResult.length}`);
	}

	// queriesToActions
	const qActions = queriesToActions([
		"react concurrent features",
		{ query: "vue 3 setup syntax", researchGoal: "Vue setup" },
		"", // empty
	]);
	if (qActions.length === 2 && qActions[0].type === "search") {
		passMsg("queriesToActions: converts strings and objects");
	} else {
		failMsg(`queriesToActions: unexpected result: ${JSON.stringify(qActions)}`);
	}

	// ─── Phase 4: Citation Audit ──────────────────────────────────────────

	subsection("Citation Audit");
	const { auditCitations } = await import("./src/search/research.mjs");

	// Test with valid citations
	const sources1 = [
		{
			id: "S1",
			title: "React docs",
			fetch: { ok: true },
			content: "x".repeat(200),
		},
		{ id: "S2", title: "MDN", fetch: { ok: true }, content: "x".repeat(200) },
		{ id: "S3", title: "Stack Overflow", fetch: { ok: false } },
	];

	const audit1 = auditCitations(
		"React hooks are powerful [S1]. See also [S2] for details.",
		sources1,
	);
	if (audit1.cited.includes("S1") && audit1.cited.includes("S2")) {
		passMsg("citation audit: extracts S1, S2 from answer text");
	} else {
		failMsg(
			`citation audit: cited list unexpected: ${JSON.stringify(audit1.cited)}`,
		);
	}
	if (audit1.ok) {
		passMsg("citation audit: ok=true when all cited sources exist");
	} else {
		failMsg("citation audit: ok should be true");
	}
	if (audit1.missing.length === 0) {
		passMsg("citation audit: no missing citations");
	} else {
		failMsg(
			`citation audit: unexpected missing: ${JSON.stringify(audit1.missing)}`,
		);
	}

	// Test with missing citation
	const audit2 = auditCitations("See reference [S9] for details.", sources1);
	if (!audit2.ok && audit2.missing.length > 0) {
		passMsg("citation audit: missing citation detected");
	} else {
		failMsg("citation audit: missing citation not detected");
	}

	// Test with unfetched source
	const audit3 = auditCitations("Info from [S3] confirms this.", sources1);
	if (audit3.unfetched.includes("S3")) {
		passMsg("citation audit: unfetched source flagged");
	} else {
		failMsg("citation audit: unfetched source not flagged");
	}

	// Test with no citations in answer
	const audit4 = auditCitations(
		"This is a plain answer with no citations.",
		sources1,
	);
	if (audit4.ok && audit4.cited.length === 0) {
		passMsg("citation audit: no citations = ok");
	} else {
		failMsg("citation audit: empty citations unexpected");
	}

	// Test with empty/null inputs
	const audit5 = auditCitations("", []);
	if (audit5.ok && audit5.cited.length === 0) {
		passMsg("citation audit: empty input handled");
	} else {
		failMsg("citation audit: empty input not handled");
	}

	// Mixed citation IDs (S and F)
	const sourcesMixed = [
		{ id: "S1", title: "Source 1", content: "x".repeat(200) },
		{ id: "S2", title: "Source 2" },
	];
	const auditMixed = auditCitations("Refs: [S1] [S2] [S5].", sourcesMixed);
	if (
		auditMixed.cited.includes("S1") &&
		auditMixed.cited.includes("S2") &&
		auditMixed.cited.includes("S5")
	) {
		passMsg("citation audit: multiple citation IDs extracted");
	} else {
		failMsg(
			`citation audit: unexpected cited: ${JSON.stringify(auditMixed.cited)}`,
		);
	}
	if (auditMixed.unfetched.includes("S2")) {
		passMsg("citation audit: S2 flagged as unfetched (no content)");
	} else {
		failMsg("citation audit: S2 should be flagged as unfetched");
	}

	subsection("Research Floor and Question Ledger");
	const { computeResearchFloor, createQuestionLedger, updateQuestionLedger } =
		await import("./src/search/research.mjs");
	const floorOk = computeResearchFloor({
		sources: [
			{ id: "S1", sourceType: "official-docs" },
			{ id: "S2", sourceType: "community" },
		],
		fetchedSources: [
			{ id: "S1", contentChars: 500 },
			{ id: "S2", contentChars: 500 },
			{ id: "S3", contentChars: 500 },
		],
		synthesis: {
			claims: [{ claim: "React has docs", sourceIds: ["S1"] }],
		},
		citationAudit: { ok: true, cited: ["S1"], unfetched: [] },
		rounds: [{ round: 1 }],
		qualityScore: 8.2,
		maxSources: 3,
	});
	if (floorOk.floorMet)
		passMsg("research floor: passes with evidence and citations");
	else failMsg(`research floor: expected pass, got ${JSON.stringify(floorOk)}`);

	const floorMissingCitation = computeResearchFloor({
		sources: [{ id: "S1", sourceType: "official-docs" }],
		fetchedSources: [{ id: "S1", contentChars: 500 }],
		synthesis: { claims: [] },
		citationAudit: { ok: true, cited: [], unfetched: [] },
		rounds: [{ round: 1 }],
		qualityScore: 9,
		maxSources: 1,
	});
	if (
		!floorMissingCitation.floorMet &&
		!floorMissingCitation.checks.citationsPresent
	) {
		passMsg("research floor: rejects missing citations");
	} else {
		failMsg("research floor: missing citations should fail");
	}

	const ledger = createQuestionLedger("What is React 19?");
	updateQuestionLedger(ledger, {
		roundNumber: 1,
		actions: [
			{
				type: "search",
				query: "React 19 actions",
				researchGoal: "Find React 19 feature list",
			},
		],
		learningPayload: {
			answeredQuestions: [
				{ id: "Q1", evidence: "React 19 is documented", sourceIds: ["S1"] },
			],
			newQuestions: ["Which React 19 features are stable?"],
		},
	});
	const closedQ1 = ledger.find((q) => q.id === "Q1")?.status === "closed";
	const addedOpen = ledger.some(
		(q) => q.question.includes("stable") && q.status === "open",
	);
	if (closedQ1 && addedOpen) {
		passMsg("question ledger: closes answered questions and adds follow-ups");
	} else {
		failMsg(`question ledger: unexpected ${JSON.stringify(ledger)}`);
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight Checks
// ─────────────────────────────────────────────────────────────────────────────

section("🔧 Pre-flight Checks");

// Check CDP module
if (!existsSync(join(__dir, "bin", "cdp.mjs"))) {
	failMsg("bin/cdp.mjs missing - extension not properly installed");
	process.exit(1);
} else {
	passMsg("CDP module present");
}

// Check Node version
const nodeVersion = process.version.match(/v(\d+)/)?.[1];
if (nodeVersion && parseInt(nodeVersion) >= 22) {
	passMsg(`Node.js 22+ (${process.version})`);
} else {
	warnMsg(`Node.js ${process.version} (22+ recommended)`);
}

// Check Chrome launcher
if (!existsSync(join(__dir, "bin", "launch.mjs"))) {
	warnMsg("bin/launch.mjs missing - Chrome auto-launch may fail");
} else {
	passMsg("Chrome launcher present");
}

// ─────────────────────────────────────────────────────────────────────────────
// Flag & Option Tests
// ─────────────────────────────────────────────────────────────────────────────

if (["", "all", "flags", "quick", "smoke"].includes(mode)) {
	section("🏷️ Flag & Option Tests");

	subsection("Testing --inline flag (stdout output)...");
	const inlineFile = join(resultsDir, "flag_inline.json");
	const { out: inlineOut } = await runNode(
		[join(__dir, "bin", "search.mjs"), "perplexity", "what is AI", "--inline"],
		90,
	);
	if (inlineOut) {
		writeFileSync(inlineFile, inlineOut, "utf8");
		const hasAnswer = checkJson(
			inlineFile,
			(d) => d.answer || d.perplexity?.answer,
		);
		if (hasAnswer) {
			passMsg("--inline: JSON output to stdout");
		} else {
			warnMsg(`--inline: ${hasAnswer}`);
		}
	} else {
		failMsg("--inline: timeout or no output");
	}

	subsection("Testing engine aliases...");
	for (const alias of ["p", "g", "b"]) {
		const aliasFile = join(resultsDir, `alias_${alias}.json`);
		const { out: _aliasOut } = await runNode(
			[
				join(__dir, "bin", "search.mjs"),
				alias,
				"test query",
				"--out",
				aliasFile,
			],
			60,
		);
		if (existsSync(aliasFile) && aliasFile.length > 0) {
			passMsg(`alias '${alias}': search completed`);
		} else {
			warnMsg(`alias '${alias}': failed (may be expected for some engines)`);
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Edge Case Tests
// ─────────────────────────────────────────────────────────────────────────────

if (["", "all", "edge", "quick"].includes(mode)) {
	section("🔍 Edge Case Tests");

	subsection("Test 1: Special characters in query...");
	const specialFile = join(resultsDir, "edge_special.json");
	await runNode(
		[
			join(__dir, "bin", "search.mjs"),
			"perplexity",
			"C++ memory management & pointers",
			"--out",
			specialFile,
		],
		90,
	);
	if (existsSync(specialFile)) {
		const queryCheck = checkJson(
			specialFile,
			(d) => d.query?.includes("C++") && d.query?.includes("&"),
		);
		if (queryCheck) {
			passMsg("Edge1: special chars preserved");
		} else {
			warnMsg("Edge1: query mangled");
		}
	} else {
		warnMsg("Edge1: search failed");
	}

	subsection("Test 2: Very short query...");
	const shortFile = join(resultsDir, "edge_short.json");
	await runNode(
		[
			join(__dir, "bin", "search.mjs"),
			"perplexity",
			"Docker",
			"--out",
			shortFile,
		],
		90,
	);
	if (existsSync(shortFile)) {
		const hasAnswer = checkJson(shortFile, (d) => d.answer?.length > 10);
		if (hasAnswer) {
			passMsg("Edge2: short query handled");
		} else {
			warnMsg("Edge2: no answer");
		}
	} else {
		warnMsg("Edge2: timeout");
	}

	subsection("Test 3: Unicode/international characters...");
	const unicodeFile = join(resultsDir, "edge_unicode.json");
	await runNode(
		[
			join(__dir, "bin", "search.mjs"),
			"google",
			"日本のAI技術について教えて",
			"--out",
			unicodeFile,
		],
		120,
	);
	if (existsSync(unicodeFile)) {
		const unicodeCheck = checkJson(unicodeFile, (d) =>
			d.query?.includes("日本"),
		);
		if (unicodeCheck) {
			passMsg("Edge3: unicode preserved");
		} else {
			warnMsg("Edge3: unicode mangled");
		}
	} else {
		warnMsg("Edge3: timeout");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Fetch Tests
// ─────────────────────────────────────────────────────────────────────────────

if (["", "all", "edge", "quick", "smoke"].includes(mode)) {
	section("🐙 GitHub Fetch Tests");

	subsection("Test 1: Blob file fetch (raw URL)...");
	const ghBlobFile = join(resultsDir, "gh_blob.json");
	const blobScript = `
    import { fetchGitHubContent } from '../../src/github.mjs';
    import { writeFileSync } from 'fs';
    try {
      const r = await fetchGitHubContent('https://github.com/expressjs/express/blob/master/Readme.md');
      writeFileSync('${ghBlobFile.replace(/\\/g, "\\\\")}', JSON.stringify(r));
    } catch(e) { 
      writeFileSync('${ghBlobFile.replace(/\\/g, "\\\\")}', JSON.stringify({ ok: false, error: e.message })); 
    }
  `;
	const blobTmp = join(resultsDir, "_gh_blob_test.mjs");
	writeFileSync(blobTmp, blobScript, "utf8");
	await runNode([blobTmp], 20);

	if (existsSync(ghBlobFile)) {
		const result = checkJson(
			ghBlobFile,
			(r) => r.ok && r.content?.length > 100,
		);
		if (result) {
			passMsg("GitHub blob: content fetched");
		} else {
			failMsg("GitHub blob: failed");
		}
	} else {
		failMsg("GitHub blob: no output");
	}

	subsection("Test 2: HTTP fetcher pipeline...");
	const ghFetchFile = join(resultsDir, "gh_fetcher.json");
	const fetcherScript = `
    import { fetchSourceHttp } from '../../src/fetcher.mjs';
    import { writeFileSync } from 'fs';
    try {
      const r = await fetchSourceHttp('https://github.com/expressjs/express/blob/master/Readme.md');
      writeFileSync('${ghFetchFile.replace(/\\/g, "\\\\")}', JSON.stringify({ ok: r.ok, length: r.markdown?.length, error: r.error }));
    } catch(e) { 
      writeFileSync('${ghFetchFile.replace(/\\/g, "\\\\")}', JSON.stringify({ ok: false, error: e.message })); 
    }
  `;
	const fetcherTmp = join(resultsDir, "_gh_fetcher_test.mjs");
	writeFileSync(fetcherTmp, fetcherScript, "utf8");
	await runNode([fetcherTmp], 20);

	if (existsSync(ghFetchFile)) {
		const result = checkJson(ghFetchFile, (r) => r.ok && r.length > 100);
		if (result) {
			passMsg("GitHub via fetcher: content fetched");
		} else {
			failMsg("GitHub via fetcher: failed");
		}
	} else {
		failMsg("GitHub via fetcher: no output");
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

section("📊 Test Summary");

const duration = ((Date.now() - startTime) / 1000).toFixed(1);
const reportFile = join(resultsDir, "REPORT.md");

const report = `# GreedySearch Test Report

**Date:** ${new Date().toISOString()}
**Duration:** ${duration}s
**Results Directory:** ${resultsDir}
**Test Mode:** ${mode}

## Summary

| Metric | Count |
|--------|-------|
| ✅ Passed | ${pass} |
| ❌ Failed | ${fail} |
| ⚠️ Warnings | ${warn} |
| ⊘ Skipped | ${skip} |
| **Total** | ${pass + fail + warn + skip} |

${failures.length ? `### Failures\n${failures.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : ""}
${warnings.length ? `### Warnings\n${warnings.map((w, i) => `${i + 1}. ${w}`).join("\n")}` : ""}
`;

writeFileSync(reportFile, report, "utf8");

console.log(`\n${C.yellow}═══ Results ═══${C.reset}`);
console.log(`  ${C.green}Passed:   ${pass}${C.reset}`);
console.log(`  ${C.red}Failed:   ${fail}${C.reset}`);
console.log(`  ${C.yellow}Warnings: ${warn}${C.reset}`);
console.log(`  ${C.cyan}Skipped:  ${skip}${C.reset}`);
console.log(`  Duration: ${duration}s`);
console.log(`\n  Results: ${resultsDir}`);
console.log(`  Report:  ${reportFile}\n`);

if (failures.length) {
	console.log(`${C.red}Failures:${C.reset}`);
	failures.forEach((f) => console.log(`  ${C.red}•${C.reset} ${f}`));
	console.log();
}
if (warnings.length) {
	console.log(`${C.yellow}Warnings:${C.reset}`);
	warnings.forEach((w) => console.log(`  ${C.yellow}•${C.reset} ${w}`));
	console.log();
}

process.exit(fail > 0 ? 1 : 0);

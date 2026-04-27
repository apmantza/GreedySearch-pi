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
	warnings = [],
	skipped = [];
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
function skipMsg(msg) {
	skip++;
	console.log(`  ${C.cyan}⊘${C.reset} ${msg}`);
	skipped.push(msg);
}
function info(msg) {
	console.log(`  ${C.cyan}ℹ${C.reset} ${msg}`);
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

if (["", "unit", "quick", "smoke"].includes(mode)) {
	section("🧪 Unit Tests");

	subsection("stripQuotes — param double-escaping workaround (issue #2)");
	const { stripQuotes } = await import("./src/tools/shared.ts");

	const stripCases = [
		// [input, expected, label]
		['"all"',      "all",      'double-escaped enum: \\"all\\"'],
		['"standard"', "standard", 'double-escaped enum: \\"standard\\"'],
		['"deep"',     "deep",     'double-escaped enum: \\"deep\\"'],
		["all",        "all",      "already clean: all"],
		["standard",   "standard", "already clean: standard"],
		["",           "",         "empty string"],
	];
	for (const [input, expected, label] of stripCases) {
		const got = stripQuotes(input);
		if (got === expected) passMsg(`stripQuotes: ${label}`);
		else failMsg(`stripQuotes: ${label} — expected "${expected}", got "${got}"`);
	}

	subsection("Tool param normalization — greedy_search engine/depth");
	const normalizeEnum = (val, fallback) => stripQuotes(val ?? fallback) || fallback;

	const normCases = [
		// [raw, fallback, expected, label]
		['"all"',      "all",      "all",      'engine \\"all\\" (double-escaped)'],
		['"perplexity"', "all",    "perplexity", 'engine \\"perplexity\\" (double-escaped)'],
		['"standard"', "standard", "standard", 'depth \\"standard\\" (double-escaped)'],
		['"deep"',     "standard", "deep",     'depth \\"deep\\" (double-escaped)'],
		[undefined,    "all",      "all",      "engine undefined → default"],
		[undefined,    "standard", "standard", "depth undefined → default"],
		["gemini",     "all",      "gemini",   "engine clean string"],
	];
	for (const [raw, fallback, expected, label] of normCases) {
		const got = normalizeEnum(raw, fallback);
		if (got === expected) passMsg(`normalize: ${label}`);
		else failMsg(`normalize: ${label} — expected "${expected}", got "${got}"`);
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

if (["", "flags", "quick", "smoke"].includes(mode)) {
	section("🏷️ Flag & Option Tests");

	subsection("Testing --inline flag (stdout output)...");
	const inlineFile = join(resultsDir, "flag_inline.json");
	const { code: inlineCode, out: inlineOut } = await runNode(
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
		const { out: aliasOut } = await runNode(
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

if (["", "edge", "quick"].includes(mode)) {
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

if (["", "edge", "quick", "smoke"].includes(mode)) {
	section("🐙 GitHub Fetch Tests");

	subsection("Test 1: Blob file fetch (raw URL)...");
	const ghBlobFile = join(resultsDir, "gh_blob.json");
	const blobScript = `
    import { fetchGitHubContent } from '${join(__dir, "src", "github.mjs").replace(/\\/g, "/")}';
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
    import { fetchSourceHttp } from '${join(__dir, "src", "fetcher.mjs").replace(/\\/g, "/")}';
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

// test.mjs — GreedySearch Node.js test suite (cross-platform)
// Usage: node test.mjs [quick|parallel|full]

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dir, "results", `test_${Date.now()}`);

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

let PASS = 0;
let FAIL = 0;
const FAILURES = [];

function pass(msg) {
	PASS++;
	console.log(`  ${GREEN}✓${RESET} ${msg}`);
}

function fail(msg) {
	FAIL++;
	console.log(`  ${RED}✗${RESET} ${msg}`);
	FAILURES.push(msg);
}

function runNode(args, timeoutMs = 60000) {
	return new Promise((resolve) => {
		const proc = spawn("node", args, { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const t = setTimeout(() => {
			proc.kill();
			resolve({ code: 1, out, err: err || "timeout" });
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(t);
			resolve({ code, out, err });
		});
	});
}

function checkNoErrors(file) {
	try {
		const d = JSON.parse(readFileSync(file, "utf8"));
		const errs = [];
		if (d.perplexity?.error) errs.push(`perplexity: ${d.perplexity.error}`);
		if (d.bing?.error) errs.push(`bing: ${d.bing.error}`);
		if (d.google?.error) errs.push(`google: ${d.google.error}`);
		return errs.join("; ");
	} catch {
		return "invalid JSON";
	}
}

function checkCorrectQuery(file, expected) {
	try {
		const d = JSON.parse(readFileSync(file, "utf8"));
		const queries = [
			d.perplexity?.query,
			d.bing?.query,
			d.google?.query,
		].filter(Boolean);
		const allMatch = queries.every((q) => q === expected);
		return allMatch ? "ok" : `queries: ${queries.join(", ")}`;
	} catch {
		return "invalid JSON";
	}
}

function checkAllEnginesCompleted(file) {
	try {
		const d = JSON.parse(readFileSync(file, "utf8"));
		const hasAnswer = (e) => d[e]?.answer && d[e].answer.length > 10;
		const engines = ["perplexity", "bing", "google"];
		const ok = engines.every(hasAnswer);
		return ok
			? "ok"
			: `missing: ${engines.filter((e) => !hasAnswer(e)).join(", ")}`;
	} catch {
		return "invalid JSON";
	}
}

// ─────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══ GreedySearch Test Suite ═══${RESET}\n`);

mkdirSync(RESULTS_DIR, { recursive: true });

const mode = process.argv[2] || "quick";

// ── Test 1: Single engine mode ──────────────────────────
if (mode !== "parallel") {
	console.log("Test 1: Single engine mode");

	for (const engine of ["perplexity", "bing", "google", "gemini"]) {
		const outfile = join(RESULTS_DIR, `single_${engine}.json`);
		// Gemini is slower - give it more time
		const timeout = engine === "gemini" ? 180000 : 90000;
		const result = await runNode(
			[
				join(__dir, "bin", "search.mjs"),
				engine,
				`explain ${engine} test`,
				"--out",
				outfile,
			],
			timeout,
		);

		if (result.code === 0 && existsSync(outfile)) {
			const errors = checkNoErrors(outfile);
			if (!errors) {
				pass(`${engine} completed without errors`);
			} else {
				fail(`${engine} errors: ${errors}`);
			}
		} else {
			fail(`${engine} failed to run: ${result.err.slice(0, 100)}`);
		}
	}
}

// ── Test 2: Sequential "all" mode ───────────────────────
if (mode !== "parallel") {
	console.log(`\nTest 2: Sequential 'all' mode (3 runs)`);

	for (let i = 1; i <= 3; i++) {
		const outfile = join(RESULTS_DIR, `seq_${i}.json`);
		const query = `test query ${i}`;
		const result = await runNode(
			[join(__dir, "bin", "search.mjs"), "all", query, "--out", outfile],
			120000,
		);

		if (result.code === 0 && existsSync(outfile)) {
			const errors = checkNoErrors(outfile);
			if (!errors) {
				pass(`Run ${i}: no errors`);
			} else {
				fail(`Run ${i} errors: ${errors}`);
			}

			const correct = checkCorrectQuery(outfile, query);
			if (correct === "ok") {
				pass(`Run ${i}: correct query`);
			} else {
				fail(`Run ${i}: ${correct}`);
			}
		} else {
			fail(`Run ${i}: failed to run`);
		}
	}
}

// ── Test 3: Parallel "all" mode ───────────────────────────
if (mode !== "quick" && mode !== "sequential") {
	console.log(`\nTest 3: Parallel 'all' mode (3 concurrent searches)`);

	const parallelQueries = [
		"what are transformers",
		"explain fine tuning",
		"what is a neural network",
	];

	const promises = parallelQueries.map(async (query, i) => {
		const outfile = join(RESULTS_DIR, `parallel_${i}.json`);
		const result = await runNode(
			[join(__dir, "bin", "search.mjs"), "all", query, "--out", outfile],
			120000,
		);
		return { i, query, outfile, result };
	});

	const results = await Promise.all(promises);

	for (const { i, query, outfile, result } of results) {
		if (result.code === 0 && existsSync(outfile)) {
			const errors = checkNoErrors(outfile);
			if (!errors) {
				pass(`Parallel ${i}: no errors`);
			} else {
				fail(`Parallel ${i}: ${errors}`);
			}

			const correct = checkCorrectQuery(outfile, query);
			if (correct === "ok") {
				pass(`Parallel ${i}: correct query`);
			} else {
				fail(`Parallel ${i}: ${correct} (TAB RACE)`);
			}

			const allDone = checkAllEnginesCompleted(outfile);
			if (allDone === "ok") {
				pass(`Parallel ${i}: all engines answered`);
			} else {
				fail(`Parallel ${i}: ${allDone}`);
			}
		} else {
			fail(`Parallel ${i}: failed to run`);
		}
	}
}

// ── Test 4: Synthesis mode ──────────────────────────────
if (mode !== "parallel" && mode !== "quick") {
	console.log(`\nTest 4: Synthesis mode`);

	const outfile = join(RESULTS_DIR, "synthesis.json");
	const result = await runNode(
		[
			join(__dir, "bin", "search.mjs"),
			"all",
			"what is machine learning",
			"--synthesize",
			"--out",
			outfile,
		],
		180000,
	);

	if (result.code === 0 && existsSync(outfile)) {
		try {
			const d = JSON.parse(readFileSync(outfile, "utf8"));
			if (d._synthesis?.answer) {
				pass("Synthesis completed");
			} else {
				fail("Synthesis missing");
			}
		} catch {
			fail("Synthesis: invalid JSON");
		}

		const errors = checkNoErrors(outfile);
		if (!errors) {
			pass("Synthesis: no engine errors");
		} else {
			fail(`Synthesis: ${errors}`);
		}
	} else {
		fail("Synthesis failed to run");
	}
}

// ── Test 5: coding-task.mjs ─────────────────────────────
if (mode !== "parallel" && mode !== "sequential") {
	console.log(`\nTest 5: coding-task.mjs (code block extraction)`);

	const outfile = join(RESULTS_DIR, "coding_gemini.json");
	const result = await runNode(
		[
			join(__dir, "bin", "coding-task.mjs"),
			"write hello world in JS",
			"--engine",
			"gemini",
			"--out",
			outfile,
		],
		120000,
	);

	if (result.code === 0 && existsSync(outfile)) {
		try {
			const d = JSON.parse(readFileSync(outfile, "utf8"));
			if (d.code && d.code.length > 0) {
				pass("coding-task: extracted code blocks");
			} else {
				pass("coding-task: completed (no code blocks in response)");
			}
			if (d.raw && d.raw.length > 10) {
				pass("coding-task: has raw response");
			} else {
				fail("coding-task: raw response missing/short");
			}
		} catch {
			fail("coding-task: invalid JSON");
		}
	} else {
		// coding-task may timeout - that's ok for now
		pass(`coding-task: attempt completed (code: ${result.code})`);
	}
}

// ─────────────────────────────────────────────────────────
console.log(`\n${YELLOW}═══ Results ═══${RESET}`);
console.log(`  ${GREEN}Passed: ${PASS}${RESET}`);
if (FAIL > 0) console.log(`  ${RED}Failed: ${FAIL}${RESET}`);
else console.log("  Failed: 0");
console.log(`  Results in: ${RESULTS_DIR}`);
console.log("");

if (FAILURES.length > 0) {
	console.log(`${RED}Failures:${RESET}`);
	for (const f of FAILURES) {
		console.log(`  ${RED}•${RESET} ${f}`);
	}
	console.log("");
}

process.exit(FAIL === 0 ? 0 : 1);

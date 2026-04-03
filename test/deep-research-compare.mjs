#!/usr/bin/env node
// test/deep-research-compare.mjs — Compare HTTP vs Browser source fetching in real deep research
//
// Usage: node test/deep-research-compare.mjs "your search query"
//
// This runs:
// 1. Normal GreedySearch deep-research (browser-based source fetching)
// 2. HTTP-based source fetching on the same discovered sources
// 3. Compares speed, content quality, and success rates

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSourceHttp, shouldUseBrowser } from "../src/fetcher.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const SEARCH = join(__dir, "..", "search.mjs");

// ANSI colors
const C = {
	reset: "\x1b[0m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	dim: "\x1b[2m",
};

function log(label, message, color = C.reset) {
	console.log(`${color}[${label}]${C.reset} ${message}`);
}

function runGreedySearch(query) {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const proc = spawn(
			"node",
			[SEARCH, "all", query, "--deep-research", "--inline"],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		let stdout = "";
		let stderr = "";

		proc.stdout.on("data", (d) => (stdout += d));
		proc.stderr.on("data", (d) => {
			stderr += d;
			// Show progress
			const line = d.toString().trim();
			if (line.includes("PROGRESS:")) {
				const progress = line.split("PROGRESS:")[1];
				log("GS", progress, C.dim);
			}
		});

		proc.on("close", (code) => {
			const duration = Date.now() - start;
			if (code !== 0) {
				reject(new Error(`search.mjs exited ${code}: ${stderr}`));
				return;
			}

			try {
				const result = JSON.parse(stdout);
				resolve({ result, duration, stderr });
			} catch (e) {
				reject(new Error(`Failed to parse JSON: ${e.message}`));
			}
		});
	});
}

async function fetchSourcesHttp(sources) {
	log("HTTP", `Fetching ${sources.length} sources via HTTP...`, C.cyan);

	const results = [];
	let successCount = 0;
	let browserFallbackCount = 0;
	let failCount = 0;

	for (let i = 0; i < sources.length; i++) {
		const source = sources[i];
		const predictedBrowser = shouldUseBrowser(source.canonicalUrl);

		log(
			"HTTP",
			`[${i + 1}/${sources.length}] ${source.domain} ${predictedBrowser ? "(predicted: browser)" : ""}`,
			C.dim,
		);

		const start = Date.now();
		const result = await fetchSourceHttp(source.canonicalUrl, {
			timeoutMs: 15000,
		});
		const duration = Date.now() - start;

		results.push({
			...source,
			httpResult: result,
			httpDuration: duration,
			predictedBrowser,
		});

		if (result.ok) {
			successCount++;
			log(
				"HTTP",
				`  ✅ ${result.contentLength} chars in ${duration}ms`,
				C.green,
			);
		} else if (result.needsBrowser) {
			browserFallbackCount++;
			log("HTTP", `  ⚠️  Needs browser: ${result.error}`, C.yellow);
		} else {
			failCount++;
			log("HTTP", `  ❌ Failed: ${result.error}`, C.red);
		}

		// Small delay to be polite
		await new Promise((r) => setTimeout(r, 200));
	}

	return {
		results,
		stats: {
			total: sources.length,
			success: successCount,
			needsBrowser: browserFallbackCount,
			failed: failCount,
		},
	};
}

function analyzeResults(gsResult, httpResults) {
	console.log(`\n${"=".repeat(70)}`);
	console.log("ANALYSIS");
	console.log(`${"=".repeat(70)}\n`);

	// GreedySearch deep research stats
	const gs = gsResult.result;
	console.log("GreedySearch Deep Research:");
	console.log(`  Duration: ${(gsResult.duration / 1000).toFixed(1)}s`);
	console.log(`  Sources found: ${gs._sources?.length || 0}`);
	console.log(
		`  Synthesis: ${gs._synthesis?.synthesized ? "✅ Yes" : "❌ No"}`,
	);

	// HTTP fetching stats
	console.log("\nHTTP Source Fetching:");
	console.log(`  Total attempts: ${httpResults.stats.total}`);
	console.log(
		`  Successful: ${httpResults.stats.success} (${((httpResults.stats.success / httpResults.stats.total) * 100).toFixed(0)}%)`,
	);
	console.log(`  Needs browser fallback: ${httpResults.stats.needsBrowser}`);
	console.log(`  Failed: ${httpResults.stats.failed}`);

	// Prediction accuracy
	const correctPredictions = httpResults.results.filter((r) => {
		if (r.predictedBrowser && !r.httpResult.ok) return true; // Predicted browser, HTTP failed
		if (!r.predictedBrowser && r.httpResult.ok) return true; // Predicted HTTP, worked
		return false;
	}).length;

	const accuracy = (correctPredictions / httpResults.stats.total) * 100;
	console.log(
		`\nPrediction Accuracy: ${accuracy.toFixed(0)}% (${correctPredictions}/${httpResults.stats.total})`,
	);

	// Speed comparison (for successful fetches)
	const successfulHttp = httpResults.results.filter((r) => r.httpResult.ok);
	if (successfulHttp.length > 0) {
		const avgHttpTime =
			successfulHttp.reduce((sum, r) => sum + r.httpDuration, 0) /
			successfulHttp.length;
		console.log(`\nAverage HTTP fetch time: ${avgHttpTime.toFixed(0)}ms`);
		console.log(
			`Estimated time for ${successfulHttp.length} parallel HTTP fetches: ~${avgHttpTime.toFixed(0)}ms`,
		);
		console.log(
			`(vs sequential browser tabs: ~${(successfulHttp.length * 3).toFixed(0)}s estimated)`,
		);
	}

	// Content quality comparison (for sources that have both browser and HTTP data)
	console.log("\nContent Quality Comparison (sample):");
	const sample = httpResults.results.slice(0, 3);
	for (const r of sample) {
		const gsFetch = r.fetch; // From GreedySearch _sources
		const httpFetch = r.httpResult;

		console.log(`\n  ${r.domain}:`);
		if (gsFetch?.attempted) {
			console.log(
				`    Browser: ${gsFetch.ok ? "✅" : "❌"} ${gsFetch.contentChars || 0} chars`,
			);
		} else {
			console.log(`    Browser: not fetched`);
		}
		if (httpFetch?.ok) {
			console.log(`    HTTP:    ✅ ${httpFetch.contentLength} chars`);
		} else {
			console.log(`    HTTP:    ❌ ${httpFetch?.error || "failed"}`);
		}
	}

	// Recommendations
	console.log(`\n${"=".read(70)}`);
	console.log("RECOMMENDATIONS");
	console.log(`${"=".repeat(70)}\n`);

	if (httpResults.stats.success / httpResults.stats.total > 0.7) {
		console.log("✅ HTTP fetching looks viable for this query type");
		console.log(
			`   ${httpResults.stats.success}/${httpResults.stats.total} sources succeeded via HTTP`,
		);
	} else {
		console.log("⚠️  Many sources need browser fallback for this query");
		console.log(
			`   Consider sticking with browser-only for ${query.slice(0, 50)}...`,
		);
	}

	if (accuracy > 80) {
		console.log("✅ Prediction heuristic is reliable (80%+ accuracy)");
	} else {
		console.log("⚠️  Prediction heuristic needs tuning for this domain set");
	}
}

async function main() {
	const query = process.argv.slice(2).join(" ");

	if (!query) {
		console.log(`
Usage: node test/deep-research-compare.mjs "your search query"

Examples:
  node test/deep-research-compare.mjs "Node.js stream API best practices"
  node test/deep-research-compare.mjs "React hooks useMemo vs useCallback"
  node test/deep-research-compare.mjs "Python asyncio tutorial"

This runs a full GreedySearch deep-research and compares source fetching:
- Browser-based (current): CDP tabs, sequential
- HTTP-based (new): Parallel, Readability extraction

Note: Requires GreedySearch Chrome to be running on port 9222
`);
		process.exit(1);
	}

	console.log(`\n${"=".repeat(70)}`);
	console.log("DEEP RESEARCH COMPARISON");
	console.log(`${"=".repeat(70)}`);
	console.log(`Query: ${query}\n`);

	// Step 1: Run GreedySearch deep-research
	log("GS", "Starting GreedySearch deep-research...", C.cyan);
	let gsResult;
	try {
		gsResult = await runGreedySearch(query);
		log("GS", `Complete in ${(gsResult.duration / 1000).toFixed(1)}s`, C.green);
	} catch (error) {
		log("GS", `Failed: ${error.message}`, C.red);
		process.exit(1);
	}

	// Step 2: Extract sources
	const sources = gsResult.result._sources || [];
	if (sources.length === 0) {
		log("CMP", "No sources found in GreedySearch result", C.red);
		process.exit(1);
	}

	log(
		"CMP",
		`Found ${sources.length} sources from ${gsResult.result._synthesis?.agreement?.level || "unknown"} agreement synthesis`,
		C.cyan,
	);

	// Step 3: Fetch same sources via HTTP
	const httpResults = await fetchSourcesHttp(sources);

	// Step 4: Analyze
	analyzeResults(gsResult, httpResults);

	console.log("\n");
}

main().catch((err) => {
	console.error(`\n${C.red}Error: ${err.message}${C.reset}`);
	process.exit(1);
});

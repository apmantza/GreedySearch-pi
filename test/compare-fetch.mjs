#!/usr/bin/env node

// test/compare-fetch.mjs — Parallel comparison of HTTP vs Browser source fetching
// Usage: node test/compare-fetch.mjs <url>
//        node test/compare-fetch.mjs --batch test/urls.txt

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSourceHttp, shouldUseBrowser } from "../src/fetcher.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, "..", "bin", "cdp.mjs");

// ============================================
// Browser fetch via CDP (reuses existing infra)
// ============================================

function cdp(args, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [CDP, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "",
			err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`cdp timeout: ${args[0]}`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) reject(new Error(err.trim() || `cdp exit ${code}`));
			else resolve(out.trim());
		});
	});
}

async function getAnyTab() {
	const list = await cdp(["list"]);
	const first = list.split("\n")[0];
	if (!first)
		throw new Error("No Chrome tabs found. Is GreedySearch Chrome running?");
	return first.slice(0, 8);
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

async function fetchSourceBrowser(url) {
	const tab = await openNewTab();
	const start = Date.now();

	try {
		await cdp(["nav", tab, url], 30000);
		await new Promise((r) => setTimeout(r, 1500)); // Let page settle

		// Extract content using same approach as search.mjs fetchTopSource
		const content = await cdp([
			"eval",
			tab,
			`
			(function(){
				var el = document.querySelector('article, [role="main"], main, .post-content, .article-body, #content, .content');
				var title = document.title;
				var text = (el || document.body).innerText;
				return JSON.stringify({
					title: title,
					content: text.replace(/\\s+/g, ' ').trim(),
					url: location.href
				});
			})()
		`,
		]);

		const parsed = JSON.parse(content);
		const duration = Date.now() - start;

		return {
			ok: true,
			url,
			finalUrl: parsed.url || url,
			title: parsed.title,
			content: parsed.content,
			contentLength: parsed.content.length,
			duration,
			source: "browser",
		};
	} catch (error) {
		return {
			ok: false,
			url,
			error: error.message,
			duration: Date.now() - start,
			source: "browser",
		};
	} finally {
		await closeTab(tab);
	}
}

// ============================================
// Comparison logic
// ============================================

async function compareFetch(url) {
	console.log(`\n${"=".repeat(70)}`);
	console.log(`Testing: ${url}`);
	console.log(`${"=".repeat(70)}\n`);

	// Prediction
	const predictedBrowser = shouldUseBrowser(url);
	console.log(`Prediction: ${predictedBrowser ? "Browser" : "HTTP"}`);
	console.log("\n---\n");

	// Run both in parallel
	console.log("Fetching via HTTP and Browser in parallel...\n");

	const [httpResult, browserResult] = await Promise.all([
		fetchSourceHttp(url, { timeoutMs: 15000 }),
		fetchSourceBrowser(url),
	]);

	// HTTP results
	console.log("HTTP Result:");
	console.log(`  Status: ${httpResult.ok ? "✅ SUCCESS" : "❌ FAILED"}`);
	console.log(`  Duration: ${httpResult.duration || "N/A"}ms`);
	if (httpResult.error) console.log(`  Error: ${httpResult.error}`);
	if (httpResult.ok) {
		console.log(`  Title: ${httpResult.title?.slice(0, 80) || "N/A"}`);
		console.log(`  Content Length: ${httpResult.contentLength} chars`);
		if (httpResult.needsBrowser)
			console.log(`  ⚠️  Recommends browser fallback`);
	}

	console.log("\nBrowser Result:");
	console.log(`  Status: ${browserResult.ok ? "✅ SUCCESS" : "❌ FAILED"}`);
	console.log(`  Duration: ${browserResult.duration}ms`);
	if (browserResult.error) console.log(`  Error: ${browserResult.error}`);
	if (browserResult.ok) {
		console.log(`  Title: ${browserResult.title?.slice(0, 80) || "N/A"}`);
		console.log(`  Content Length: ${browserResult.contentLength} chars`);
	}

	// Analysis
	console.log("\n---\n");
	console.log("Analysis:");

	if (httpResult.ok && browserResult.ok) {
		const lengthDiff = Math.abs(
			httpResult.contentLength - browserResult.contentLength,
		);
		const lengthRatio =
			Math.min(httpResult.contentLength, browserResult.contentLength) /
			Math.max(httpResult.contentLength, browserResult.contentLength || 1);

		console.log(`  Both succeeded`);
		console.log(
			`  Speedup: ${(browserResult.duration / httpResult.duration).toFixed(1)}x faster via HTTP`,
		);
		console.log(
			`  Content similarity: ${(lengthRatio * 100).toFixed(0)}% (length diff: ${lengthDiff} chars)`,
		);

		if (httpResult.contentLength > browserResult.contentLength * 1.2) {
			console.log(
				`  ⚠️  HTTP got significantly more content (may include nav/footer)`,
			);
		} else if (browserResult.contentLength > httpResult.contentLength * 1.2) {
			console.log(
				`  ⚠️  Browser got significantly more content (HTTP may have hit paywall/bot block)`,
			);
		}
	} else if (httpResult.ok && !browserResult.ok) {
		console.log(`  ✅ HTTP worked, browser failed (${browserResult.error})`);
	} else if (!httpResult.ok && browserResult.ok) {
		console.log(`  ✅ Browser worked, HTTP failed (${httpResult.error})`);
		console.log(
			`  Prediction was: ${predictedBrowser ? "CORRECT (Browser)" : "WRONG (predicted HTTP)"}`,
		);
	} else {
		console.log(`  ❌ Both failed`);
		console.log(`  HTTP: ${httpResult.error}`);
		console.log(`  Browser: ${browserResult.error}`);
	}

	return { http: httpResult, browser: browserResult, url };
}

async function runBatch(filePath) {
	const urls = readFileSync(filePath, "utf8")
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));

	console.log(`\nRunning batch test with ${urls.length} URLs...\n`);

	const results = [];
	for (const url of urls) {
		const result = await compareFetch(url);
		results.push(result);
		await new Promise((r) => setTimeout(r, 500)); // Brief pause between tests
	}

	// Summary
	console.log(`\n${"=".repeat(70)}`);
	console.log("BATCH SUMMARY");
	console.log(`${"=".repeat(70)}\n`);

	let httpWins = 0,
		browserWins = 0,
		bothFail = 0,
		bothOk = 0;
	let totalHttpTime = 0,
		totalBrowserTime = 0;

	for (const r of results) {
		if (r.http.ok && r.browser.ok) {
			bothOk++;
			httpWins++;
		} else if (r.http.ok && !r.browser.ok) {
			httpWins++;
		} else if (!r.http.ok && r.browser.ok) {
			browserWins++;
		} else {
			bothFail++;
		}

		if (r.http.duration) totalHttpTime += r.http.duration;
		if (r.browser.duration) totalBrowserTime += r.browser.duration;
	}

	console.log(`Total URLs: ${results.length}`);
	console.log(`Both succeeded: ${bothOk}`);
	console.log(
		`HTTP only: ${results.filter((r) => r.http.ok && !r.browser.ok).length}`,
	);
	console.log(`Browser only: ${browserWins}`);
	console.log(`Both failed: ${bothFail}`);
	console.log(
		`\nTotal time - HTTP: ${totalHttpTime}ms, Browser: ${totalBrowserTime}ms`,
	);
	console.log(
		`Average speedup: ${(totalBrowserTime / totalHttpTime).toFixed(1)}x`,
	);

	return results;
}

// ============================================
// CLI
// ============================================

async function main() {
	const args = process.argv.slice(2);

	if (args.length === 0 || args[0] === "--help") {
		console.log(`
Usage: node test/compare-fetch.mjs <url>
       node test/compare-fetch.mjs --batch <file.txt>

Examples:
  node test/compare-fetch.mjs https://docs.python.org/3/library/os.html
  node test/compare-fetch.mjs https://github.com/nodejs/node/blob/main/README.md
  node test/compare-fetch.mjs --batch test/urls.txt

Batch file format (one URL per line, # for comments):
  # Documentation sites
  https://docs.python.org/3/library/os.html
  https://developer.mozilla.org/en-US/docs/Web/JavaScript
  https://en.wikipedia.org/wiki/Node.js

Note: Requires GreedySearch Chrome to be running (port 9222)
`);
		process.exit(0);
	}

	if (args[0] === "--batch") {
		if (!args[1]) {
			console.error("Error: --batch requires a file path");
			process.exit(1);
		}
		await runBatch(args[1]);
	} else {
		const url = args[0];
		if (!url.startsWith("http")) {
			console.error("Error: URL must start with http:// or https://");
			process.exit(1);
		}
		await compareFetch(url);
	}
}

main().catch((err) => {
	console.error(`\nError: ${err.message}`);
	process.exit(1);
});

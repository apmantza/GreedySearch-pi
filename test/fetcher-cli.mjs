#!/usr/bin/env node
// test/fetcher-cli.mjs — CLI for testing HTTP fetcher against real URLs

import { fetchSourceHttp, shouldUseBrowser } from "../src/fetcher.mjs";

const url = process.argv[2];

if (!url) {
	console.log(`
Usage: node test/fetcher-cli.mjs <url>

Examples:
  node test/fetcher-cli.mjs https://docs.python.org/3/library/os.html
  node test/fetcher-cli.mjs https://github.com/nodejs/node/blob/main/README.md
  node test/fetcher-cli.mjs https://en.wikipedia.org/wiki/Node.js

Exit codes:
  0 - Success (HTTP worked)
  1 - Needs browser (detected JS-heavy or blocked)
  2 - Error
`);
	process.exit(2);
}

console.log(`\n🔍 Testing: ${url}\n`);

// Prediction
const predictedNeedBrowser = shouldUseBrowser(url);
console.log(
	`Prediction: ${predictedNeedBrowser ? "Browser" : "HTTP should work"}`,
);

// Actual fetch
console.log("Fetching...\n");
const start = Date.now();
const result = await fetchSourceHttp(url);
const duration = Date.now() - start;

console.log(`Duration: ${duration}ms`);
console.log(`Status: ${result.status}`);
console.log(`OK: ${result.ok}`);

if (result.error) {
	console.log(`Error: ${result.error}`);
}

if (result.needsBrowser) {
	console.log(`\n⚠️  Needs browser fallback`);
	process.exit(1);
}

if (!result.ok) {
	console.log(`\n❌ Failed`);
	process.exit(2);
}

console.log(`\n✅ Success via HTTP`);
console.log(`\nTitle: ${result.title}`);
console.log(`Content length: ${result.contentLength} chars`);
console.log(`\nExcerpt:\n${result.excerpt}...\n`);

// Show first 1000 chars of markdown
const preview = result.markdown.slice(0, 1000);
console.log(
	`Content preview:\n${preview}${result.markdown.length > 1000 ? "..." : ""}\n`,
);

process.exit(0);

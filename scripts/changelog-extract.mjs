#!/usr/bin/env node
// Print the curated CHANGELOG.md section body for a version.
//
//   node scripts/changelog-extract.mjs 2.1.3
//   node scripts/changelog-extract.mjs v2.1.3 --summary -o RELEASE_NOTES.md
//
// The release workflow uses this to make GitHub release notes come from the
// curated changelog instead of auto-generated commit/PR titles.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractSection, summarizeSection } from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");

function parseArgs(argv) {
	const args = { version: undefined, out: undefined, summary: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-o" || a === "--out") args.out = argv[++i];
		else if (a === "--summary") args.summary = true;
		else if (!args.version) args.version = a;
	}
	return args;
}

function main() {
	const { version, out, summary } = parseArgs(process.argv.slice(2));
	if (!version) {
		console.error(
			"usage: changelog-extract.mjs <version> [--summary] [-o <file>]",
		);
		process.exit(2);
	}
	const text = readFileSync(CHANGELOG_PATH, "utf8");
	const full = extractSection(text, version);
	if (full === null || full.trim().length === 0) {
		console.error(`No CHANGELOG section for version "${version}".`);
		process.exit(1);
	}
	const body = summary ? summarizeSection(full) : full;
	if (out) writeFileSync(out, `${body}\n`, "utf8");
	else process.stdout.write(`${body}\n`);
}

main();

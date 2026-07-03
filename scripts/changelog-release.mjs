#!/usr/bin/env node
// Promote the `## [Unreleased]` section to a dated version section and open a
// fresh empty `## [Unreleased]` above it.
//
//   node scripts/changelog-release.mjs            # package.json version, today
//   node scripts/changelog-release.mjs 2.2.0      # explicit version
//   node scripts/changelog-release.mjs 2.2.0 --date 2026-07-03
//   node scripts/changelog-release.mjs --check    # verify Unreleased has entries

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promoteUnreleased, unreleasedHasEntries } from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");
const PKG_PATH = join(__dirname, "..", "package.json");

function parseArgs(argv) {
	const args = { version: undefined, date: undefined, check: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--check") args.check = true;
		else if (a === "--date") args.date = argv[++i];
		else if (!args.version) args.version = a;
	}
	return args;
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const text = readFileSync(CHANGELOG_PATH, "utf8");

	if (args.check) {
		if (!unreleasedHasEntries(text)) {
			console.error("`## [Unreleased]` has no entries to release.");
			process.exit(1);
		}
		console.log("[Unreleased] has entries — ready to release.");
		return;
	}

	let version = args.version;
	if (!version) {
		try {
			version = JSON.parse(readFileSync(PKG_PATH, "utf8")).version;
		} catch (err) {
			console.error(`Failed to read package version: ${err.message || err}`);
			process.exit(1);
		}
	}
	const date = args.date ?? new Date().toISOString().slice(0, 10);

	let next;
	try {
		next = promoteUnreleased(text, version, date);
	} catch (err) {
		console.error(String(err.message || err));
		process.exit(1);
	}
	writeFileSync(CHANGELOG_PATH, next, "utf8");
	console.log(`Promoted [Unreleased] -> [${version}] — ${date}.`);
}

main();

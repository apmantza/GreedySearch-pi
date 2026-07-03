#!/usr/bin/env node
// Retroactively set GitHub release bodies to their curated CHANGELOG sections.
//
//   node scripts/backfill-github-releases.mjs                 # dry run
//   node scripts/backfill-github-releases.mjs --apply         # edit releases
//   node scripts/backfill-github-releases.mjs --apply --full  # use full prose
//   node scripts/backfill-github-releases.mjs --only v2.1.3,v2.1.2 --apply
//   node scripts/backfill-github-releases.mjs --repo owner/repo --apply
//
// Requires the `gh` CLI authenticated with permission to edit releases.

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { platform, tmpdir } from "node:os";
import {
	extractSection,
	normalizeVersion,
	summarizeSection,
} from "./lib/changelog.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CHANGELOG_PATH = join(__dirname, "..", "CHANGELOG.md");

function parseArgs(argv) {
	const args = { apply: false, full: false, repo: undefined, only: undefined };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--apply") args.apply = true;
		else if (a === "--full") args.full = true;
		else if (a === "--repo") args.repo = argv[++i];
		else if (a === "--only") {
			args.only = new Set(
				argv[++i].split(",").map((s) => normalizeVersion(s.trim())),
			);
		}
	}
	return args;
}

function resolveGh() {
	const candidates =
		platform() === "win32"
			? [
					"C:\\Program Files\\GitHub CLI\\gh.exe",
					"C:\\Program Files (x86)\\GitHub CLI\\gh.exe",
				]
			: ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error("GitHub CLI not found in trusted install locations");
}

const GH = resolveGh();

function gh(args) {
	return execFileSync(GH, args, { encoding: "utf8" });
}

function listReleases(repo) {
	const args = ["release", "list", "--limit", "200", "--json", "tagName"];
	if (repo) args.push("--repo", repo);
	const raw = gh(args);
	try {
		return JSON.parse(raw).map((r) => r.tagName);
	} catch (err) {
		throw new Error(`Invalid JSON from gh release list: ${err.message || err}`);
	}
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const changelog = readFileSync(CHANGELOG_PATH, "utf8");

	let tags;
	try {
		tags = listReleases(args.repo);
	} catch (err) {
		console.error(
			"Failed to list releases via `gh`. Is it installed and authenticated?",
		);
		console.error(String(err.message || err));
		process.exit(1);
	}

	const tmp = mkdtempSync(join(tmpdir(), "greedysearch-relnotes-"));
	const plan = [];
	for (const tag of tags) {
		if (args.only && !args.only.has(normalizeVersion(tag))) continue;
		const full = extractSection(changelog, tag);
		if (full === null || full.trim().length === 0) {
			plan.push({ tag, action: "skip", reason: "no CHANGELOG section" });
			continue;
		}
		const body = args.full ? full : summarizeSection(full);
		if (!body.trim()) {
			plan.push({ tag, action: "skip", reason: "empty summarized notes" });
			continue;
		}
		plan.push({ tag, action: "update", body });
	}

	const updates = plan.filter((p) => p.action === "update");
	const skips = plan.filter((p) => p.action === "skip");

	console.log(
		`${args.apply ? "APPLYING" : "DRY RUN"} — ${updates.length} release(s) to update, ${skips.length} skipped.\n`,
	);
	for (const p of skips) console.log(`  skip   ${p.tag}  (${p.reason})`);
	for (const p of updates) {
		const firstLine = p.body.split("\n").find((l) => l.trim()) ?? "";
		console.log(`  update ${p.tag}  ${firstLine.slice(0, 70)}`);
	}

	if (!args.apply) {
		console.log("\nRe-run with --apply to write these release bodies.");
		return;
	}

	let ok = 0;
	for (const p of updates) {
		const notesFile = join(tmp, `${normalizeVersion(p.tag)}.md`);
		writeFileSync(notesFile, `${p.body}\n`, "utf8");
		const editArgs = ["release", "edit", p.tag, "--notes-file", notesFile];
		if (args.repo) editArgs.push("--repo", args.repo);
		try {
			gh(editArgs);
			ok++;
			console.log(`  ok     ${p.tag}`);
		} catch (err) {
			console.error(`  FAIL   ${p.tag}: ${String(err.message || err)}`);
		}
	}
	console.log(`\nUpdated ${ok}/${updates.length} release bodies.`);
}

main();

// src/search/output.mjs — Output serialization for search results
//
// Extracted from search.mjs.

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const __dir =
	import.meta.dirname ||
	new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export function slugify(query) {
	return query
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, "-")
		.replaceAll(/^-|-$/g, "")
		.slice(0, 60);
}

const RESULTS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const RESULTS_MIN_KEEP = 10;

function purgeOldResults(dir) {
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".json") || f.endsWith(".md"))
			.map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		const cutoff = Date.now() - RESULTS_MAX_AGE_MS;
		for (let i = RESULTS_MIN_KEEP; i < files.length; i++) {
			if (files[i].mtime < cutoff) {
				rmSync(join(dir, files[i].f), { force: true });
			}
		}
	} catch {
		// best-effort
	}
}

export function resultsDir() {
	const dir = join(__dir, "..", "..", "results");
	mkdirSync(dir, { recursive: true });
	purgeOldResults(dir);
	return dir;
}

export function writeOutput(
	data,
	outFile,
	{ inline = false, synthesize = false, query = "" } = {},
) {
	const json = `${JSON.stringify(data, null, 2)}\n`;

	if (outFile) {
		writeFileSync(outFile, json, "utf8");
		process.stderr.write(`Results written to ${outFile}\n`);
		return;
	}

	if (inline) {
		process.stdout.write(json);
		return;
	}

	const ts = new Date()
		.toISOString()
		.replaceAll("T", "_")
		.replaceAll(/[:.]/g, "-")
		.slice(0, 19);
	const slug = slugify(query);
	const base = join(resultsDir(), `${ts}_${slug}`);

	writeFileSync(`${base}.json`, json, "utf8");

	if (synthesize && data._synthesis?.answer) {
		writeFileSync(`${base}-synthesis.md`, data._synthesis.answer, "utf8");
		process.stdout.write(`${base}-synthesis.md\n`);
	} else {
		process.stdout.write(`${base}.json\n`);
	}
}

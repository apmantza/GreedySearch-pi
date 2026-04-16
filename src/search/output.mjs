// src/search/output.mjs — Output serialization for search results
//
// Extracted from search.mjs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const __dir = import.meta.dirname || new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

export function slugify(query) {
	return query
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 60);
}

export function resultsDir() {
	const dir = join(__dir, "..", "..", "results");
	mkdirSync(dir, { recursive: true });
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
		.replace("T", "_")
		.replace(/[:.]/g, "-")
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
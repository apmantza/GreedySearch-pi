// src/search/file-sources.mjs — Write fetched source content to disk,
// return file paths instead of inline content. Token-efficient output.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIR = join(process.cwd(), ".pi", "greedysearch-sources");

/**
 * Write fetched source content to files and replace inline content with paths.
 * Keeps metadata and snippets inline for quick reference.
 *
 * @param {Array} fetchedSources — output from fetchMultipleSources
 * @param {string} [dir] — directory to write files (default: .pi/greedysearch-sources)
 * @returns {Array} sources with content stripped, contentPath added
 */
export function writeSourcesToFiles(fetchedSources, dir = DEFAULT_DIR) {
	mkdirSync(dir, { recursive: true });

	return fetchedSources.map((source) => {
		if (!source.content || source.content.length < 10) {
			// No content to write — keep as-is
			return source;
		}

		const safeId = String(source.id || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
		const urlSlug = (source.canonicalUrl || source.url || "")
			.replace(/^https?:\/\//, "")
			.replace(/[^a-zA-Z0-9]/g, "-")
			.slice(0, 40);
		const filename = `${safeId}-${urlSlug}.md`;
		const filepath = join(dir, filename);

		// Write full content to file
		const header = `---\nurl: ${source.finalUrl || source.url}\ntitle: ${source.title || ""}\nsource: ${source.source || "unknown"}\nstatus: ${source.status || ""}\nchars: ${source.contentChars || source.content.length}\n---\n\n`;
		writeFileSync(filepath, header + source.content, "utf8");

		// Return stripped object — content replaced by path
		const { content, ...rest } = source;
		return {
			...rest,
			contentPath: filepath,
			contentChars: source.contentChars || content.length,
		};
	});
}

// Shared CHANGELOG.md parsing/extraction helpers.
//
// The curated CHANGELOG section for a version is the source of truth for the
// GitHub release body. `changelog-extract.mjs` (release workflow),
// `changelog-release.mjs` (version-bump helper), and
// `backfill-github-releases.mjs` (retroactive release body sync) all use these
// pure helpers so parsing behavior stays identical.

const BRACKET_VERSION_HEADING = /^## \[([^\]]+)\]/;
const LEGACY_VERSION_HEADING = /^##\s+v?(\d+\.\d+\.\d+)\b/i;

function matchVersionHeading(line) {
	const bracket = line.match(BRACKET_VERSION_HEADING);
	if (bracket) return bracket[1].trim();
	const legacy = line.match(LEGACY_VERSION_HEADING);
	if (legacy) return legacy[1].trim();
	return null;
}

/**
 * Split CHANGELOG.md into ordered version sections.
 * Supports both current headings (`## [2.1.3] — 2026-06-21`) and legacy
 * headings (`## v1.8.5 (2026-04-29)`) so old GitHub releases can be backfilled.
 *
 * @param {string} text
 * @returns {Array<{ label: string, heading: string, body: string }>}
 */
export function parseSections(text) {
	const lines = text.split(/\r?\n/);
	const sections = [];
	let current = null;
	for (const line of lines) {
		const label = matchVersionHeading(line);
		if (label) {
			if (current) sections.push(finalize(current));
			current = { label, heading: line, bodyLines: [] };
			continue;
		}
		if (current) current.bodyLines.push(line);
	}
	if (current) sections.push(finalize(current));
	return sections;
}

function finalize(current) {
	return {
		label: current.label,
		heading: current.heading,
		body: current.bodyLines.join("\n").replace(/^\n+/, "").replace(/\s+$/, ""),
	};
}

/**
 * Condense a section into scannable GitHub release notes. Keeps headings and
 * top-level bullets, trims verbose bullets to their first sentence when useful,
 * and supports both `- **Title** — details` and plain legacy bullets.
 *
 * @param {string} body
 * @param {{ maxGist?: number }} [opts]
 * @returns {string}
 */
export function summarizeSection(body, opts = {}) {
	const maxGist = opts.maxGist ?? 160;
	const order = [];
	const buckets = new Map();
	let heading = null;
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trimEnd();
		const h = line.match(/^#{2,4}\s+(.*)$/);
		if (h) {
			heading = h[1].trim();
			if (!buckets.has(heading)) {
				buckets.set(heading, []);
				order.push(heading);
			}
			continue;
		}
		if (heading === null) continue;
		const bold = line.match(/^- (\*\*.+?\*\*)\s*(.*)$/);
		if (bold) {
			const gist = cleanGist(bold[2], maxGist);
			buckets.get(heading).push(gist ? `- ${bold[1]} — ${gist}` : `- ${bold[1]}`);
			continue;
		}
		const plain = line.match(/^-\s+(.+)$/);
		if (plain) buckets.get(heading).push(`- ${cleanPlainBullet(plain[1], maxGist)}`);
	}
	const out = [];
	for (const h of order) {
		const items = buckets.get(h);
		if (!items.length) continue;
		out.push(`### ${h}`, "", ...items, "");
	}
	return out.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
}

function cleanGist(rest, maxGist) {
	const text = rest
		.replace(/^\s*\((?:refs?|closes?|fixes?)?\s*#\d+\)\s*/i, "")
		.replace(/^\s*[—–:-]\s*/, "")
		.trim();
	if (!text) return "";
	return firstSentence(text, maxGist);
}

function cleanPlainBullet(text, maxGist) {
	return firstSentence(text.trim(), maxGist) || text.trim().slice(0, maxGist);
}

function firstSentence(text, maxGist) {
	const period = text.search(/\.\s/);
	const first = period >= 0 ? text.slice(0, period) : text;
	return first.length > 0 && first.length <= maxGist ? first : "";
}

export function normalizeVersion(version) {
	return String(version).trim().replace(/^v/i, "");
}

export function extractSection(text, version) {
	const want = normalizeVersion(version);
	const section = parseSections(text).find(
		(s) => normalizeVersion(s.label) === want,
	);
	return section ? section.body : null;
}

export function hasSection(text, version) {
	const body = extractSection(text, version);
	return typeof body === "string" && body.trim().length > 0;
}

export function unreleasedHasEntries(text) {
	const body = extractSection(text, "Unreleased");
	return body !== null && /^\s*[-*]\s/m.test(body);
}

const EMPTY_UNRELEASED = [
	"## [Unreleased]",
	"",
	"### Added",
	"",
	"### Changed",
	"",
	"### Fixed",
	"",
].join("\n");

export function promoteUnreleased(text, version, date) {
	if (extractSection(text, "Unreleased") === null) {
		throw new Error("No `## [Unreleased]` section found.");
	}
	if (!unreleasedHasEntries(text)) {
		throw new Error("`## [Unreleased]` has no entries to release.");
	}
	if (extractSection(text, version) !== null) {
		throw new Error(`CHANGELOG already has a section for ${version}.`);
	}

	const replaced = text.replace(
		/^## \[Unreleased\][^\n]*$/m,
		`${EMPTY_UNRELEASED}\n## [${version}] — ${date}`,
	);
	if (replaced === text) {
		throw new Error("Failed to locate the `## [Unreleased]` heading.");
	}
	return replaced;
}

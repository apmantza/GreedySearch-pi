#!/usr/bin/env node

// extractors/semantic-scholar.mjs
// Search Semantic Scholar without API keys and return paper/PDF sources for
// GreedySearch's source fetcher and research synthesizer.

import {
	buildEnvelope,
	cdp,
	formatAnswer,
	getOrOpenTab,
	handleError,
	logStage,
	outputJson,
	parseArgs,
	prepareArgs,
	validateQuery,
	waitForSelector,
} from "./common.mjs";

const USAGE =
	'Usage: node extractors/semantic-scholar.mjs "<query>" [--tab <prefix>]\n';
const RESULT_SELECTOR = ".cl-paper-row[data-paper-id]";

function semanticScholarSearchUrl(query) {
	// Semantic Scholar docs note hyphenated terms can reduce matches; use spaces.
	const normalized = String(query || "").replaceAll("-", " ");
	return `https://www.semanticscholar.org/search?q=${encodeURIComponent(normalized)}&sort=relevance`;
}

async function dismissCookieBanner(tab) {
	await cdp([
		"eval",
		tab,
		String.raw`
		(() => {
			const selectors = [
				'.osano-cm-dialog__close',
				'.osano-cm-denyAll',
				'.osano-cm-accept-all',
				'button[aria-label*="Close" i]',
			];
			for (const selector of selectors) {
				const btn = document.querySelector(selector);
				if (btn) { btn.click(); return selector; }
			}
			return null;
		})()
	`,
	]).catch(() => null);
}

async function extractPapers(tab, { limit = 8 } = {}) {
	const raw = await cdp([
		"eval",
		tab,
		String.raw`
		((limit) => {
			function clean(value) {
				return String(value || '').replace(/\s+/g, ' ').trim();
			}
			function absolutize(href) {
				try { return new URL(href, location.href).href; } catch { return ''; }
			}
			function isDirectPdf(url) {
				return /\.pdf(?:[?#]|$)/i.test(url) || /\/pdf\//i.test(url);
			}
			const rows = Array.from(document.querySelectorAll('.cl-paper-row[data-paper-id]')).slice(0, limit);
			return JSON.stringify(rows.map((row, index) => {
				const titleLink = row.querySelector('a[data-test-id="title-link"][href], a[href*="/paper/"][href]');
				const paperUrl = absolutize(titleLink?.getAttribute('href') || '');
				const title = clean(titleLink?.innerText || row.querySelector('.cl-paper-title')?.innerText || '');
				const authors = Array.from(row.querySelectorAll('[data-test-id="author-list"] a, .cl-paper-authors a'))
					.map((a) => clean(a.innerText))
					.filter(Boolean)
					.slice(0, 8);
				const field = clean(row.querySelector('.cl-paper-fos')?.innerText || '');
				const venue = clean(row.querySelector('[data-test-id="normalized-venue-link"], .cl-paper-venue')?.innerText || '');
				const date = clean(row.querySelector('.cl-paper-pubdates')?.innerText || '');
				const tldrNode = row.querySelector('.tldr-abstract-replacement');
				let tldr = clean(tldrNode?.innerText || '');
				tldr = tldr.replace(/^TLDR\s*/i, '').replace(/\s*Expand$/i, '').trim();
				const citationNode = row.querySelector('[data-test-id="total-citations-stat"]');
				const citationLabel = citationNode?.getAttribute('aria-label') || citationNode?.innerText || '';
				const citationMatch = clean(citationLabel).match(/[\d,]+/);
				const citationCount = citationMatch ? Number.parseInt(citationMatch[0].replace(/,/g, ''), 10) : null;
				const externalLinks = Array.from(row.querySelectorAll('a[data-test-id="paper-link"][href], a.cl-paper-view-paper[href]'))
					.map((a) => ({
						url: absolutize(a.getAttribute('href')),
						label: clean(a.innerText),
					}))
					.filter((link) => link.url);
				const directPdf = externalLinks.find((link) => isDirectPdf(link.url));
				const primaryExternal = directPdf || externalLinks[0] || null;
				const sourceUrl = primaryExternal?.url || paperUrl;
				return {
					rank: index + 1,
					paperId: row.getAttribute('data-paper-id') || '',
					title,
					url: sourceUrl,
					semanticScholarUrl: paperUrl,
					pdfUrl: directPdf?.url || '',
					externalUrl: primaryExternal?.url || '',
					externalLabel: primaryExternal?.label || '',
					authors,
					field,
					venue,
					date,
					tldr,
					citationCount,
				};
			}));
		})(${limit})
	`,
	]);
	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

function formatPaperSummary(papers) {
	if (!papers.length) return "Semantic Scholar returned no paper results.";
	return papers
		.map((paper) => {
			const parts = [];
			if (paper.authors?.length) parts.push(paper.authors.join(", "));
			if (paper.venue) parts.push(paper.venue);
			if (paper.date) parts.push(paper.date);
			if (Number.isFinite(paper.citationCount)) {
				parts.push(`${paper.citationCount.toLocaleString()} citations`);
			}
			const meta = parts.length ? ` — ${parts.join(" · ")}` : "";
			const tldr = paper.tldr ? `\n   TLDR: ${paper.tldr}` : "";
			return `${paper.rank}. ${paper.title}${meta}${tldr}`;
		})
		.join("\n\n");
}

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);
	const { query, tabPrefix, short } = parseArgs(args);
	const startTime = Date.now();
	const mode =
		process.env.GREEDY_SEARCH_VISIBLE === "1" ? "visible" : "headless";
	const env = {
		engine: "semantic-scholar",
		mode,
		blockedBy: null,
		verificationResult: null,
		inputReady: null,
	};

	try {
		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);
		logStage(env, "nav", startTime);
		await cdp(["nav", tab, semanticScholarSearchUrl(query)], 25000);
		await new Promise((r) => setTimeout(r, 800));

		logStage(env, "consent", startTime);
		await dismissCookieBanner(tab);

		logStage(env, "results-wait", startTime);
		const inputReady = await waitForSelector(tab, RESULT_SELECTOR, 15000, 500);
		env.inputReady = inputReady;
		if (!inputReady) {
			const body = await cdp([
				"eval",
				tab,
				"document.body?.innerText || ''",
			]).catch(() => "");
			if (/captcha|cloudflare|verify|robot|blocked/i.test(body)) {
				env.blockedBy = "verification";
				env.verificationResult = "needs-human";
				throw new Error(
					"Semantic Scholar verification required — please solve it in the visible browser window",
				);
			}
			throw new Error("Semantic Scholar results not found");
		}

		logStage(env, "extract", startTime);
		const papers = await extractPapers(tab, { limit: short ? 5 : 8 });
		const sources = papers
			.filter((paper) => paper.title && paper.url)
			.map((paper) => ({
				title: paper.pdfUrl ? `${paper.title} (PDF)` : paper.title,
				url: paper.url,
				semanticScholarUrl: paper.semanticScholarUrl,
				paperId: paper.paperId,
				citationCount: paper.citationCount,
				venue: paper.venue,
				year: paper.date,
			}));
		const answer = formatPaperSummary(papers);
		const durationMs = Date.now() - startTime;
		outputJson({
			answer: formatAnswer(answer, short),
			sources,
			query,
			url: semanticScholarSearchUrl(query),
			papers,
			_envelope: buildEnvelope({ ...env, durationMs }),
		});
	} catch (error) {
		handleError(
			error,
			buildEnvelope({
				...env,
				durationMs: Date.now() - startTime,
			}),
		);
	}
}

main();

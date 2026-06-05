#!/usr/bin/env node

// extractors/consensus.mjs
// Navigate consensus.app, submit query, extract research-grounded answer + paper sources.
//
// Usage:
//   node extractors/consensus.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { query, url, answer, sources }
// Errors go to stderr only — stdout is always clean JSON for piping.
//
// Language-agnostic: all DOM selectors target structure, data attributes, and
// URL fragments, never English text. The .CSV button text comes from a
// developer-set constant in the source (".CSV" with a leading period, not
// localized), the answer container uses the Tailwind "prose" class, and paper
// links are matched by their /papers/ URL fragment. Should work in any locale.

import {
	buildEnvelope,
	cdp,
	cdpWithInput,
	formatAnswer,
	getOrOpenTab,
	handleError,
	jitter,
	logStage,
	outputJson,
	parseArgs,
	prepareArgs,
	TIMING,
	validateQuery,
	waitForSelector,
} from "./common.mjs";
import { ensureChrome } from "../src/search/chrome.mjs";
import { dismissConsent } from "./consent.mjs";

// All structural selectors — no English text matching except for stable
// developer-set constants (CSV button text, Load more text) that are
// set in the source code and don't change with locale.
const SELECTORS = {
	input: 'textarea[name="newMessage"]',
	submitButton: 'button[aria-label="Submit search"]',
	// Tailwind Typography container — set by the developer's CSS framework,
	// not by user-facing text. The answer H1 is the only H1 inside this div.
	answerContainer: 'div[class*="prose"]',
	// Each paper card in the references list carries this data-testid.
	// Distinguishes top-level paper cards from inline citation links
	// (which are bare <a> elements without the testid).
	paperCard: 'a[data-testid="search-result"]',
	exportButton: 'button[aria-label="Export"]',
};

// ============================================================================
// Sign-in wall detection
// ============================================================================
//
// Anonymous Consensus searches get redirected to the sign-up flow. The
// redirect is structural (URL pattern), so detection works in any locale.
// The runner surfaces this as a "needs human verification" error so the
// user can sign in via the visible Chrome window. Once signed in, the
// session cookies persist in the GreedySearch Chrome profile for future
// headless runs.

async function detectSignUpWall(tab) {
	const code = `(() => {
		const url = document.location.href || '';
		return url.indexOf('/sign-up/') !== -1 || url.indexOf('redirect_url=') !== -1;
	})()`;
	const result = await cdp(["eval", tab, code]).catch(() => "false");
	return result === "true";
}

// ============================================================================
// Typing helper
// ============================================================================

async function typeIntoConsensus(tab, text) {
	// 1. Focus the input via click (more reliable than eval focus for textareas)
	await cdp(["click", tab, SELECTORS.input]);
	await new Promise((r) => setTimeout(r, jitter(200)));

	// 2. Type using CDP Input.insertText. Pass long queries through stdin so
	// Windows does not reject the cdp.mjs process spawn with ENAMETOOLONG.
	await cdpWithInput(["type", tab, "--stdin"], text);
	await new Promise((r) => setTimeout(r, jitter(300)));

	// 3. Verify the text was actually inserted
	const inserted = await cdp([
		"eval",
		tab,
		`(document.querySelector('${SELECTORS.input}')?.value || '').length >= ${Math.floor(text.length * 0.8)}`,
	]);
	if (inserted !== "true") {
		throw new Error(
			"Consensus input did not accept text — input verification failed",
		);
	}
}

// ============================================================================
// XHR interceptor for /api/papers/details/
// ============================================================================
//
// The "Export → .CSV" button in Consensus's UI fetches paper details from
// /api/papers/details/ (a POST returning JSON) and converts them to CSV
// client-side. We intercept that POST response directly via an XHR
// monkey-patch, avoiding the file-download dance. The response carries
// rich metadata: title, authors, year, journal, doi, citation_count,
// abstract_takeaway, badges, open_access_pdf_url, etc. — much more than
// the DOM cards expose.
//
// We don't capture Load More responses: those are partial-page fetches.
// We only capture the .CSV response, which (after Load More has expanded
// the list) contains the full set of references for the query.

async function installPapersDetailsInterceptor(tab) {
	const code = `(() => {
		if (window.__pdiInstalled) return 'already';
		window.__pdiInstalled = true;
		const _origOpen = XMLHttpRequest.prototype.open;
		const _origSend = XMLHttpRequest.prototype.send;
		XMLHttpRequest.prototype.open = function(method, url) {
			this.__url = String(url);
			return _origOpen.apply(this, arguments);
		};
		XMLHttpRequest.prototype.send = function(body) {
			if (this.__url && this.__url.indexOf('/api/papers/details') !== -1) {
				this.addEventListener('load', function() {
					if (this.status === 200) {
						try {
							const parsed = JSON.parse(this.responseText);
							// Stack responses: the last one wins (the .CSV
							// request fires after Load More has settled).
							window.__papersDetailsResps = window.__papersDetailsResps || [];
							window.__papersDetailsResps.push({
								at: Date.now(),
								count: Object.keys(parsed?.paperDetailsListByPaperId || {}).length,
								data: parsed,
							});
						} catch (e) {
							window.__papersDetailsErrors = window.__papersDetailsErrors || [];
							window.__papersDetailsErrors.push(String(e.message || e));
						}
					}
				});
			}
			return _origSend.apply(this, arguments);
		};
		return 'installed';
	})()`;
	const r = await cdp(["eval", tab, code]);
	return r === "installed" || r === "already";
}

async function fetchPapersDetailsResponse(tab, timeoutMs = 10000) {
	// Single-eval poll for the captured /api/papers/details/ response. We
	// wait for a response to land and then return the latest one. The
	// timeout covers the worst case where the .CSV click never triggers
	// the request (e.g., signed-out user, the button is gated).
	const code = `new Promise((resolve) => {
		const _deadline = Date.now() + ${timeoutMs};
		function _check() {
			const resps = window.__papersDetailsResps || [];
			if (resps.length > 0) {
				const last = resps[resps.length - 1];
				resolve(JSON.stringify({ ok: true, count: last.count, data: last.data }));
				return;
			}
			if (Date.now() < _deadline) {
				setTimeout(_check, 200);
			} else {
				resolve(JSON.stringify({ ok: false, reason: 'timeout' }));
			}
		}
		_check();
	})`;
	const result = await cdp(["eval", tab, code], timeoutMs + 5000);
	return JSON.parse(result);
}

// ============================================================================
// Load More — wait for all references to be fetched
// ============================================================================
//
// Consensus streams the answer in two phases:
//   1. The prose summary appears first.
//   2. The references list loads after a brief pause, then "Load more results"
//      fetches subsequent pages of papers.
// We click Load More until it disappears, then wait briefly for the last
// batch to settle before clicking Export → .CSV.

async function expandReferences(tab, maxClicks = 8) {
	// First, wait for the references section to render — the initial 20
	// paper cards need to appear before we can click Load More. Without
	// this gate, expandReferences often runs before the button is in the
	// DOM, the loop exits on first check, and the .CSV click only fetches
	// the partial 20-paper set instead of the full result list.
	const ready = await waitForSelector(
		tab,
		SELECTORS.paperCard,
		20000,
		500,
	).catch(() => false);
	if (!ready) {
		console.error(
			"[consensus] Warning: no paper cards appeared within 20s — Load More will be skipped",
		);
		return 0;
	}
	// Brief settle so the Load More button has time to mount after the
	// initial 20 cards render.
	await new Promise((r) => setTimeout(r, 800));

	let clicks = 0;
	for (let i = 0; i < maxClicks; i++) {
		// Find the Load more button by its visible text. The text is
		// "Load more results" in English UI; for non-English the structure
		// is the same primary button below the paper list. Some pages
		// also use a sidebar of references — same selector works because
		// we query globally.
		const hasMore = await cdp([
			"eval",
			tab,
			`(() => {
				const btns = Array.from(document.querySelectorAll('button'));
				return btns.some(b => {
					const t = (b.innerText || '').trim();
					return /load more/i.test(t) || /more results/i.test(t) || /show more/i.test(t);
				});
			})()`,
		]);
		if (hasMore !== "true") break;
		await cdp([
			"eval",
			tab,
			`(() => {
				const btns = Array.from(document.querySelectorAll('button'));
				const btn = btns.find(b => {
					const t = (b.innerText || '').trim();
					return /load more/i.test(t) || /more results/i.test(t) || /show more/i.test(t);
				});
				btn?.click();
				return 'clicked';
			})()`,
		]);
		clicks++;
		// 1.5s between clicks: each batch needs time to render.
		await new Promise((r) => setTimeout(r, 1500));
	}
	return clicks;
}

// ============================================================================
// CSV download via .CSV button → /api/papers/details/ interception
// ============================================================================

async function clickExportCsv(tab) {
	// Open the Export menu. The button is aria-label="Export" and lives
	// in the page header; clicking it reveals a dropdown with the .CSV
	// option. We scroll the button into view first to avoid stale-layout
	// issues when the references list pushes it off-screen.
	await cdp([
		"eval",
		tab,
		`(() => {
			const btn = document.querySelector('${SELECTORS.exportButton}');
			if (!btn) return 'no-export';
			btn.scrollIntoView({ block: 'center' });
			btn.click();
			return 'opened';
		})()`,
	]);
	// 600ms for the dropdown animation/portal to mount.
	await new Promise((r) => setTimeout(r, 600));
	// Click the .CSV option. The button text is the developer-set
	// constant ".CSV" followed by "\n\nExcel, Numbers, Sheets" — the
	// leading period is part of the source-code string, not localized.
	const clicked = await cdp([
		"eval",
		tab,
		`(() => {
			const btn = Array.from(document.querySelectorAll('button'))
				.find(b => /\\.CSV/.test((b.innerText || '').trim()));
			if (!btn) return 'no-csv';
			btn.click();
			return 'clicked';
		})()`,
	]);
	return clicked;
}

// ============================================================================
// Build sources from the API response
// ============================================================================

function buildSourcesFromApi(respData) {
	const map = respData?.paperDetailsListByPaperId || {};
	const ids = Object.keys(map);
	const sources = [];
	for (let i = 0; i < ids.length; i++) {
		const p = map[ids[i]] || {};
		const urlSlug = p.url_slug || "";
		const paperId = p.paper_id || p.hash_paper_id || ids[i];
		// DOM uses /papers/{url_slug}/{paperId_short}/ — paperId is the
		// hash. We construct the consensus.app detail page URL. If we
		// don't have url_slug, fall back to a search-by-id URL.
		let url;
		if (urlSlug) {
			url = `https://consensus.app/papers/${urlSlug}/${paperId}/`;
		} else if (p.provider_url) {
			url = p.provider_url;
		} else if (p.doi) {
			url = `https://doi.org/${p.doi}`;
		} else {
			url = `https://consensus.app/paper/${paperId}`;
		}
		const tags = [];
		const badges = p.badges || {};
		if (badges.study_type === "rct") tags.push("RCT");
		else if (badges.study_type === "meta_analysis") tags.push("META-ANALYSIS");
		else if (badges.study_type === "systematic_review")
			tags.push("SYSTEMATIC REVIEW");
		else if (badges.study_type) tags.push(badges.study_type.toUpperCase());
		if (badges.rigorous_journal) tags.push("RIGOROUS JOURNAL");
		if (badges.very_rigorous_journal) tags.push("VERY RIGOROUS JOURNAL");
		if (badges.highly_cited_paper) tags.push("HIGHLY CITED");
		if (badges.large_human_trial) tags.push("LARGE HUMAN TRIAL");
		if (p.is_retracted) tags.push("RETRACTED");
		if (p.open_access_pdf_url) tags.push("OPEN ACCESS");

		sources.push({
			title: p.title || "",
			url,
			rank: i + 1,
			authors: Array.isArray(p.authors) ? p.authors : [],
			year: p.year || null,
			journal: p.journal || p.publisher_name || null,
			doi: p.doi || null,
			citation_count: p.citation_count || 0,
			snippet: p.abstract_takeaway || "",
			tags,
		});
	}
	return sources;
}

// ============================================================================
// DOM fallback for sources
// ============================================================================

async function extractSourcesFromDom(tab) {
	const code = `(() => {
		const cards = Array.from(document.querySelectorAll('${SELECTORS.paperCard}'));
		const sources = [];
		const seen = new Set();
		for (const card of cards) {
			const url = card.href || '';
			if (!url || seen.has(url)) continue;
			seen.add(url);
			const rankText = card.querySelector('span[data-testid="tag"]')?.innerText?.trim() || '';
			const rank = parseInt(rankText, 10) || null;
			const title = (card.querySelector('h2')?.innerText || '').trim();
			// Key takeaway: the span after the "KEY TAKEAWAY" label
			const takeawaySpan = card.querySelector('span.sm-normal');
			const snippet = takeawaySpan
				? takeawaySpan.innerText.replace(/^KEY TAKEAWAY\\s*[·\\-]\\s*/i, '').trim()
				: '';
			// Tags: collect chip text from meta-analysis-tag, journal tags, etc.
			const tags = Array.from(card.querySelectorAll('span[data-testid$="-tag"]'))
				.map(t => t.innerText?.trim())
				.filter(Boolean);
			sources.push({ title, url, rank, snippet, tags });
		}
		return JSON.stringify(sources);
	})()`;
	const result = await cdp(["eval", tab, code], 10000);
	return JSON.parse(result);
}

// ============================================================================
// Answer extraction
// ============================================================================

async function extractAnswer(tab) {
	const code = `(() => {
		const prose = document.querySelector('${SELECTORS.answerContainer}');
		return prose?.innerText?.trim() || '';
	})()`;
	return (await cdp(["eval", tab, code], 10000)) || "";
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/consensus.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);
	const startTime = Date.now();
	const mode =
		process.env.GREEDY_SEARCH_VISIBLE === "1" ? "visible" : "headless";

	const env = {
		engine: "consensus",
		mode,
		clipboardEmpty: null,
		fallbackUsed: null,
		blockedBy: null,
		verificationResult: null,
		inputReady: null,
	};

	try {
		// Default to headless unless the caller explicitly set visible mode.
		if (
			process.env.GREEDY_SEARCH_VISIBLE !== "1" &&
			process.env.GREEDY_SEARCH_ALWAYS_VISIBLE !== "1"
		) {
			process.env.GREEDY_SEARCH_HEADLESS = "1";
		}
		await ensureChrome();

		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Skip navigation if tab was pre-seeded to consensus.app
		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		let onConsensus = false;
		try {
			const host = new URL(currentUrl).hostname.toLowerCase();
			onConsensus = host === "consensus.app" || host.endsWith(".consensus.app");
		} catch {}

		if (!onConsensus) {
			logStage(env, "nav", startTime);
			await cdp(["nav", tab, "https://consensus.app/"], 20000);
			await new Promise((r) => setTimeout(r, 600));
		}
		await dismissConsent(tab, cdp);
		// Skip handleVerification: consensus.app has no Cloudflare/Turnstile
		// challenge, but the verify detector matches "human" inside suggested-
		// search chip text and false-positives into clicking a different query.
		// Anonymous users hit the /sign-up/ wall which we detect explicitly
		// after submit.

		logStage(env, "input-wait", startTime);
		const inputReady = await waitForSelector(tab, SELECTORS.input, 15000, 400);
		env.inputReady = inputReady;
		if (!inputReady) {
			throw new Error(
				"Consensus input not found — page may not have loaded or is in unexpected state",
			);
		}
		await new Promise((r) => setTimeout(r, jitter(TIMING.postClick)));

		logStage(env, "type-and-submit", startTime);
		await typeIntoConsensus(tab, query);
		await new Promise((r) => setTimeout(r, jitter(TIMING.postType)));
		await cdp([
			"eval",
			tab,
			`document.querySelector('${SELECTORS.submitButton}')?.click()`,
		]);

		// Fast-fail if Consensus redirected to the sign-up wall. The page
		// navigates from / to /search/.../.../ for a signed-in user, but
		// anonymous users get bounced to /sign-up/?redirect_url=... We check
		// after a short settle so the URL has time to update.
		await new Promise((r) => setTimeout(r, 2000));
		if (await detectSignUpWall(tab)) {
			env.blockedBy = "signin";
			throw new Error(
				"Consensus requires sign-in — please sign in or create a free account in the visible browser window. Once signed in, cookies persist for future runs.",
			);
		}

		logStage(env, "answer-wait", startTime);
		await waitForSelector(tab, SELECTORS.answerContainer, 30000, 500);

		// Install the XHR interceptor BEFORE Load More clicks. Each Load
		// More triggers its own /api/papers/details/ call (partial page).
		// We capture every response and pick the largest one (which is the
		// .CSV response after Load More has settled and the full list is
		// in scope). This also covers the corner case where the user has
		// fewer than 20 papers — .CSV still works on whatever is visible.
		await installPapersDetailsInterceptor(tab);

		logStage(env, "expand-refs", startTime);
		const clicks = await expandReferences(tab, 8);
		if (clicks === 0) {
			console.error(
				"[consensus] Note: 'Load more results' button not present (initial page has all references)",
			);
		} else {
			console.error(
				`[consensus] Clicked 'Load more results' ${clicks} time(s) to expand references`,
			);
		}
		// Brief settle for the last batch to render fully.
		await new Promise((r) => setTimeout(r, 1500));

		logStage(env, "csv-click", startTime);
		const csvResult = await clickExportCsv(tab);
		if (csvResult !== "clicked") {
			console.error(
				`[consensus] Export → .CSV click did not register (${csvResult}) — falling back to DOM`,
			);
		}

		logStage(env, "wait-csv-resp", startTime);
		const csvResp = await fetchPapersDetailsResponse(tab, 12000);
		let sources = [];
		let sourcePath = "dom";
		if (csvResp.ok) {
			sources = buildSourcesFromApi(csvResp.data);
			sourcePath = "api-intercept";
			console.error(
				`[consensus] Captured /api/papers/details/ response with ${csvResp.count} paper(s)`,
			);
		} else {
			console.error(
				`[consensus] /api/papers/details/ response not captured (${csvResp.reason}) — falling back to DOM cards`,
			);
		}

		logStage(env, "extract", startTime);
		const answer = await extractAnswer(tab);
		if (!answer) {
			throw new Error("No answer extracted — Consensus may not have responded");
		}

		// DOM fallback: if the API interception didn't yield sources (or
		// yielded very few compared to the visible cards), top up from
		// the DOM so we don't lose data.
		if (sources.length === 0) {
			sources = await extractSourcesFromDom(tab);
		} else {
			// Top-up from DOM only for cards we don't already have via API
			// (defensive — shouldn't happen in normal flow).
			const domSources = await extractSourcesFromDom(tab);
			const apiUrls = new Set(sources.map((s) => s.url));
			for (const ds of domSources) {
				if (!apiUrls.has(ds.url)) sources.push(ds);
			}
		}

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		env.durationMs = Date.now() - startTime;
		env.sourcePath = sourcePath;
		logStage(env, "done", startTime);

		outputJson({
			query,
			url: finalUrl,
			answer: formatAnswer(answer, short),
			sources,
			_envelope: buildEnvelope(env),
		});
	} catch (e) {
		env.durationMs = Date.now() - startTime;
		handleError(e, buildEnvelope(env));
	}
}

main();

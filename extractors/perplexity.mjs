#!/usr/bin/env node

// extractors/perplexity.mjs
// Navigate Perplexity, wait for streaming to complete, return clean answer + sources.
//
// Usage:
//   node extractors/perplexity.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.
//
// TODO: Refactor - this file has 42 lines duplicated with google-ai.mjs (line 28)

import {
	buildEnvelope,
	cdp,
	formatAnswer,
	getOrOpenTab,
	handleError,
	injectClipboardInterceptor,
	jitter,
	outputJson,
	parseArgs,
	parseSourcesFromMarkdown,
	prepareArgs,
	TIMING,
	validateQuery,
	waitForSelector,
	waitForStreamComplete,
} from "./common.mjs";
import { dismissConsent, handleVerification } from "./consent.mjs";
import { SELECTORS } from "./selectors.mjs";

const S = SELECTORS.perplexity;
const GLOBAL_VAR = "__pplxClipboard";

// ============================================================================
// Language-agnostic copy button finder
// ============================================================================

function findCopyButtonJsExpression() {
	// Perplexity uses SVG icons via <use xlink:href="#pplx-icon-copy">
	// This works across all locales since it doesn't depend on aria-label text
	// Use .pop() to get the last matching button (the answer copy button),
	// not the first one which is the question copy button
	return `Array.from(document.querySelectorAll('button')).filter(b => b.innerHTML.includes('#pplx-icon-copy')).pop()`;
}

// ============================================================================
// DOM fallback — read answer + sources when clipboard interceptor fails
// ============================================================================

async function extractAnswerFromDom(tab, env) {
	// Heuristic for what counts as a real answer text (not a header stub
	// like "Next.jsReactNext.js"): either substantial (>50 chars) or a
	// short factual answer (>=5 chars and contains a word boundary or
	// punctuation — i.e. it's a word/phrase, not a concatenated string).
	function _looksLikeAnswerText(text) {
		const t = (text || "").trim();
		if (t.length > 50) return true;
		return t.length >= 5 && /\s|[.,!?;:]/.test(t);
	}

	// First wait for the page to navigate to a search results URL (perplexity.ai/search/...)
	// The homepage has a sidebar with nav items that would be falsely picked up as the answer.
	const navResult = await cdp(
		[
			"eval",
			tab,
			`new Promise((resolve) => {
				const _deadline = Date.now() + 8000;
				function _checkNav() {
					const url = document.location.href;
					if (url.includes('/search/') || url.includes('/thread/') || url.match(/perplexity.ai\\/[^/]+/)) {
						resolve('navigated');
					} else if (Date.now() < _deadline) {
						setTimeout(_checkNav, 300);
					} else {
						resolve('timeout');
					}
				}
				_checkNav();
			})`,
		],
		10000,
	).catch(() => "timeout");

	if (navResult === "timeout") {
		// Page never navigated to a search URL — answer extraction will be unreliable
		return null;
	}

	// Perplexity renders the answer in a prose container after the user message.
	// First wait for the answer to actually appear (up to 5s), then extract it.
	// Note: the looksLikeAnswerText helper is inlined into the browser-side
	// eval string below (it can't reference a Node-side function via template).
	const domExtract = await cdp(
		[
			"eval",
			tab,
			`new Promise((resolve) => {
				const _deadline = Date.now() + 5000;
				function _looksLikeAnswerText(text) {
					const t = (text || '').trim();
					if (t.length > 50) return true;
					return t.length >= 5 && /\\s|[.,!?;:]/.test(t);
				}
				function _tryExtract() {
					try {
						// Strategy 1: Find .prose block that's NOT the question
						// and NOT in the sidebar/nav. The answer is the last .prose
						// that contains substantial text and is in the main content area.
						const proseBlocks = Array.from(document.querySelectorAll('.prose, [class*="prose"]'));
						const candidates = proseBlocks.filter(el => {
							const text = el.innerText?.trim() || '';
							if (!_looksLikeAnswerText(text)) return false;
							// Exclude sidebar/nav (they're usually in <nav> or <aside> or have specific classes)
							if (el.closest('nav, aside, [role="navigation"], [class*="sidebar"], [class*="nav-"]')) return false;
							return true;
						});
						if (candidates.length > 0) {
							const last = candidates[candidates.length - 1];
							return resolve(JSON.stringify({ answer: last.innerText.trim(), method: 'prose' }));
						}

						// Strategy 2: Look for the answer container by data attributes
						// Perplexity uses [data-testid*="answer"] or [class*="answer-content"]
						const answerContainer = document.querySelector('[data-testid*="answer"], [class*="answer-content"], [class*="response-content"]');
						if (answerContainer && _looksLikeAnswerText(answerContainer.innerText?.trim())) {
							return resolve(JSON.stringify({ answer: answerContainer.innerText.trim(), method: 'answer-container' }));
						}

						// Strategy 3: Find the largest text block in the main content area
						// (not in nav/aside/sidebar), positioned after the input.
						const input = document.querySelector('${S.input}');
						if (!input) return resolve(null);
						const inputRect = input.getBoundingClientRect();
						const main = document.querySelector('main, [role="main"], [class*="main-content"]') || document.body;
						const blocks = Array.from(main.querySelectorAll('div, article, section'))
							.filter(d => {
								const r = d.getBoundingClientRect();
								if (r.top <= inputRect.bottom) return false; // not below input
								if (r.width === 0 || r.height === 0) return false; // not visible
								if (d.closest('nav, aside, [role="navigation"], [class*="sidebar"]')) return false; // not in nav
								const text = d.innerText?.trim() || '';
								return _looksLikeAnswerText(text) && d.children.length < 20;
							})
							.sort((a, b) => (b.innerText?.length || 0) - (a.innerText?.length || 0));
						if (blocks.length > 0) {
							return resolve(JSON.stringify({ answer: blocks[0].innerText.trim(), method: 'main-content' }));
						}

						// Retry if we haven't found anything yet
						if (Date.now() < _deadline) {
							setTimeout(_tryExtract, 400);
						} else {
							resolve(null);
						}
					} catch(e) { resolve(null); }
				}
				_tryExtract();
			})`,
		],
		8000,
	).catch(() => null);

	if (!domExtract || domExtract === "null") return null;

	try {
		const { answer, method } = JSON.parse(domExtract);
		if (answer && _looksLikeAnswerText(answer)) {
			env.fallbackUsed = `dom:${method}`;
			env.clipboardEmpty = true;
			// Try to extract sources from links near the answer
			const sourcesExtract = await cdp(
				[
					"eval",
					tab,
					`(() => {
						const links = Array.from(document.querySelectorAll('a[href^="https://"]'))
							.filter(a => {
								const href = a.href || '';
								return !href.includes('perplexity.ai') && !href.includes('google.com') && !href.includes('gstatic');
							})
							.slice(0, 10)
							.map(a => ({ title: a.innerText?.trim() || a.href, url: a.href }));
						return JSON.stringify(links);
					})()`,
				],
				3000,
			).catch(() => "[]");
			let sources = [];
			try {
				sources = JSON.parse(sourcesExtract || "[]");
			} catch {}
			return { answer, sources };
		}
	} catch {}
	return null;
}

// ============================================================================
// Extraction
// ============================================================================

async function extractAnswer(tab, env) {
	const copyBtnExpr = findCopyButtonJsExpression();

	await cdp(["eval", tab, `${copyBtnExpr}?.click()`]);
	await new Promise((r) => setTimeout(r, 400));

	let answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
	env.clipboardEmpty = !answer;

	// Retry once if clipboard is empty (Perplexity might be slow to write)
	if (!answer) {
		console.error("[perplexity] Clipboard empty, retrying in 2s...");
		await cdp(["eval", tab, `${copyBtnExpr}?.click()`]);
		await new Promise((r) => setTimeout(r, 2000));
		answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
		env.clipboardEmpty = !answer;
	}

	// Reject suspicious answers: the user's query echoed back, or a copy
	// button click that landed on the question (not the answer) copy
	// button. Both manifest as a clipboard write that contains the query
	// text — the old path treated it as a valid answer and the synthesis
	// would silently include a paraphrased-query result.
	if (env.query && answer) {
		const queryNorm = env.query.toLowerCase().trim();
		const answerNorm = answer.toLowerCase().trim();
		if (
			answerNorm === queryNorm ||
			answer.trim().length < Math.max(20, queryNorm.length * 0.5)
		) {
			console.error(
				`[perplexity] Clipboard contains query echo or stub (${answer.length} chars), retrying with longer wait...`,
			);
			env.clipboardEmpty = true;
			answer = "";
		}
	}

	// DOM fallback: when clipboard interception fails (intermittent in headless),
	// read the answer from the page DOM instead of triggering visible recovery.
	if (!answer) {
		console.error("[perplexity] Clipboard empty — trying DOM fallback...");
		const domResult = await extractAnswerFromDom(tab, env);
		if (domResult) {
			console.error(
				`[perplexity] DOM fallback succeeded (${env.fallbackUsed})`,
			);
			return domResult;
		}
		throw new Error("Clipboard interceptor returned empty text");
	}

	const sources = parseSourcesFromMarkdown(answer);
	return { answer: answer.trim(), sources };
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/perplexity.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);
	const startTime = Date.now();
	const mode =
		process.env.GREEDY_SEARCH_VISIBLE === "1" ? "visible" : "headless";

	const env = {
		engine: "perplexity",
		mode,
		clipboardEmpty: null,
		fallbackUsed: null,
		blockedBy: null,
		verificationResult: null,
		inputReady: null,
		// Carry the original query into extractAnswer so it can reject
		// answers that look like query-echo (a copy button click on the
		// question's icon instead of the answer's) without needing to
		// thread query through every helper.
		query,
	};

	try {
		// Only refresh page list when creating a fresh tab (no prefix provided)
		if (!tabPrefix) await cdp(["list"]);

		const tab = await getOrOpenTab(tabPrefix);

		// Skip navigation if already on Perplexity domain (tab was seeded by search.mjs)
		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		let onPerplexity = false;
		try {
			const host = new URL(currentUrl).hostname.toLowerCase();
			onPerplexity =
				host === "perplexity.ai" || host.endsWith(".perplexity.ai");
		} catch {}

		if (!onPerplexity) {
			await cdp(["nav", tab, "https://www.perplexity.ai/"], 20000);
			// Wait for the React app to hydrate and make the input visible.
			// In all-mode under CDP contention, the input element exists but
			// its first 5 parent DIVs have visibility:hidden — focus()
			// silently fails. Force the parents to visibility:visible, then
			// poll up to 15s for the input to be focusable.
			const _inputReady = await cdp(
				[
					"eval",
					tab,
					`new Promise((resolve) => {
						const _deadline = Date.now() + 15000;
						function _check() {
							const input = document.querySelector('${S.input}');
							if (input) {
								// Force visibility on all parents up to body —
								// Perplexity hides the first 5 wrapper DIVs until
								// the user interacts with the page
								let el = input;
								while (el && el !== document.body) {
									if (window.getComputedStyle(el).visibility === 'hidden') {
										el.style.visibility = 'visible';
									}
									el = el.parentElement;
								}
								input.focus();
								if (document.activeElement === input) return resolve('ready');
							}
							if (Date.now() < _deadline) setTimeout(_check, 500);
							else resolve('timeout');
						}
						_check();
					})`,
				],
				18000,
			).catch(() => "timeout");
			if (_inputReady !== "ready") {
				// Retry navigation up to 2 more times — the first nav may have
				// been preempted by CDP contention in all-mode
				for (let retry = 0; retry < 2; retry++) {
					await cdp(["nav", tab, "https://www.perplexity.ai/"], 20000);
					await new Promise((r) => setTimeout(r, 2000));
					const _retryReady = await cdp(
						[
							"eval",
							tab,
							`(() => {
								const input = document.querySelector('${S.input}');
								if (!input) return false;
								let el = input;
								while (el && el !== document.body) {
									if (window.getComputedStyle(el).visibility === 'hidden') {
										el.style.visibility = 'visible';
									}
									el = el.parentElement;
								}
								input.focus();
								return document.activeElement === input;
							})()`,
						],
						5000,
					).catch(() => false);
					if (_retryReady === "true") break;
				}
			} else {
				await new Promise((r) => setTimeout(r, 600));
			}
		}
		// Handle verification challenges (Cloudflare Turnstile, etc.)
		const verifyResult = await handleVerification(tab, cdp, 10000);
		env.verificationResult = verifyResult;
		if (verifyResult === "needs-human") {
			throw new Error(
				"Perplexity verification required — please solve it manually in the browser window",
			);
		}
		await dismissConsent(tab, cdp);

		// After verification, page may have redirected — wait for it to settle
		// then re-navigate to homepage if we ended up somewhere else.
		if (verifyResult === "clicked") {
			await new Promise((r) => setTimeout(r, TIMING.afterVerify));
			const postVerifyUrl = await cdp([
				"eval",
				tab,
				"document.location.href",
			]).catch(() => "");
			let onPerplexityAfter = false;
			try {
				const host = new URL(postVerifyUrl).hostname.toLowerCase();
				onPerplexityAfter =
					host === "perplexity.ai" || host.endsWith(".perplexity.ai");
			} catch {}
			if (!onPerplexityAfter) {
				await cdp(["nav", tab, "https://www.perplexity.ai/"], 20000);
				await new Promise((r) => setTimeout(r, 800));
				await dismissConsent(tab, cdp);
			}
		}

		// Wait for React app to mount input (up to 15s — gives CF redirect + hydration time)
		// Note: we no longer fast-fail on Cloudflare detection here because the
		// new CDP-pierce + browser-level-click path in handleVerification can
		// auto-clear the Turnstile checkbox from a fresh headless session. The
		// downstream handleVerification() call will either click through or
		// surface needs-human; let it run.
		const inputReady = await waitForSelector(tab, S.input, 15000, 400);
		env.inputReady = inputReady;

		if (!inputReady) {
			throw new Error(
				"Perplexity input not found — page may not have loaded or is in unexpected state",
			);
		}

		await new Promise((r) => setTimeout(r, jitter(300)));

		await injectClipboardInterceptor(tab, GLOBAL_VAR);
		await cdp(["click", tab, S.input]);
		await new Promise((r) => setTimeout(r, jitter(400)));

		// Type via execCommand + focus. This triggers React's onChange
		// (via the synthetic input event) in a way that Input.insertText
		// cannot — Input.insertText sends raw text but doesn't dispatch
		// the events that React's controlled-input system listens for.
		// Causes the query to not register in all-mode under CDP contention.
		// Retry up to 3 times — execCommand can fail if the input isn't
		// fully focused yet (common under CDP contention in all-mode).
		let typeResult;
		for (let attempt = 0; attempt < 3; attempt++) {
			typeResult = await cdp(
				[
					"eval",
					tab,
					`(() => {
						try {
							const input = document.querySelector('${S.input}');
							if (!input) return 'no-input';
							input.focus();
							if (document.activeElement !== input) {
								const activeTag = document.activeElement?.tagName || 'none';
								const activeClass = (document.activeElement?.className || '').slice(0, 80);
								return 'not-focused:active=' + activeTag + '.' + activeClass;
							}
							// execCommand('insertText') dispatches the proper input
							// event that React's onChange listens for
							const ok = document.execCommand('insertText', false, ${JSON.stringify(query)});
							return ok ? 'ok' : 'exec-failed';
						} catch (e) { return 'err:' + e.message; }
					})()`,
				],
				5000,
			);
			if (typeResult === "ok") break;
			// On not-focused, try clicking the input first to force focus
			if (String(typeResult).startsWith("not-focused")) {
				await cdp(["click", tab, S.input]).catch(() => {});
			}
			await new Promise((r) => setTimeout(r, 800));
		}
		if (typeResult !== "ok") {
			throw new Error(`Perplexity type failed: ${typeResult}`);
		}
		await new Promise((r) => setTimeout(r, jitter(400)));

		// Submit with Enter — use a real KeyboardEvent on the input so React's
		// keydown handler fires. keyCode:13 is needed for compatibility.
		await cdp([
			"eval",
			tab,
			`(() => {
				const input = document.querySelector('${S.input}');
				if (!input) return 'no-input';
				input.focus();
				const ev = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true });
				input.dispatchEvent(ev);
				return 'ok';
			})()`,
		]);

		await waitForStreamComplete(tab, {
			timeout: 20000,
			interval: 600,
			stableRounds: 5,
			minLength: 50,
			selector: "document.body",
		});

		// Detect Perplexity's free-search-limit wall. Shown as a [dialog]
		// in the accessibility tree after hitting the rate limit. The wall
		// text is localized (Greek, English, etc.) so we detect the
		// structural [dialog] marker combined with the Upgrade button
		// (αναβάθμιση/upgrade/Pro). Visible-mode cookies can't bypass
		// this — it's account-level, not session-level.
		if (process.env.GREEDY_SEARCH_HEADLESS === "1") {
			const postSnap = await cdp(["snap", tab]).catch(() => "");
			// [dialog] + upgrade-related button + no answer prose = rate-limit wall
			if (
				/\[dialog\]/i.test(postSnap) &&
				/Pro|αναβάθμιση|upgrade/i.test(postSnap) &&
				!/\.prose|\[article\]/i.test(postSnap)
			) {
				console.error(
					"[perplexity] Rate Limited — skipping (visible retry won't help)",
				);
				env.blockedBy = "rate-limit";
				throw new Error(
					"Rate Limited — Perplexity free search limit reached. Wait a few hours.",
				);
			}
		}

		const { answer, sources } = await extractAnswer(tab, env);

		if (!answer)
			throw new Error(
				"No answer extracted — Perplexity may not have responded",
			);

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		env.durationMs = Date.now() - startTime;
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

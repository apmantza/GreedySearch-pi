#!/usr/bin/env node

// extractors/gemini.mjs
// Navigate gemini.google.com/app, submit query, wait for answer, return clean answer + sources.
//
// Usage:
//   node extractors/gemini.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.

import {
	cdp,
	cdpWithInput,
	clickCopyAndAwaitClipboard,
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
import { ensureChrome } from "../src/search/chrome.mjs";
import { dismissConsent, handleVerification } from "./consent.mjs";
import { SELECTORS } from "./selectors.mjs";

const S = SELECTORS.gemini;
const GLOBAL_VAR = "__geminiClipboard";

// ============================================================================
// Gemini-specific helpers
// ============================================================================

async function typeIntoGemini(tab, text) {
	// 1. Focus the input area via click (more reliable than eval focus for shadow-DOM editors)
	await cdp(["click", tab, S.input]);
	await new Promise((r) => setTimeout(r, jitter(200)));

	// 2. Type using CDP Input.insertText (more reliable than document.execCommand).
	// Pass long research prompts through stdin so Windows does not reject the
	// cdp.mjs process spawn with ENAMETOOLONG.
	await cdpWithInput(["type", tab, "--stdin"], text);
	await new Promise((r) => setTimeout(r, jitter(300)));

	// 3. Verify the text was actually inserted
	const inserted = await cdp([
		"eval",
		tab,
		`(function() {
			var el = document.querySelector('${S.input}');
			if (!el) return false;
			var content = el.innerText || el.textContent || '';
			return content.trim().length >= ${Math.floor(text.length * 0.8)};
		})()`,
	]);
	if (inserted !== "true") {
		throw new Error(
			"Gemini input field did not accept text — input verification failed",
		);
	}
}

async function bringToFront(tab, { required = false } = {}) {
	try {
		await cdp(["evalraw", tab, "Page.bringToFront", "{}"], 5000);
		return true;
	} catch (error) {
		console.error(`[gemini] bringToFront failed: ${error.message}`);
		if (required) throw error;
		return false;
	}
}

async function scrollToBottom(tab) {
	await cdp([
		"eval",
		tab,
		`(function() {
			const chat = document.querySelector('chat-window, [role="main"], main') || document.body;
			chat.scrollTo ? chat.scrollTo({ top: chat.scrollHeight, behavior: 'smooth' }) : window.scrollTo(0, document.body.scrollHeight);
		})()`,
	]);
}

/**
 * Read the assistant response from the model-response element.
 * Used as a fallback when the copy-button click captures the user's
 * query text instead of the response (which happens when the response
 * never rendered, or when the "last copy button on the page" is not
 * the assistant's response copy button).
 */
async function extractAnswerFromDom(tab) {
	const raw = await cdp(
		[
			"eval",
			tab,
			String.raw`
			new Promise((resolve) => {
				const _deadline = Date.now() + 6000;
				function _tryExtract() {
					const responses = Array.from(document.querySelectorAll('model-response'));
					const resp = responses[responses.length - 1];
					if (resp) {
						const text = (resp.innerText || resp.textContent || '').trim();
						const idx = text.indexOf('\n');
						const answer = idx >= 0 ? text.slice(idx + 1).trim() : text;
						if (answer) {
							const seen = new Set();
							const sources = [];
							for (const link of resp.querySelectorAll('a[href]')) {
								const url = link.href;
								if (!url || seen.has(url)) continue;
								seen.add(url);
								const title = (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim();
								sources.push({ title, url });
								if (sources.length >= 10) break;
							}
							return resolve(JSON.stringify({ answer, sources }));
						}
					}
					if (Date.now() < _deadline) {
						setTimeout(_tryExtract, 500);
					} else {
						resolve(JSON.stringify({ answer: '', sources: [] }));
					}
				}
				_tryExtract();
			})
		`,
		],
		8000,
	);
	try {
		return JSON.parse(raw);
	} catch (error) {
		console.error(
			`[gemini] DOM fallback JSON parse failed (${raw.length} chars): ${error.message}`,
		);
		return { answer: "", sources: [] };
	}
}

const GEMINI_COPY_CLICK_EXPR = `(() => {
	window.${GLOBAL_VAR} = '';
	const responses = Array.from(document.querySelectorAll('model-response'));
	const resp = responses[responses.length - 1];
	if (!resp) return;
	const buttons = Array.from(resp.querySelectorAll('${S.copyButton}'));
	const nonCodeButtons = buttons.filter((btn) => !btn.closest('pre, code, code-block, .code-block, .code-container'));
	const btn = nonCodeButtons[nonCodeButtons.length - 1] || buttons[buttons.length - 1];
	if (btn) btn.click();
})()`;

async function extractAnswer(tab, query = "", streamWaitOk = false) {
	const queryNorm = query.toLowerCase().trim();

	// waitForStreamComplete in main() already polled this exact predicate
	// (model-response innerText length > 60) until it stabilised. Re-running
	// the same 800ms/tick loop here is redundant when that wait succeeded —
	// do a single confirmation check instead. Only fall back to the full
	// poll when the stream wait itself timed out (streamWaitOk === false),
	// since the response may still be short/rendering in that case.
	let modelReady = false;
	if (streamWaitOk) {
		const ready = await cdp([
			"eval",
			tab,
			String.raw`(() => {
				const responses = Array.from(document.querySelectorAll('model-response'));
				const r = responses[responses.length - 1];
				return !!r && (r.innerText || '').trim().length > 60;
			})()`,
		]).catch(() => "false");
		modelReady = ready === "true";
	} else {
		// Wait for the model-response element to have content (not just the
		// "Gemini said" label). The old approach waited for copy button
		// count >= 2, which is unreliable: the Gemini UI has many copy
		// icons (copy link, copy code, etc.), and the last one on the page
		// is not always the assistant response copy button.
		//
		// minLength: 60 — Gemini renders a streaming header/prefix
		// ("Gemini said" + UI chrome = ~25 chars) before the body arrives.
		// The old 20-char threshold often resolved at the header stage and
		// the copy button click then captured a partial/header-only result.
		const modelDeadline = Date.now() + 12000;
		while (Date.now() < modelDeadline) {
			const ready = await cdp([
				"eval",
				tab,
				String.raw`(() => {
					const responses = Array.from(document.querySelectorAll('model-response'));
					const r = responses[responses.length - 1];
					if (!r) return false;
					const t = (r.innerText || '').trim();
					// Must have content beyond the locale-specific label
					// ("Gemini said" / "Το Gemini είπε" / etc.) and ideally
					// a copy button rendered on the response.
					return t.length > 60;
				})()`,
			]);
			if (ready === "true") {
				modelReady = true;
				break;
			}
			await new Promise((r) => setTimeout(r, 800));
		}
	}
	if (!modelReady) {
		console.error("[gemini] Warning: model-response did not render content");
	}

	// Click the copy button on the model-response element specifically,
	// not the absolute last copy button on the page. The page has many
	// copy icons (copy link, copy code, etc.) and the last one is not
	// always the assistant's response copy button.
	let answer = await clickCopyAndAwaitClipboard(
		tab,
		GEMINI_COPY_CLICK_EXPR,
		GLOBAL_VAR,
		{ timeoutMs: 600, retryClick: 600 },
	);

	// Retry once if clipboard contains the user's query instead of the response.
	// This can happen when the assistant response hasn't rendered its copy button yet.
	if (
		answer &&
		queryNorm &&
		(answer.toLowerCase().trim() === queryNorm ||
			answer.trim().length < queryNorm.length)
	) {
		console.error("[gemini] Clipboard echoed query, retrying in 2s...");
		await new Promise((r) => setTimeout(r, 2000));
		answer = await clickCopyAndAwaitClipboard(
			tab,
			GEMINI_COPY_CLICK_EXPR,
			GLOBAL_VAR,
			{ timeoutMs: 600, retryClick: 600 },
		);
	}

	// DOM fallback: if clipboard is empty, echoes the query, or looks like a
	// short snippet, read the model-response innerText directly. Skip the
	// fallback when native copy already returned a substantial full answer.
	let domFallback = null;
	const answerText = answer?.trim() || "";
	const clipboardLooksEchoed =
		queryNorm &&
		(answerText.toLowerCase() === queryNorm ||
			answerText.length < queryNorm.length);
	const clipboardLooksComplete =
		answerText.length > 500 && !clipboardLooksEchoed;
	if (!clipboardLooksComplete) {
		domFallback = await extractAnswerFromDom(tab);
		const domExtendsClipboard =
			answerText &&
			domFallback.answer.includes(answerText) &&
			domFallback.answer.length > answerText.length * 2;
		if (
			domFallback.answer &&
			(!answerText || clipboardLooksEchoed || domExtendsClipboard)
		) {
			answer = domFallback.answer;
		}
	}

	if (!answer) {
		throw new Error(
			"Gemini returned no answer — model-response never rendered content",
		);
	}

	const sourcesInline = parseSourcesFromMarkdown(answer);
	const sourceMap = new Map();
	for (const s of [...(domFallback?.sources || []), ...sourcesInline]) {
		if (s?.url && !sourceMap.has(s.url)) sourceMap.set(s.url, s);
	}
	const sources = Array.from(sourceMap.values()).slice(0, 10);

	return { answer: answer.trim(), sources };
}

// ============================================================================
// Main
// ============================================================================

const USAGE = 'Usage: node extractors/gemini.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);

	// Default to headless unless the caller explicitly set GREEDY_SEARCH_VISIBLE=1.
	// This prevents a stale visible-mode env in the parent process from making
	// Gemini run visible when research synthesis/learning/planning expects headless.
	if (
		process.env.GREEDY_SEARCH_VISIBLE !== "1" &&
		process.env.GREEDY_SEARCH_ALWAYS_VISIBLE !== "1"
	) {
		process.env.GREEDY_SEARCH_HEADLESS = "1";
	}

	// Ensure Chrome is in the requested mode (headless by default). If a prior
	// session left a visible Chrome running on port 9222, ensureChrome detects
	// the mismatch, kills it, and relaunches headless before the gemini tab
	// opens.
	await ensureChrome();

	try {
		await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Skip navigation if tab was pre-seeded to Gemini (e.g. by search.mjs
		// opening the tab in parallel with source fetch to save ~4s nav time).
		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		let onGemini = false;
		try {
			const host = new URL(currentUrl).hostname.toLowerCase();
			onGemini =
				host === "gemini.google.com" || host.endsWith(".gemini.google.com");
		} catch {}

		if (!onGemini) {
			await cdp(["nav", tab, "https://gemini.google.com/app"], 20000);
			await new Promise((r) => setTimeout(r, 600));
		}
		await dismissConsent(tab, cdp);
		await handleVerification(tab, cdp, 10000);

		// Wait for input to be ready
		await waitForSelector(tab, S.input, 8000, TIMING.inputPoll);
		await new Promise((r) => setTimeout(r, jitter(TIMING.postClick)));

		await bringToFront(tab, { required: true });
		await injectClipboardInterceptor(tab, GLOBAL_VAR);
		await typeIntoGemini(tab, query);
		await new Promise((r) => setTimeout(r, jitter(TIMING.postType)));

		await cdp([
			"eval",
			tab,
			`document.querySelector('${S.sendButton}')?.click()`,
		]);

		// Wait for Gemini's response to finish streaming before extracting.
		// Periodic scrolling keeps lazy-loaded content triggered in the viewport.
		await bringToFront(tab);
		let pollTick = 0;
		const scrollInterval = setInterval(() => {
			bringToFront(tab).catch(() => null);
			if (++pollTick % 10 === 0) scrollToBottom(tab).catch(() => null);
		}, 6000);
		let streamWaitOk = true;
		try {
			await waitForStreamComplete(tab, {
				timeout: 45000,
				stableRounds: 5,
				minLength: 60,
				selector:
					"(() => { const responses = Array.from(document.querySelectorAll('model-response')); return responses[responses.length - 1]; })()",
			});
		} catch {
			streamWaitOk = false;
		} finally {
			clearInterval(scrollInterval);
		}

		const { answer, sources } = await extractAnswer(tab, query, streamWaitOk);
		if (!answer) throw new Error("No answer captured from Gemini clipboard");

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "https://gemini.google.com/app",
		);
		outputJson({
			query,
			url: finalUrl,
			answer: formatAnswer(answer, short),
			sources,
		});
	} catch (e) {
		handleError(e);
	}
}

main();

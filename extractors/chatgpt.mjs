#!/usr/bin/env node

// extractors/chatgpt.mjs
// Navigate chatgpt.com, submit query, wait for answer, extract answer + sources.
//
// Usage:
//   node extractors/chatgpt.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.

import {
	buildEnvelope,
	cdp,
	formatAnswer,
	getOrOpenTab,
	handleError,
	injectClipboardInterceptor,
	jitter,
	logStage,
	outputJson,
	parseArgs,
	parseSourcesFromMarkdown,
	parseSourcesFromMarkdownRefStyle,
	prepareArgs,
	validateQuery,
	waitForSelector,
} from "./common.mjs";
import { dismissConsent, handleVerification } from "./consent.mjs";

const GLOBAL_VAR = "__chatgptClipboard";
const PROSE_SELECTOR = "div.ProseMirror";
const SEND_SELECTOR = 'button[data-testid="send-button"]';
const COPY_SELECTOR = 'button[data-testid="copy-turn-action-button"]';

// ============================================================================
// ChatGPT-specific helpers
// ============================================================================

async function typeAndSubmit(tab, query) {
	// Focus the ProseMirror editor
	await cdp(["click", tab, PROSE_SELECTOR]);
	await new Promise((r) => setTimeout(r, jitter(200)));

	// Type via execCommand — this is the only reliable way to insert text into
	// a ProseMirror editor (ChatGPT's input). CDP's Input.insertText targets
	// input/textarea elements and doesn't dispatch the synthetic events that
	// ProseMirror's editor view listens for, causing the send button to stay
	// disabled in all-mode under CDP contention.
	const typeResult = await cdp(
		[
			"eval",
			tab,
			`(() => {
				const editor = document.querySelector('${PROSE_SELECTOR}');
				if (!editor) return 'no-editor';
				editor.focus();
				const ok = document.execCommand('insertText', false, ${JSON.stringify(query)});
				return ok ? 'ok' : 'exec-failed';
			})()`,
		],
		5000,
	);
	if (typeResult !== "ok") {
		throw new Error(`ChatGPT type failed: ${typeResult}`);
	}
	await new Promise((r) => setTimeout(r, jitter(300)));

	// Click send button
	const sendCode = `
		(() => {
			const btn = document.querySelector('${SEND_SELECTOR}');
			if (!btn) return 'no-send';
			if (btn.disabled) return 'send-disabled';
			btn.click();
			return 'ok';
		})()
	`;
	const sendResult = await cdp(["eval", tab, sendCode]);
	if (sendResult === "no-send")
		throw new Error("ChatGPT send button not found");
	if (sendResult === "send-disabled")
		throw new Error("ChatGPT send button disabled — query was not registered");
	await new Promise((r) => setTimeout(r, jitter(300)));
}

/**
 * Inline selector for waitForStreamComplete: returns the assistant message
 * that comes AFTER the last user message, or null if none exists. This
 * skips chatgpt.com's static pre-rendered greeting card (which is
 * `data-turn-start-message="true"` and lives on the homepage before any
 * conversation) so short answers like "Hello! 👋" don't get confused with
 * the 32-char placeholder.
 */
const CHATGPT_RESPONSE_SELECTOR = String.raw`(() => {
	const all = document.querySelectorAll('[data-message-author-role]');
	let lastUserIdx = -1;
	for (let i = 0; i < all.length; i++) {
		if (all[i].getAttribute('data-message-author-role') === 'user') lastUserIdx = i;
	}
	if (lastUserIdx < 0) return null;
	let bestEl = null;
	let bestLen = 0;
	for (let i = lastUserIdx + 1; i < all.length; i++) {
		if (all[i].getAttribute('data-message-author-role') === 'assistant') {
			const len = (all[i].innerText || '').length;
			if (len > bestLen) { bestLen = len; bestEl = all[i]; }
		}
	}
	return bestEl;
})()`;

/**
 * Wait for ChatGPT's response to finish streaming. Delegates to the shared
 * waitForStreamComplete in common.mjs with a custom selector that skips
 * the static homepage greeting card.
 *
 * Tuning (fixes premature-stability race for complex answers):
 *   minLength: 1    — kept low so short factual answers (e.g. "2 + 2 = 4.")
 *                      stabilize correctly. The previous run reported a 10-char
 *                      answer after 35s of waiting because minLength: 50 was
 *                      too high for short replies.
 *   stableRounds: 6  — require 6 rounds (~3.6s) of stable text. Complex
 *                      answers stream a header/title block ("Next.jsReactNext.js",
 *                      citation strips, etc.) that often stays at 19-40 chars
 *                      for ~1.5-2s before the body arrives. The previous
 *                      stableRounds: 3 (~1.8s) wasn't enough headroom; 6 rounds
 *                      forces the body content to land before the wait resolves.
 *                      Short answers like "2+2=4" stay stable at low length
 *                      and resolve quickly because the entire response
 *                      actually has finished.
 */
async function bringToFront(tab, { required = false } = {}) {
	try {
		await cdp(["evalraw", tab, "Page.bringToFront", "{}"], 5000);
		return true;
	} catch (error) {
		console.error(`[chatgpt] bringToFront failed: ${error.message}`);
		if (required) throw error;
		return false;
	}
}

async function waitForResponse(tab, timeoutMs = 35000) {
	await bringToFront(tab, { required: true });
	let foregroundAttempts = 0;
	let foregroundInFlight = false;
	const keepForeground = setInterval(() => {
		if (foregroundInFlight) return;
		if (foregroundAttempts >= 8) {
			console.error("[chatgpt] stopping foreground keepalive after 8 attempts");
			clearInterval(keepForeground);
			return;
		}
		foregroundAttempts++;
		foregroundInFlight = true;
		bringToFront(tab).finally(() => {
			foregroundInFlight = false;
		});
	}, 4000);
	try {
		const code = String.raw`
		new Promise((resolve, reject) => {
			const _deadline = Date.now() + ${timeoutMs};
			const _baseInterval = 700;
			const _stableRounds = 5;
			let _lastLen = -1;
			let _stableCount = 0;

			function _jitter(ms) {
				return Math.max(50, ms + (Math.random() * ms * 0.4 - ms * 0.2));
			}

			function _assistantAfterLastUser() {
				const all = document.querySelectorAll('[data-message-author-role]');
				let lastUserIdx = -1;
				for (let i = 0; i < all.length; i++) {
					if (all[i].getAttribute('data-message-author-role') === 'user') lastUserIdx = i;
				}
				if (lastUserIdx < 0) return null;
				let assistant = null;
				for (let i = lastUserIdx + 1; i < all.length; i++) {
					if (all[i].getAttribute('data-message-author-role') === 'assistant') assistant = all[i];
				}
				return assistant;
			}

			function _poll() {
				try {
					const el = _assistantAfterLastUser();
					const text = (el?.innerText || '').trim();
					const len = text.length;
					const streaming = !!el?.querySelector('.streaming-animation,[data-is-streaming="true"]') ||
						!!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label*="Stop"]');
					if (len >= 1 && !streaming) {
						if (len === _lastLen) {
							_stableCount++;
							if (_stableCount >= _stableRounds) { resolve(len); return; }
						} else {
							_lastLen = len;
							_stableCount = 0;
						}
					} else if (len !== _lastLen) {
						_lastLen = len;
						_stableCount = 0;
					}
					if (Date.now() < _deadline) setTimeout(_poll, _jitter(_baseInterval));
					else if (_lastLen >= 1 && !streaming) resolve(_lastLen);
					else reject(new Error('ChatGPT response did not finish streaming within ${timeoutMs}ms'));
				} catch (e) { reject(e); }
			}
			_poll();
		})`;
		const lenStr = await cdp(["eval", tab, code], timeoutMs + 10000);
		const len = parseInt(lenStr, 10) || 0;
		if (len >= 1) return len;
		throw new Error(
			`ChatGPT response did not finish streaming within ${timeoutMs}ms`,
		);
	} finally {
		clearInterval(keepForeground);
	}
}

/**
 * Node-side fallback for chatgpt stream completion. Used when the in-browser
 * poll times out (typically because Chrome throttles background tabs to 1Hz
 * when 3+ extractors run in parallel in `all` mode). Polls the same
 * greeting-card-skipping selector via short independent Runtime.evaluate
 * calls so the WebSocket is free between polls.
 */
async function pollForResponseNodeSide(tab, maxMs = 15000) {
	const deadline = Date.now() + maxMs;
	let lastLen = 0;
	let stableRounds = 0;
	while (Date.now() < deadline) {
		const result = await cdp(
			["eval", tab, `${CHATGPT_RESPONSE_SELECTOR}?.innerText?.length ?? 0`],
			4000,
		).catch(() => "0");
		const len = parseInt(result, 10) || 0;
		if (len >= 1 && len === lastLen) {
			stableRounds++;
			if (stableRounds >= 3) return len;
		} else {
			lastLen = len;
			stableRounds = 0;
		}
		await new Promise((r) => setTimeout(r, 1200));
	}
	return lastLen;
}

async function extractAnswerFromDom(tab) {
	const raw = await cdp([
		"eval",
		tab,
		String.raw`
		(() => {
			// Find the assistant message that comes AFTER the last user message,
			// not the absolute last assistant element. The chatgpt.com homepage
			// has a static pre-rendered greeting card that renders as a
			// [data-message-author-role="assistant"] element with
			// data-turn-start-message="true" — it must be skipped or the
			// static "Hello! How can I help you today?" placeholder gets
			// returned as the answer to a query the assistant never answered.
			const all = Array.from(document.querySelectorAll('[data-message-author-role]'));
			let lastUserIdx = -1;
			for (let i = 0; i < all.length; i++) {
				if (all[i].getAttribute('data-message-author-role') === 'user') {
					lastUserIdx = i;
				}
			}
			if (lastUserIdx < 0) {
				// No user message at all — page is still on the homepage.
				return JSON.stringify({
					answer: '',
					sources: [],
					skipped: 'no-user-message',
				});
			}
			let assistant = null;
			for (let i = lastUserIdx + 1; i < all.length; i++) {
				if (all[i].getAttribute('data-message-author-role') === 'assistant') {
					assistant = all[i];
				}
			}
			if (!assistant) {
				return JSON.stringify({
					answer: '',
					sources: [],
					skipped: 'no-assistant-response',
				});
			}
			const streaming = !!assistant.querySelector('.streaming-animation,[data-is-streaming="true"]') ||
				!!document.querySelector('button[data-testid="stop-button"], button[aria-label="Stop generating"], button[aria-label*="Stop"]');
			const answer = (assistant.innerText || assistant.textContent || '').trim();
			const seen = new Set();
			const sources = [];
			for (const link of assistant.querySelectorAll('a[href]')) {
				const url = link.href;
				if (!url || seen.has(url)) continue;
				seen.add(url);
				const title = (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim();
				sources.push({ title, url });
				if (sources.length >= 10) break;
			}
			return JSON.stringify({ answer, sources, streaming });
		})()
	`,
	]);
	try {
		return JSON.parse(raw);
	} catch (error) {
		console.error(
			`[chatgpt] DOM fallback JSON parse failed (${raw.length} chars): ${error.message}`,
		);
		return { answer: "", sources: [], skipped: "parse-error" };
	}
}

async function extractAnswer(tab, env) {
	// Click the copy button on the assistant's response (after the last
	// user message). The old `buttons[buttons.length - 1]` picked the
	// absolute last copy button on the page — which is the USER message's
	// copy button when the assistant response is still empty (0 chars) and
	// has no copy button of its own. That copied the user's query into
	// the clipboard interceptor and returned it as the "answer".
	//
	// If the assistant message has no copy button yet (still streaming, or
	// the React tree hasn't rendered the button after streaming completed),
	// we deliberately click NOTHING rather than falling back to the last
	// copy button on the page. An empty clipboard routes us to the DOM
	// fallback, which correctly targets the assistant message after the
	// last user message and returns its innerText.
	await cdp([
		"eval",
		tab,
		`(() => {
			const all = document.querySelectorAll('[data-message-author-role]');
			let lastUserIdx = -1;
			for (let i = 0; i < all.length; i++) {
				if (all[i].getAttribute('data-message-author-role') === 'user') lastUserIdx = i;
			}
			if (lastUserIdx < 0) return 'no-user';
			let assistantCopy = null;
			for (let i = lastUserIdx + 1; i < all.length; i++) {
				if (all[i].getAttribute('data-message-author-role') === 'assistant') {
					const btn = all[i].querySelector('${COPY_SELECTOR}');
					if (btn) assistantCopy = btn;
				}
			}
			if (assistantCopy) { assistantCopy.click(); return 'clicked'; }
			return 'no-assistant-copy';
		})()`,
	]);
	await new Promise((r) => setTimeout(r, 600));

	let answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
	env.clipboardEmpty = !answer;

	// Retry once if clipboard is empty — the assistant message may have
	// finished streaming and the copy button may have rendered in the
	// meantime.
	if (!answer) {
		console.error("[chatgpt] Clipboard empty, retrying in 2s...");
		await cdp([
			"eval",
			tab,
			`(() => {
				const all = document.querySelectorAll('[data-message-author-role]');
				let lastUserIdx = -1;
				for (let i = 0; i < all.length; i++) {
					if (all[i].getAttribute('data-message-author-role') === 'user') lastUserIdx = i;
				}
				if (lastUserIdx < 0) return 'no-user';
				let assistantCopy = null;
				for (let i = lastUserIdx + 1; i < all.length; i++) {
					if (all[i].getAttribute('data-message-author-role') === 'assistant') {
						const btn = all[i].querySelector('${COPY_SELECTOR}');
						if (btn) assistantCopy = btn;
					}
				}
				if (assistantCopy) { assistantCopy.click(); return 'clicked'; }
				return 'no-assistant-copy';
			})()`,
		]);
		await new Promise((r) => setTimeout(r, 2000));
		answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
		env.clipboardEmpty = !answer;
	}

	let domFallback = null;
	if (!answer) {
		domFallback = await extractAnswerFromDom(tab);
		if (domFallback.streaming) {
			return { answer: "", sources: [], skipped: "still-streaming" };
		}
		answer = domFallback.answer;
		env.fallbackUsed = answer ? "dom" : null;
	}

	// Reject suspicious DOM-fallback answers: header-only text (e.g. the
	// "Next.jsReactNext.js" title block ChatGPT renders before the body
	// streams in) and query-echoed text. These were the failure modes the
	// earlier stream-wait race was producing — minLength: 1 + stableRounds: 3
	// resolved too early on the header. The tightened stream-wait covers
	// the common case; this guard catches the tail where the wait still
	// resolved prematurely under CDP contention with parallel extractors.
	//
	// Heuristic: a real answer is either long (> 50 chars) or matches the
	// shape of a short factual answer (10-50 chars and contains at least
	// one punctuation/space-delimited word). The 5-char absolute floor
	// catches the "Gemini said"/"Next.jsReactNext.js" header stubs that
	// the old path let through.
	//
	// Return an empty result (NOT throw) so the caller's retry loop can
	// re-wait and try again. The retry path itself is the right place
	// for backoff, not here.
	if (answer) {
		const trimmed = answer.trim();
		const looksLikeShortAnswer =
			trimmed.length >= 5 &&
			trimmed.length <= 50 &&
			/\s|[.,!?;:]/.test(trimmed);
		const looksLikeLongAnswer = trimmed.length > 50;
		const words = trimmed.split(/\s+/).filter(Boolean);
		const domainRepeats = (
			trimmed.match(/\b[a-z0-9-]+\.(?:com|org|net|dev|io)\b/gi) || []
		).length;
		const looksLikeCitationStub =
			domainRepeats >= 4 &&
			domainRepeats >= Math.max(3, Math.floor(words.length / 3));
		if (
			(!looksLikeShortAnswer && !looksLikeLongAnswer) ||
			looksLikeCitationStub
		) {
			console.error(
				`[chatgpt] DOM fallback answer suspicious (${trimmed.length} chars, domainRepeats=${domainRepeats}: ${JSON.stringify(trimmed.slice(0, 80))}) — returning empty for caller to retry`,
			);
			env.fallbackUsed = null;
			return {
				answer: "",
				sources: [],
				skipped: looksLikeCitationStub ? "citation-stub" : "header-stub",
			};
		}
	}
	if (!answer) {
		return { answer: "", sources: [], skipped: "no-answer" };
	}

	// Parse sources from both inline/reference-style markdown links and DOM links
	// (DOM fallback preserves sources even when native clipboard copy fails).
	const sourcesInline = parseSourcesFromMarkdown(answer);
	const sourcesRef = parseSourcesFromMarkdownRefStyle(answer);
	const sourceMap = new Map();
	for (const s of [
		...(domFallback?.sources || []),
		...sourcesRef,
		...sourcesInline,
	]) {
		if (s?.url && !sourceMap.has(s.url)) sourceMap.set(s.url, s);
	}
	const sources = Array.from(sourceMap.values()).slice(0, 10);

	return { answer: answer.trim(), sources };
}

// ============================================================================
// Main
// ============================================================================

const USAGE = 'Usage: node extractors/chatgpt.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);
	const startTime = Date.now();
	const mode =
		process.env.GREEDY_SEARCH_VISIBLE === "1" ? "visible" : "headless";

	const env = {
		engine: "chatgpt",
		mode,
		clipboardEmpty: null,
		fallbackUsed: null,
		blockedBy: null,
		verificationResult: null,
		inputReady: null,
	};

	try {
		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		let onChatGPT = false;
		try {
			onChatGPT = new URL(currentUrl).hostname.toLowerCase() === "chatgpt.com";
		} catch {}

		if (!onChatGPT) {
			logStage(env, "nav", startTime);
			await cdp(["nav", tab, "https://chatgpt.com"], 20000);
			await new Promise((r) => setTimeout(r, 600));
		}
		logStage(env, "consent", startTime);
		await dismissConsent(tab, cdp);
		logStage(env, "verification", startTime);
		const verificationResult = await handleVerification(tab, cdp, 10000);
		env.verificationResult = verificationResult;
		if (verificationResult === "needs-human") {
			env.blockedBy = "cloudflare-closed-shadow-dom";
			throw new Error(
				"ChatGPT is showing a Cloudflare Turnstile challenge that auto-clicking could not clear — please solve it in the visible browser window",
			);
		}
		// Verification was auto-cleared (button clicked via CDP pierce).
		// Wait for the chat UI to render before continuing.
		if (verificationResult === "clicked") {
			await new Promise((r) => setTimeout(r, 2500));
		}

		logStage(env, "input-wait", startTime);
		const inputReady = await waitForSelector(tab, PROSE_SELECTOR, 8000, 400);
		env.inputReady = inputReady;
		if (!inputReady) {
			const bodyText = await cdp([
				"eval",
				tab,
				`document.body?.innerText || ''`,
			]).catch(() => "");
			if (
				/sign in|log in|sign up|\u03a3\u03cd\u03bd\u03b4\u03b5\u03c3\u03b7|login/i.test(
					bodyText,
				)
			) {
				throw new Error(
					"ChatGPT requires sign-in — please sign in in the visible browser window",
				);
			}
			throw new Error(
				"ChatGPT input not found — page may be blocked or in unexpected state",
			);
		}

		logStage(env, "clipboard-inject", startTime);
		await injectClipboardInterceptor(tab, GLOBAL_VAR);
		logStage(env, "type-and-submit", startTime);
		await typeAndSubmit(tab, query);

		logStage(env, "stream-wait", startTime);
		// waitForStreamComplete handles the in-browser poll in a single
		// Runtime.evaluate call. If the response is still streaming past
		// 20s (slow under tab throttling in `all` mode), fall back to
		// node-side polls that release the WebSocket between each call.
		// Together they stay well within the engine's 80s outer budget.
		let asstLen = 0;
		try {
			asstLen = await waitForResponse(tab, 20000);
		} catch (e) {
			logStage(env, "stream-poll-fallback", startTime);
			asstLen = await pollForResponseNodeSide(tab, 15000);
		}
		env.assistantTextLen = asstLen;
		if (asstLen < 1) {
			console.error(
				"[chatgpt] Warning: assistant response may not have completed",
			);
		}

		logStage(env, "extract", startTime);
		// Retry extract up to 3 times with 2s delays. After stream-wait
		// times out in all-mode under CDP contention, the assistant message
		// may still be rendering. A short retry loop catches the response
		// once it lands without burning the full 60s engine budget.
		//
		// Each retry first re-runs waitForResponse (which the tightened
		// minLength=50 + stableRounds=5 makes more accurate), so we don't
		// just blindly re-click the copy button on a still-streaming
		// assistant message.
		let extractResult;
		for (let attempt = 0; attempt < 3; attempt++) {
			// Re-wait on retries (attempt 0 already waited; attempts 1-2
			// didn't because we already passed waitForResponse once). Skip
			// the wait on attempt 0 to avoid a redundant 20s budget burn.
			if (attempt > 0) {
				try {
					await waitForResponse(tab, 10000);
				} catch {
					// Best-effort: fall through to extract which itself
					// returns empty on a still-streaming page.
				}
			}
			extractResult = await extractAnswer(tab, env);
			if (extractResult.answer) break;
			if (attempt < 2) {
				console.error(
					`[chatgpt] Extract attempt ${attempt + 1} returned empty, retrying in 2s...`,
				);
				await new Promise((r) => setTimeout(r, 2000));
			}
		}
		const { answer, sources, skipped } = extractResult;
		// If the DOM fallback skipped the response (no real assistant
		// message after the user's query), surface a clear error so the
		// caller doesn't silently consume the static homepage greeting
		// card as a real answer. The static card lives on chatgpt.com
		// before any conversation; without this guard the extractor used
		// to return "Hello! How can I help you today?" as a successful
		// response to every query.
		if (!answer) {
			env.blockedBy = "no-response";
			env.skipped = skipped || null;
			let message = "ChatGPT returned no answer — assistant never responded";
			if (skipped === "no-user-message") {
				message = "ChatGPT still on homepage — query was not submitted";
			} else if (skipped === "no-assistant-response") {
				message = "ChatGPT did not return an assistant response after submit";
			} else if (
				skipped === "header-stub" ||
				skipped === "citation-stub" ||
				skipped === "still-streaming"
			) {
				message =
					"ChatGPT response did not finish rendering after 3 retries — assistant never rendered the body";
			}
			throw new Error(message);
		}
		logStage(env, "done", startTime);

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "https://chatgpt.com",
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
		console.error(
			`[chatgpt] error during stage '${env.lastStage || "unknown"}': ${e.message}`,
		);
		handleError(e, buildEnvelope(env));
	}
}

main();

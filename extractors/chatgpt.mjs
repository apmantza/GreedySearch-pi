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
	cdpWithInput,
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
	waitForStreamComplete,
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

	// Type via CDP (sends Input.insertText). Use stdin so long synthesis
	// prompts do not hit Windows command-line length limits.
	await cdpWithInput(["type", tab, "--stdin"], query);
	await new Promise((r) => setTimeout(r, jitter(300)));

	// Click send button
	const sendCode = `
		(() => {
			const btn = document.querySelector('${SEND_SELECTOR}');
			if (!btn) return 'no-send';
			btn.click();
			return 'ok';
		})()
	`;
	const sendResult = await cdp(["eval", tab, sendCode]);
	if (sendResult === "no-send")
		throw new Error("ChatGPT send button not found");
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
 * waitForStreamComplete in common.mjs with a custom selector that skips the
 * static homepage greeting card. minLength: 1 means any non-empty response
 * is considered "started" — short answers like "Hello! 👋" (8 chars) used
 * to burn the full 65s budget under the old 50-char threshold.
 */
async function waitForResponse(tab, timeoutMs = 20000) {
	return waitForStreamComplete(tab, {
		timeout: timeoutMs,
		interval: 600,
		stableRounds: 3,
		minLength: 1,
		selector: CHATGPT_RESPONSE_SELECTOR,
	});
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
			[
				"eval",
				tab,
				`${CHATGPT_RESPONSE_SELECTOR}?.innerText?.length ?? 0`,
			],
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
			return JSON.stringify({ answer, sources });
		})()
	`,
	]);
	try {
		return JSON.parse(raw);
	} catch {
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
		answer = domFallback.answer;
		env.fallbackUsed = answer ? "dom" : null;
	}

	if (!answer) throw new Error("Clipboard interceptor returned empty text");

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
		await handleVerification(tab, cdp, 10000);

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
		const { answer, sources, skipped } = await extractAnswer(tab, env);
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
			throw new Error(
				skipped === "no-user-message"
					? "ChatGPT still on homepage — query was not submitted"
					: skipped === "no-assistant-response"
						? "ChatGPT did not return an assistant response after submit"
						: "ChatGPT returned no answer — assistant never responded",
			);
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

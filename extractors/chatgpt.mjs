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
 * Wait for ChatGPT's response to finish streaming.
 * Uses a SINGLE Runtime.evaluate call with in-browser polling — zero CDP
 * traffic during the wait. The 30s budget is intentionally tight: when 4
 * engines run in parallel, Chrome clamps setTimeout in background tabs to
 * a 1Hz minimum, so a longer in-browser poll just burns the wrapper's
 * timeout. Callers should pair this with pollForResponseNodeSide() to
 * cover the tail of slow responses without holding the WebSocket.
 *
 * Signal: the *text length* of the latest assistant message, not the
 * copy-button count. The count is an indirect proxy that fluctuates as
 * ChatGPT's React tree re-renders. The text length is the actual answer
 * — when it stabilises for 3 consecutive polls (>50 chars), the response
 * is done. Returns the final text length.
 */
async function waitForResponse(tab, timeoutMs = 30000) {
	const code = String.raw`
	new Promise((resolve, reject) => {
		const _deadline = Date.now() + ${timeoutMs};
		const _minLen = 50;
		let _lastLen = 0;
		let _stableCount = 0;

		function _jitter(ms) {
			return Math.max(50, ms + (Math.random() * ms * 0.4 - ms * 0.2));
		}

		function _poll() {
			try {
				const msgs = document.querySelectorAll('[data-message-author-role="assistant"]');
				const last = msgs[msgs.length - 1];
				const cur = last?.innerText?.length ?? 0;
				if (cur >= _minLen && cur === _lastLen) {
					_stableCount++;
					if (_stableCount >= 3) { resolve(cur); return; }
				} else {
					_lastLen = cur;
					_stableCount = 0;
				}
				if (Date.now() < _deadline) {
					setTimeout(_poll, _jitter(800));
				} else {
					resolve(_lastLen);
				}
			} catch(e) { reject(e); }
		}

		_poll();
	})
	`;
	const result = await cdp(["eval", tab, code], timeoutMs + 5000);
	return parseInt(result, 10) || 0;
}

/**
 * Node-side fallback for chatgpt stream completion.
 * Polls the assistant message text length via short, independent
 * Runtime.evaluate calls instead of holding the WebSocket open on a long
 * in-browser promise. Each poll frees the WebSocket between calls, so even
 * when Chrome is throttling the background tab, the daemon stays responsive.
 * Returns the final text length seen within maxMs.
 */
async function pollForResponseNodeSide(tab, maxMs = 35000) {
	const deadline = Date.now() + maxMs;
	let lastLen = 0;
	let stableRounds = 0;
	while (Date.now() < deadline) {
		const result = await cdp(
			[
				"eval",
				tab,
				`(document.querySelectorAll('[data-message-author-role="assistant"]')?.at(-1)?.innerText || '').length`,
			],
			4000,
		).catch(() => "0");
		const len = parseInt(result, 10) || 0;
		if (len >= 50 && len === lastLen) {
			stableRounds++;
			if (stableRounds >= 3) return len;
		} else {
			lastLen = len;
			stableRounds = 0;
		}
		await new Promise((r) => setTimeout(r, 1500));
	}
	return lastLen;
}

async function extractAnswerFromDom(tab) {
	const raw = await cdp([
		"eval",
		tab,
		String.raw`
		(() => {
			const assistant = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]')).at(-1);
			if (!assistant) return JSON.stringify({ answer: '', sources: [] });
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
		return { answer: "", sources: [] };
	}
}

async function extractAnswer(tab, env) {
	// Click the LAST copy button (assistant's response at the bottom)
	await cdp([
		"eval",
		tab,
		`(() => {
			const buttons = document.querySelectorAll('${COPY_SELECTOR}');
			buttons[buttons.length - 1]?.click();
		})()`,
	]);
	await new Promise((r) => setTimeout(r, 600));

	let answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
	env.clipboardEmpty = !answer;

	// Retry once if clipboard is empty
	if (!answer) {
		console.error("[chatgpt] Clipboard empty, retrying in 2s...");
		await cdp([
			"eval",
			tab,
			`(() => {
				const buttons = document.querySelectorAll('${COPY_SELECTOR}');
				buttons[buttons.length - 1]?.click();
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
		// Short in-browser poll — keeps the WebSocket mostly free. If the
		// response is still streaming past 30s (slow under tab throttling),
		// fall back to node-side polls that release the WebSocket between
		// each call. Together they stay within the engine's 70s outer budget.
		let asstLen = await waitForResponse(tab, 30000);
		if (asstLen < 50) {
			logStage(env, "stream-poll-fallback", startTime);
			asstLen = await pollForResponseNodeSide(tab, 35000);
		}
		env.assistantTextLen = asstLen;
		if (asstLen < 50) {
			console.error(
				"[chatgpt] Warning: assistant response may not have completed",
			);
		}

		logStage(env, "extract", startTime);
		const { answer, sources } = await extractAnswer(tab, env);
		logStage(env, "done", startTime);
		if (!answer)
			throw new Error("No answer extracted — ChatGPT may not have responded");

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

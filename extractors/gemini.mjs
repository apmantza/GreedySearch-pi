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

const S = SELECTORS.gemini;
const GLOBAL_VAR = "__geminiClipboard";

// ============================================================================
// Gemini-specific helpers
// ============================================================================

async function typeIntoGemini(tab, text) {
	await cdp([
		"eval",
		tab,
		`
    (function(t) {
      var el = document.querySelector('${S.input}');
      if (!el) return false;
      el.focus();
      document.execCommand('insertText', false, t);
      return true;
    })(${JSON.stringify(text)})
  `,
	]);
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

async function extractAnswer(tab) {
	// Click the LAST copy button (assistant's response at the bottom),
	// not the first (which could be the user's echoed query).
	await cdp([
		"eval",
		tab,
		`(() => {
			const buttons = document.querySelectorAll('${S.copyButton}');
			buttons[buttons.length - 1]?.click();
		})()`,
	]);
	await new Promise((r) => setTimeout(r, 400));

	const answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
	if (!answer) throw new Error("Clipboard interceptor returned empty text");

	const sources = parseSourcesFromMarkdown(answer);
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

	try {
		await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Each search = fresh conversation
		await cdp(["nav", tab, "https://gemini.google.com/app"], 35000);
		await new Promise((r) => setTimeout(r, TIMING.postNavSlow));
		await dismissConsent(tab, cdp);
		await handleVerification(tab, cdp, 60000);

		// Wait for input to be ready
		await waitForSelector(tab, S.input, 8000, TIMING.inputPoll);
		await new Promise((r) => setTimeout(r, jitter(TIMING.postClick)));

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
		let pollTick = 0;
		const scrollInterval = setInterval(() => {
			if (++pollTick % 10 === 0) scrollToBottom(tab).catch(() => null);
		}, 6000);
		try {
			await waitForStreamComplete(tab, { timeout: 90000, minLength: 50 });
		} finally {
			clearInterval(scrollInterval);
		}

		const { answer, sources } = await extractAnswer(tab);
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

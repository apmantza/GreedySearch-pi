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

async function extractAnswer(tab, query = "") {
	const queryNorm = query.toLowerCase().trim();

	// Wait for the assistant response copy button to appear.
	// A fresh conversation has 1 copy button (user message); after the
	// assistant responds there are 2+.  This prevents clicking the user's
	// copy button before React hydrates the assistant's.
	let copyReady = false;
	const copyDeadline = Date.now() + 12000;
	while (Date.now() < copyDeadline) {
		const count = await cdp([
			"eval",
			tab,
			`document.querySelectorAll('${S.copyButton}').length`,
		]);
		if (parseInt(count, 10) >= 2) {
			copyReady = true;
			break;
		}
		await new Promise((r) => setTimeout(r, 800));
	}
	if (!copyReady) {
		console.error("[gemini] Warning: assistant copy button did not appear");
	}

	// Click the LAST copy button (assistant's response at the bottom)
	await cdp([
		"eval",
		tab,
		`(() => {
			const buttons = document.querySelectorAll('${S.copyButton}');
			buttons[buttons.length - 1]?.click();
		})()`,
	]);
	await new Promise((r) => setTimeout(r, 600));

	let answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);

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
		await cdp([
			"eval",
			tab,
			`(() => {
				const buttons = document.querySelectorAll('${S.copyButton}');
				buttons[buttons.length - 1]?.click();
			})()`,
		]);
		await new Promise((r) => setTimeout(r, 600));
		answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
	}

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
			await waitForStreamComplete(tab, { timeout: 45000, minLength: 50 });
		} finally {
			clearInterval(scrollInterval);
		}

		const { answer, sources } = await extractAnswer(tab, query);
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

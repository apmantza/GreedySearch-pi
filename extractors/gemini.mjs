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
	outputJson,
	parseArgs,
	parseSourcesFromMarkdown,
	validateQuery,
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

async function waitForCopyButton(tab, timeout = 120000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 600));
		const found = await cdp([
			"eval",
			tab,
			`!!document.querySelector('${S.copyButton}')`,
		]).catch(() => "false");
		if (found === "true") return;
	}
	throw new Error(`Gemini copy button did not appear within ${timeout}ms`);
}

async function extractAnswer(tab) {
	await cdp([
		"eval",
		tab,
		`document.querySelector('${S.copyButton}')?.click()`,
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
	const args = process.argv.slice(2);
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);

	try {
		await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Each search = fresh conversation
		await cdp(["nav", tab, "https://gemini.google.com/app"], 35000);
		await new Promise((r) => setTimeout(r, 2000));
		await dismissConsent(tab, cdp);
		await handleVerification(tab, cdp, 60000);

		// Wait for input to be ready
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			const ready = await cdp([
				"eval",
				tab,
				`!!document.querySelector('${S.input}')`,
			]).catch(() => "false");
			if (ready === "true") break;
			await new Promise((r) => setTimeout(r, 400));
		}
		await new Promise((r) => setTimeout(r, 300));

		await injectClipboardInterceptor(tab, GLOBAL_VAR);
		await typeIntoGemini(tab, query);
		await new Promise((r) => setTimeout(r, 400));

		await cdp([
			"eval",
			tab,
			`document.querySelector('${S.sendButton}')?.click()`,
		]);

		await waitForCopyButton(tab);

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

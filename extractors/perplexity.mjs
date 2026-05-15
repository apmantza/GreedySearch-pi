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

	if (!answer) throw new Error("Clipboard interceptor returned empty text");

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
			await new Promise((r) => setTimeout(r, 800));
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

		// After verification, page may have redirected or reloaded — wait for it to settle
		if (verifyResult === "clicked") {
			await new Promise((r) => setTimeout(r, TIMING.afterVerify));
			await dismissConsent(tab, cdp);
		}

		// Wait for React app to mount input (up to 5s)
		const inputReady = await waitForSelector(tab, S.input, 5000, 400);
		env.inputReady = inputReady;
		await new Promise((r) => setTimeout(r, jitter(300)));

		await injectClipboardInterceptor(tab, GLOBAL_VAR);
		await cdp(["click", tab, S.input]);
		await new Promise((r) => setTimeout(r, jitter(400)));
		await cdp(["type", tab, query]);
		await new Promise((r) => setTimeout(r, jitter(400)));

		// Submit with Enter (most reliable across Chrome instances)
		await cdp([
			"eval",
			tab,
			`document.querySelector('${S.input}')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`,
		]);

		await waitForStreamComplete(tab, {
			timeout: 20000,
			interval: 600,
			stableRounds: 3,
			selector: "document.body",
		});

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

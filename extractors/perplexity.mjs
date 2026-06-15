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
	// Perplexity renders the answer in a prose container after the user message.
	// Try multiple selectors to cover layout changes across locales/versions.
	const domExtract = await cdp(
		[
			"eval",
			tab,
			`(() => {
				// Find the last .prose block (the answer, not the question)
				const proseBlocks = Array.from(document.querySelectorAll('.prose, [class*="prose"], [class*="markdown"], [class*="answer-content"]'));
				const lastProse = proseBlocks.pop();
				if (lastProse && lastProse.innerText?.trim().length > 20) {
					return JSON.stringify({
						answer: lastProse.innerText.trim(),
						method: 'prose'
					});
				}
				// Fallback: find the largest text block after the input area
				const input = document.querySelector('${S.input}');
				if (!input) return null;
				const inputRect = input.getBoundingClientRect();
				const blocks = Array.from(document.querySelectorAll('div'))
					.filter(d => {
						const r = d.getBoundingClientRect();
						return r.top > inputRect.bottom && d.innerText?.trim().length > 100 && d.children.length < 10;
					})
					.sort((a, b) => b.innerText.length - a.innerText.length);
				if (blocks.length > 0) {
					return JSON.stringify({
						answer: blocks[0].innerText.trim(),
						method: 'largest-block'
					});
				}
				return null;
			})()`,
		],
		5000,
	).catch(() => null);

	if (!domExtract || domExtract === "null") return null;

	try {
		const { answer, method } = JSON.parse(domExtract);
		if (answer && answer.length > 20) {
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

	// DOM fallback: when clipboard interception fails (intermittent in headless),
	// read the answer from the page DOM instead of triggering visible recovery.
	if (!answer) {
		console.error("[perplexity] Clipboard empty — trying DOM fallback...");
		const domResult = await extractAnswerFromDom(tab, env);
		if (domResult) {
			console.error(`[perplexity] DOM fallback succeeded (${env.fallbackUsed})`);
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

		// After verification, page may have redirected — wait for it to settle
		// then re-navigate to homepage if we ended up somewhere else.
		if (verifyResult === "clicked") {
			await new Promise((r) => setTimeout(r, TIMING.afterVerify));
			const postVerifyUrl = await cdp(["eval", tab, "document.location.href"]).catch(() => "");
			let onPerplexityAfter = false;
			try {
				const host = new URL(postVerifyUrl).hostname.toLowerCase();
				onPerplexityAfter = host === "perplexity.ai" || host.endsWith(".perplexity.ai");
			} catch {}
			if (!onPerplexityAfter) {
				await cdp(["nav", tab, "https://www.perplexity.ai/"], 20000);
				await new Promise((r) => setTimeout(r, 800));
				await dismissConsent(tab, cdp);
			}
		}

		// In headless mode: snap the accessibility tree to detect Cloudflare
		// before burning the selector wait. Perplexity is CF-protected in headless
		// just like Bing — fast-fail triggers the visible retry.
		if (process.env.GREEDY_SEARCH_HEADLESS === "1") {
			const snap = await cdp(["snap", tab]).catch(() => "");
			if (/cloudflare|challenge|security check/i.test(snap)) {
				console.error("[perplexity] Cloudflare challenge in snap — fast-failing to visible retry");
				env.blockedBy = "cloudflare";
				throw new Error("Cloudflare challenge detected — headless blocked");
			}
		}

		// Wait for React app to mount input (up to 15s — gives CF redirect + hydration time)
		const inputReady = await waitForSelector(tab, S.input, 15000, 400);
		env.inputReady = inputReady;

		if (!inputReady) {
			throw new Error("Perplexity input not found — page may not have loaded or is in unexpected state");
		}

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

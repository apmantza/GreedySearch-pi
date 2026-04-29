#!/usr/bin/env node

// extractors/bing-copilot.mjs
// Navigate copilot.microsoft.com, wait for answer to complete, return clean answer + sources.
//
// Usage:
//   node extractors/bing-copilot.mjs "<query>" [--tab <prefix>]
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
	TIMING,
	validateQuery,
	waitForCopyButton,
} from "./common.mjs";
import { dismissConsent, handleVerification } from "./consent.mjs";
import { SELECTORS } from "./selectors.mjs";

const S = SELECTORS.bing;
const GLOBAL_VAR = "__bingClipboard";

// ============================================================================
// Bing Copilot-specific helpers
// ============================================================================

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

const USAGE =
	'Usage: node extractors/bing-copilot.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = process.argv.slice(2);
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);

	try {
		await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Navigate to Copilot homepage and use the chat input
		await cdp(["nav", tab, "https://copilot.microsoft.com/"], 35000);
		await new Promise((r) => setTimeout(r, TIMING.postNavSlow));
		await dismissConsent(tab, cdp);

		// Handle verification challenges (Cloudflare Turnstile, Microsoft auth, etc.)
		const verifyResult = await handleVerification(tab, cdp, 90000);
		if (verifyResult === "needs-human") {
			throw new Error(
				"Copilot verification required — please solve it manually in the browser window",
			);
		}

		// After verification, page may have redirected or reloaded — wait for it to settle
		if (verifyResult === "clicked") {
			await new Promise((r) => setTimeout(r, TIMING.afterVerify));

			// Re-navigate if we got redirected
			const currentUrl = await cdp([
				"eval",
				tab,
				"document.location.href",
			]).catch(() => "");
			let onCopilot = false;
			try {
				const host = new URL(currentUrl).hostname.toLowerCase();
				onCopilot =
					host === "copilot.microsoft.com" ||
					host.endsWith(".copilot.microsoft.com");
			} catch {}
			if (!onCopilot) {
				await cdp(["nav", tab, "https://copilot.microsoft.com/"], 35000);
				await new Promise((r) => setTimeout(r, TIMING.postNavSlow));
				await dismissConsent(tab, cdp);
			}
		}

		// Wait for React app to mount input (up to 15s, longer after verification)
		const inputDeadline = Date.now() + 15000;
		while (Date.now() < inputDeadline) {
			const found = await cdp([
				"eval",
				tab,
				`!!document.querySelector('${S.input}')`,
			]).catch(() => "false");
			if (found === "true") break;
			await new Promise((r) => setTimeout(r, 500));
		}
		await new Promise((r) => setTimeout(r, 300));

		// Verify input is actually there before proceeding
		const inputReady = await cdp([
			"eval",
			tab,
			`!!document.querySelector('${S.input}')`,
		]).catch(() => "false");
		if (inputReady !== "true") {
			throw new Error(
				"Copilot input not found — verification may have failed or page is in unexpected state",
			);
		}

		await injectClipboardInterceptor(tab, GLOBAL_VAR);
		await cdp(["click", tab, S.input]);
		await new Promise((r) => setTimeout(r, TIMING.postClick));
		await cdp(["type", tab, query]);
		await new Promise((r) => setTimeout(r, TIMING.postType));

		// Submit with Enter (most reliable across locales and Chrome instances)
		await cdp([
			"eval",
			tab,
			`document.querySelector('${S.input}')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`,
		]);

		await waitForCopyButton(tab, S.copyButton, { timeout: 60000 });

		const { answer, sources } = await extractAnswer(tab);
		if (!answer)
			throw new Error("No answer extracted — Copilot may not have responded");

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
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

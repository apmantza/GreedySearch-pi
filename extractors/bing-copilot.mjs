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

const S = SELECTORS.bing;
const GLOBAL_VAR = "__bingClipboard";

// ============================================================================
// Bing Copilot-specific helpers
// ============================================================================

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

	let answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);

	// Retry once if clipboard is empty (Copilot might be slow to write)
	if (!answer) {
		console.error("[bing] Clipboard empty, retrying in 2s...");
		await cdp([
			"eval",
			tab,
			`(() => {
				const buttons = document.querySelectorAll('${S.copyButton}');
				buttons[buttons.length - 1]?.click();
			})()`,
		]);
		await new Promise((r) => setTimeout(r, 2000));
		answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]);
	}

	// DOM fallback: if clipboard still empty, extract text directly from response DOM.
	// This handles headless mode where Copilot renders the AI reply inside nested
	// iframes (copilot.microsoft.com → copilot.fun → blob:…) and hides the copy button.
	if (!answer) {
		answer = await extractFromIframes(tab);
	}

	if (!answer) throw new Error("Clipboard interceptor returned empty text");

	const sources = parseSourcesFromMarkdown(answer);
	return { answer: answer.trim(), sources };
}

/**
 * DOM fallback: check if Copilot is blocked by Cloudflare in headless mode.
 * When blocked, the copilot.fun iframe shows a challenge instead of the chat UI.
 * Returns the extracted text or empty string on failure (caller falls through to error
 * which triggers the visible Chrome auto-retry in search.mjs).
 */
async function extractFromIframes(mainTab) {
	try {
		// Check if the AI copy button exists — if it does, we're in visible mode
		// and clipboard should have worked. This is a different issue.
		const hasCopyBtn = await cdp([
			"eval",
			mainTab,
			`!!document.querySelector('${S.copyButton}')`,
		]).catch(() => "false");
		if (hasCopyBtn === "true") return ""; // not a headless/iframe issue

		// Check for Cloudflare challenge in the accessibility tree.
		// If present, Copilot content is blocked entirely — no DOM extraction possible.
		const snap = await cdp(["snap", mainTab]).catch(() => "");
		if (/cloudflare|challenge|security|verification/i.test(snap)) {
			console.error(
				"[bing] Cloudflare challenge detected — content blocked in headless",
			);
			return ""; // Let caller throw → triggers visible auto-retry
		}

		console.error(
			"[bing] Copy button hidden, no Cloudflare — trying DOM extraction...",
		);

		// Get CDP targets to find the copilot.fun iframe
		const targetsRaw = await cdp([
			"evalraw",
			mainTab,
			"Target.getTargets",
			"{}",
		]);
		const targets = JSON.parse(targetsRaw);
		const targetInfos = targets.targetInfos || [];
		const funFrame = targetInfos.find(
			(t) => t.type === "iframe" && t.url.includes("copilot.fun"),
		);
		if (!funFrame) {
			console.error("[bing] No copilot.fun iframe target found");
			return "";
		}

		// Try to extract from the nested blob iframe (rarely succeeds due to Cloudflare)
		const funTabId = funFrame.targetId.slice(0, 8);
		const innerText = await cdp([
			"eval",
			funTabId,
			`(()=>{const iframe=document.querySelector('iframe'); if(!iframe) return''; try{const doc=iframe.contentDocument||iframe.contentWindow.document; return doc?.body?.innerText?.trim()||''}catch(e){return''}})()`,
		]).catch(() => "");

		if (innerText) {
			console.error(
				`[bing] DOM extraction succeeded (${innerText.length} chars)`,
			);
			return innerText;
		}

		console.error(
			"[bing] DOM extraction returned empty — falling through to visible retry",
		);
	} catch (e) {
		console.error(`[bing] DOM extraction failed: ${e.message}`);
	}
	return "";
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/bing-copilot.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);

	try {
		// Only refresh page list when creating a fresh tab (no prefix provided)
		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Skip navigation if already on Copilot domain (tab was seeded by search.mjs)
		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
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
		}
		await dismissConsent(tab, cdp);

		// Handle verification challenges (Cloudflare Turnstile, Microsoft auth, etc.)
		const verifyResult = await handleVerification(tab, cdp, 30000);
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
		const inputReady = await waitForSelector(tab, S.input, 15000, 500);
		await new Promise((r) => setTimeout(r, jitter(300)));

		if (!inputReady) {
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

		// Wait for Bing Copilot's response to finish streaming before extracting.
		await waitForStreamComplete(tab, { timeout: 60000, minLength: 50 });

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

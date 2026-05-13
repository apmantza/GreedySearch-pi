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
	waitForCopyButton,
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

async function extractAnswer(tab, env) {
	// Wait for the assistant copy button to exist. On fresh Copilot
	// sessions the answer text can render before the button handler is
	// fully hydrated.  Wait for the button + a small hydration delay.
	await waitForCopyButton(tab, S.copyButton, { timeout: 5000 }).catch(
		() => null,
	);
	// Give React time to hydrate the click handler on the button
	await new Promise((r) => setTimeout(r, 800));

	let answer = await clickCopyAndPollClipboard(tab, 5000);
	let clipboardEmpty = !answer;

	// Retry once if clipboard is empty (Copilot might be slow to wire the handler)
	if (!answer) {
		console.error("[bing] Clipboard empty, retrying copy/poll...");
		answer = await clickCopyAndPollClipboard(tab, 8000);
		clipboardEmpty = !answer;
	}

	// DOM fallback: visible Copilot can render a valid response while the copy
	// action/clipboard interceptor remains empty. Extract the last assistant
	// answer from page text before treating this as a headless/iframe block.
	if (!answer) {
		answer = await extractFromVisibleDom(tab);
		if (answer) env.fallbackUsed = "visibleDom";
	}

	// DOM fallback: if clipboard still empty, extract text directly from response DOM.
	// This handles headless mode where Copilot renders the AI reply inside nested
	// iframes (copilot.microsoft.com → copilot.fun → blob:…) and hides the copy button.
	if (!answer) {
		const iframeResult = await extractFromIframes(tab, env);
		answer = iframeResult.answer;
		if (answer) env.fallbackUsed = "iframeDom";
	}

	if (!answer) throw new Error("Clipboard interceptor returned empty text");

	env.clipboardEmpty = clipboardEmpty;
	const sources = parseSourcesFromMarkdown(answer);
	return { answer: answer.trim(), sources };
}

async function clickCopyAndPollClipboard(tab, timeoutMs) {
	await cdp([
		"eval",
		tab,
		`(() => {
			window.${GLOBAL_VAR} = '';
			const buttons = document.querySelectorAll('${S.copyButton}');
			buttons[buttons.length - 1]?.click();
		})()`,
	]);

	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const answer = await cdp(["eval", tab, `window.${GLOBAL_VAR} || ''`]).catch(
			() => "",
		);
		if (answer) return answer;
		await new Promise((r) => setTimeout(r, 300));
	}
	return "";
}

/**
 * Visible-page DOM fallback. Copilot often exposes the completed assistant
 * message in document.body.innerText even when the copy button/clipboard path
 * fails. Keep this conservative: require a "Copilot said" marker and strip
 * known composer/action text after the answer.
 */
async function extractFromVisibleDom(tab) {
	try {
		const bodyText = await cdp([
			"eval",
			tab,
			"document.body?.innerText || ''",
		]).catch(() => "");
		if (!bodyText || !bodyText.includes("Copilot said")) return "";

		const answer = bodyText
			.split(/Copilot said\s*/i)
			.pop()
			.split(
				/\n[^\S\n]*(?:Good response|Bad response|Share message|Copy message|Read aloud|Regenerate|Edit in a page|Message Copilot|Smart)(?![\w])/i,
			)[0]
			.trim();

		if (answer.length < 20) return "";
		console.error(
			`[bing] Visible DOM extraction succeeded (${answer.length} chars)`,
		);
		return answer;
	} catch (e) {
		console.error(`[bing] Visible DOM extraction failed: ${e.message}`);
		return "";
	}
}

/**
 * DOM fallback: check if Copilot is blocked by Cloudflare in headless mode.
 * When blocked, the copilot.fun iframe shows a challenge instead of the chat UI.
 * Returns the extracted text or empty string on failure (caller falls through to error
 * which triggers the visible Chrome auto-retry in search.mjs).
 */
async function extractFromIframes(mainTab, env) {
	try {
		// Check if the AI copy button exists — if it does, we're in visible mode
		// and clipboard should have worked. This is a different issue.
		const hasCopyBtn = await cdp([
			"eval",
			mainTab,
			`!!document.querySelector('${S.copyButton}')`,
		]).catch(() => "false");
		if (hasCopyBtn === "true") return { answer: "" }; // not a headless/iframe issue

		// Check for Cloudflare challenge in the accessibility tree.
		// If present, Copilot content is blocked entirely — no DOM extraction possible.
		const snap = await cdp(["snap", mainTab]).catch(() => "");
		if (/cloudflare|challenge|security|verification/i.test(snap)) {
			console.error(
				"[bing] Cloudflare challenge detected — content blocked in headless",
			);
			env.blockedBy = "cloudflare";
			return { answer: "" }; // Let caller throw → triggers visible auto-retry
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
			return { answer: "" };
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
			return { answer: innerText };
		}

		console.error(
			"[bing] DOM extraction returned empty — falling through to visible retry",
		);
	} catch (e) {
		console.error(`[bing] DOM extraction failed: ${e.message}`);
	}
	return { answer: "" };
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
	const startTime = Date.now();
	const mode =
		process.env.GREEDY_SEARCH_VISIBLE === "1" ? "visible" : "headless";

	// Lightweight envelope — no extra CDP calls, just tracks what we already know
	const env = {
		engine: "bing",
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
			await cdp(["nav", tab, "https://copilot.microsoft.com/"], 20000);
			await new Promise((r) => setTimeout(r, 600));
		}
		await dismissConsent(tab, cdp);

		// Handle verification challenges (Cloudflare Turnstile, Microsoft auth, etc.)
		const verifyResult = await handleVerification(tab, cdp, 10000);
		env.verificationResult = verifyResult;
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
				await cdp(["nav", tab, "https://copilot.microsoft.com/"], 20000);
				await new Promise((r) => setTimeout(r, 600));
				await dismissConsent(tab, cdp);
			}
		}

		// Wait for React app to mount input (up to 15s, longer after verification)
		const inputReady = await waitForSelector(tab, S.input, 15000, 500);
		env.inputReady = inputReady;
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

		const { answer, sources } = await extractAnswer(tab, env);
		if (!answer)
			throw new Error("No answer extracted — Copilot may not have responded");

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

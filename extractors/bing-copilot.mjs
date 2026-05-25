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
import {
	detectVerificationChallenge,
	dismissConsent,
	handleVerification,
} from "./consent.mjs";
import { SELECTORS } from "./selectors.mjs";

const S = SELECTORS.bing;
const GLOBAL_VAR = "__bingClipboard";

// ============================================================================
// Bing Copilot-specific helpers
// ============================================================================

async function extractAnswer(tab, env, query = "") {
	// In headless mode: snap the accessibility tree before spending ~18s on
	// clipboard polls. Copilot loads its input fine in headless but renders
	// responses behind a Cloudflare-protected iframe — detecting that here
	// fast-fails to the visible retry instead of burning all the poll time.
	if (process.env.GREEDY_SEARCH_HEADLESS === "1") {
		const verification = await detectVerificationChallenge(tab, cdp);
		if (verification) {
			console.error(
				"[bing] Verification challenge detected — fast-failing to visible retry",
			);
			env.blockedBy = "verification";
			throw new Error("Verification challenge detected — headless blocked");
		}
	}

	// Wait for the assistant copy button to exist. On fresh Copilot
	// sessions the answer text can render before the button handler is
	// fully hydrated.  Wait for the button + a small hydration delay.
	// 2s is enough — the CF snap check above ensures we only reach here
	// on a clean response, where the button appears within ~1s.
	await waitForCopyButton(tab, S.copyButton, { timeout: 2000 }).catch(
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
		answer = await extractFromVisibleDom(tab, query);
		if (answer) env.fallbackUsed = "visibleDom";
	}

	// Accessibility fallback: if Copilot visibly rendered an answer but the
	// clipboard/DOM selectors missed it, the accessibility tree often still has
	// the assistant article text. This prevents false "blocked" reports when a
	// human can plainly see Bing answered in the browser.
	if (!answer) {
		answer = await extractFromAccessibilityTree(tab, query);
		if (answer) env.fallbackUsed = "accessibilityTree";
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
async function extractFromVisibleDom(tab, query = "") {
	try {
		const bodyText = await cdp([
			"eval",
			tab,
			"document.body?.innerText || ''",
		]).catch(() => "");

		let answer = "";
		if (bodyText && bodyText.includes("Copilot said")) {
			answer = cleanCopilotArticleText(
				bodyText
					.split(/Copilot said\s*/i)
					.pop()
					.split(
						/\n[^\S\n]*(?:Good response|Bad response|Share message|Copy message|Read aloud|Regenerate|Edit in a page|Message Copilot|Smart)(?![\w])/i,
					)[0],
			);
		}

		if (!answer) {
			const articlesJson = await cdp([
				"eval",
				tab,
				`JSON.stringify(Array.from(document.querySelectorAll('article')).map(a => a.innerText || '').filter(Boolean))`,
			]).catch(() => "[]");
			const articles = JSON.parse(articlesJson || "[]");
			answer = pickAnswerArticle(articles, query);
		}

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

async function extractFromAccessibilityTree(tab, query = "") {
	try {
		const snap = await cdp(["snap", tab]).catch(() => "");
		if (!snap || (await detectVerificationChallenge(tab, cdp))) return "";

		const articleLines = snap
			.split("\n")
			.map((line) => line.match(/^\s*\[article\]\s+(.+)$/i)?.[1])
			.filter(Boolean);
		if (articleLines.length === 0) return "";

		const answer = pickAnswerArticle(articleLines, query);
		if (answer.length < 50) return "";
		console.error(
			`[bing] Accessibility extraction succeeded (${answer.length} chars)`,
		);
		return answer;
	} catch (e) {
		console.error(`[bing] Accessibility extraction failed: ${e.message}`);
		return "";
	}
}

function pickAnswerArticle(articles, query = "") {
	const normalizedQuery = normalizeForCompare(query);
	const candidates = articles
		.map((text) => cleanCopilotArticleText(text))
		.filter((text) => text.length >= 50)
		.filter((text) => {
			if (!normalizedQuery) return true;
			const normalizedText = normalizeForCompare(text);
			return (
				!normalizedText.includes(normalizedQuery) ||
				text.length > query.length * 3
			);
		});
	return candidates.at(-1) || "";
}

function normalizeForCompare(text = "") {
	return String(text).toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function cleanCopilotArticleText(text = "") {
	return String(text)
		.replace(/\s+/g, " ")
		.replace(
			/\s+(?:Good response|Bad response|Share message|Copy message|Read aloud|Regenerate|Edit in a page|Message Copilot|Smart)(?![\w]).*$/i,
			"",
		)
		.trim();
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
		if (await detectVerificationChallenge(mainTab, cdp)) {
			console.error(
				"[bing] Verification challenge detected — content blocked in headless",
			);
			env.blockedBy = "verification";
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

		// Post-submit: Bing's antibot sometimes appears AFTER the query is sent.
		// Fire-and-forget verification check — runs in parallel with stream wait.
		// Zero added latency to the critical path; if it finds and clicks the
		// challenge, the stream unblocks instead of timing out at 60s.
		setTimeout(() => {
			handleVerification(tab, cdp, 10000)
				.then((v) => {
					if (v === "clicked") {
						console.error("[bing] Post-submit verification clicked");
						env.verificationResult = "post-submit-clicked";
					}
				})
				.catch(() => {});
		}, 2000);

		// Wait for Bing Copilot's response to finish streaming before extracting.
		// In --short/fast mode, cap this below the parent 40s budget and extract
		// whatever has rendered so research child searches stay fast.
		await waitForStreamComplete(tab, {
			timeout: short ? 25000 : 60000,
			minLength: 50,
		});

		const { answer, sources } = await extractAnswer(tab, env, query);
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

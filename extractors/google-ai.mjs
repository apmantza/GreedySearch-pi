#!/usr/bin/env node

// extractors/google-ai.mjs
// Navigate Google AI Mode (udm=50), wait for answer, return clean answer + sources.
//
// Usage:
//   node extractors/google-ai.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.

import {
	cdp,
	formatAnswer,
	getOrOpenTab,
	handleError,
	outputJson,
	parseArgs,
	validateQuery,
} from "./common.mjs";
import { dismissConsent, handleVerification } from "./consent.mjs";
import { SELECTORS } from "./selectors.mjs";

const S = SELECTORS.google;

const STREAM_POLL_INTERVAL = 600;
const STREAM_STABLE_ROUNDS = 3;
const STREAM_TIMEOUT = 45000;
const MIN_ANSWER_LENGTH = 50;

// ============================================================================
// Google AI-specific helpers
// ============================================================================

async function waitForGoogleStreamComplete(tab) {
	const deadline = Date.now() + STREAM_TIMEOUT;
	let stableCount = 0;
	let lastLen = -1;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, STREAM_POLL_INTERVAL));

		const lenStr = await cdp([
			"eval",
			tab,
			`(document.querySelector('${S.answerContainer}')?.innerText?.length || 0) + ''`,
		]).catch(() => "0");

		const len = parseInt(lenStr, 10) || 0;

		if (len >= MIN_ANSWER_LENGTH && len === lastLen) {
			stableCount++;
			if (stableCount >= STREAM_STABLE_ROUNDS) return len;
		} else {
			stableCount = 0;
			lastLen = len;
		}
	}

	if (lastLen >= MIN_ANSWER_LENGTH) return lastLen;
	throw new Error(
		`Google AI answer did not stabilise within ${STREAM_TIMEOUT}ms`,
	);
}

async function extractAnswer(tab) {
	const excludeFilter = S.sourceExclude
		.map((e) => `!a.href.includes('${e}')`)
		.join(" && ");
	const raw = await cdp([
		"eval",
		tab,
		`
    (function() {
      var el = document.querySelector('${S.answerContainer}');
      if (!el) return JSON.stringify({ answer: '', sources: [] });
      var answer = el.innerText.trim();
      var sources = Array.from(document.querySelectorAll('${S.sourceLink}'))
        .filter(a => ${excludeFilter})
        .map(a => ({ url: a.href.split('#')[0], title: (a.closest('${S.sourceHeadingParent}')?.querySelector('h3, [role=heading]')?.innerText || a.innerText?.trim().split('\\n')[0] || '').slice(0, 100) }))
        .filter(s => s.url && s.url.length > 10)
        .filter((v, i, arr) => arr.findIndex(x => x.url === v.url) === i)
        .slice(0, 10);
      return JSON.stringify({ answer, sources });
    })()
  `,
	]);
	return JSON.parse(raw);
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/google-ai.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = process.argv.slice(2);
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);

	try {
		await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50&hl=en`;
		await cdp(["nav", tab, url], 35000);
		await new Promise((r) => setTimeout(r, 1500));
		await dismissConsent(tab, cdp);

		// If consent redirected us away, navigate back
		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		if (!currentUrl.includes("google.com/search")) {
			await cdp(["nav", tab, url], 35000);
			await new Promise((r) => setTimeout(r, 1500));
		}

		// Handle "verify you're human" — auto-click simple buttons, wait for user on hard CAPTCHA
		const verifyResult = await handleVerification(tab, cdp, 60000);
		if (verifyResult === "needs-human")
			throw new Error(
				"Google verification required — could not be completed automatically",
			);
		if (verifyResult === "clicked" || verifyResult === "cleared-by-user") {
			// Re-navigate to the search URL after verification
			await cdp(["nav", tab, url], 35000);
			await new Promise((r) => setTimeout(r, 1500));
		}

		await waitForGoogleStreamComplete(tab);

		const { answer, sources } = await extractAnswer(tab);
		if (!answer)
			throw new Error(
				"No answer extracted — Google AI Mode may not have responded",
			);

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => url,
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

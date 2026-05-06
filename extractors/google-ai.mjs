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
	jitter,
	outputJson,
	parseArgs,
	prepareArgs,
	TIMING,
	validateQuery,
	waitForStreamComplete,
} from "./common.mjs";
import { dismissConsent, handleVerification } from "./consent.mjs";
import { SELECTORS } from "./selectors.mjs";

const S = SELECTORS.google;

const MIN_ANSWER_LENGTH = 50;

async function extractAnswer(tab) {
	const excludeFilter = S.sourceExclude
		.map((e) => `!a.href.includes('${e}')`)
		.join(" && ");
	const raw = await cdp([
		"eval",
		tab,
		String.raw`
    (function() {
      var el = document.querySelector('${S.answerContainer}');
      if (!el) return JSON.stringify({ answer: '', sources: [] });
      var answer = el.innerText.trim();
      var sources = Array.from(document.querySelectorAll('${S.sourceLink}'))
        .filter(a => ${excludeFilter})
        .map(a => ({ url: a.href.split('#')[0], title: (a.closest('${S.sourceHeadingParent}')?.querySelector('h3, [role=heading]')?.innerText || a.innerText?.trim().split('\n')[0] || '').slice(0, 100) }))
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
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short, locale } = parseArgs(args);

	try {
		// Only refresh page list when creating a fresh tab (no prefix provided)
		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Build URL with language parameter (default to English)
		const langParam = locale ? `&hl=${encodeURIComponent(locale)}` : "&hl=en";
		const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50${langParam}`;
		await new Promise((r) => setTimeout(r, jitter(TIMING.postNav)));
		await dismissConsent(tab, cdp);

		// If consent redirected us away, navigate back
		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		if (!currentUrl.includes("google.com/search")) {
			await cdp(["nav", tab, url], 35000);
			await new Promise((r) => setTimeout(r, jitter(TIMING.postNav)));
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
			await new Promise((r) => setTimeout(r, jitter(TIMING.postNav)));
		}

		await waitForStreamComplete(tab, {
			timeout: 30000,
			selector: `document.querySelector('${S.answerContainer}')`,
			minLength: MIN_ANSWER_LENGTH,
		});

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

#!/usr/bin/env node

// extractors/google-search.mjs
// Navigate google.com, type query into search box, submit, wait for results,
// return clean list of results (title, url, snippet).
//
// Usage:
//   node extractors/google-search.mjs "<query>" [--tab <prefix>] [--max <n>]
//
// Output (stdout): JSON { query, url, results: [{ title, url, snippet }] }
// Errors go to stderr only — stdout is always clean JSON for piping.

import {
	cdp,
	formatAnswer,
	getOrOpenTab,
	handleError,
	outputJson,
	parseArgs,
	TIMING,
	validateQuery,
} from "./common.mjs";
import { dismissConsent } from "./consent.mjs";

// ─── Locale-agnostic selectors ──────────────────────────────────────

// Search box: textarea[name="q"] works across all Google locales
const SEARCH_BOX = 'textarea[name="q"], input[name="q"]';
// Submit: form button or keyboard Enter (we'll use Enter which is universal)
// Result containers: try multiple selectors that work across Google layouts
const RESULT_SELECTORS = [
	'.g',                    // classic result container
	'[data-sokoban-container]', // newer layout
	'.MjjYud',               // mobile-first layout
	'div:has(> a > h3)',     // catch-all: div containing a link with heading
];

// ─── Type into search box (locale-agnostic) ─────────────────────────

async function typeIntoSearchBox(tab, text) {
	await cdp([
		"eval",
		tab,
		`
    (function(t) {
      var el = document.querySelector('${SEARCH_BOX.replace(/'/g, "\\'")}');
      if (!el) return false;
      el.focus();
      el.value = '';
      document.execCommand('insertText', false, t);
      return true;
    })(${JSON.stringify(text)})
  `,
	]);
}

// ─── Submit search (press Enter — locale agnostic) ──────────────────

async function submitSearch(tab) {
	// Press Enter key on the search box
	await cdp([
		"eval",
		tab,
		`
    (function() {
      var el = document.querySelector('${SEARCH_BOX.replace(/'/g, "\\'")}');
      if (!el) return false;
      el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', keyCode:13, which:13, bubbles:true}));
      // Also try form submission as fallback
      var form = el.closest('form');
      if (form) {
        setTimeout(function() { form.submit(); }, 100);
      }
      return true;
    })()
  `,
	]);
}

// ─── Extract results ────────────────────────────────────────────────

async function extractResults(tab, maxResults = 10) {
	const raw = await cdp([
		"eval",
		tab,
		String.raw`
    (function() {
      var results = [];
      // Strategy: find all h3 headings inside links, then find their container for snippet
      var headings = document.querySelectorAll('a[href^="http"] h3');
      var seen = new Set();
      
      for (var i = 0; i < headings.length && results.length < ${maxResults}; i++) {
        var h3 = headings[i];
        var a = h3.closest('a');
        if (!a) continue;
        
        var url = a.href;
        // Skip google.com internal links
        if (url.includes('google.com') && !url.includes('/search?')) continue;
        if (seen.has(url)) continue;
        seen.add(url);
        
        var title = h3.innerText.trim();
        if (!title) continue;
        
        // Find the containing block for the snippet
        var container = a.closest('.g, [data-sokoban-container], .MjjYud, div:has(> a > h3)');
        if (!container) container = a.parentElement;
        
        // Try multiple snippet selectors
        var snippet = '';
        var snippetEl = container.querySelector('.VwiC3b, [data-sncf], span.aCOpRe, .lEBKkf, div[style*="-webkit-line-clamp"]');
        if (!snippetEl) {
          // Fallback: find the largest text block that's not the title
          var textNodes = Array.from(container.querySelectorAll('span, div'))
            .filter(function(el) { 
              var t = el.innerText?.trim();
              return t && t.length > 30 && t !== title && !el.querySelector('h3');
            })
            .sort(function(a,b) { return b.innerText.length - a.innerText.length; });
          if (textNodes[0]) snippetEl = textNodes[0];
        }
        snippet = snippetEl ? snippetEl.innerText.trim().slice(0, 300) : '';
        
        results.push({ title: title, url: url, snippet: snippet });
      }
      
      return JSON.stringify(results);
    })()
  `,
	]);

	try {
		return JSON.parse(raw);
	} catch {
		return [];
	}
}

// ─── Wait for search results to load ───────────────────────────────

async function waitForResults(tab, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 600));
		const found = await cdp([
			"eval",
			tab,
			'document.querySelectorAll(\'a[href^="http"] h3\').length',
		]).catch(() => "0");
		const count = parseInt(found, 10) || 0;
		if (count >= 3) return count;
	}
	const found = await cdp([
		"eval",
		tab,
		'document.querySelectorAll(\'a[href^="http"] h3\').length',
	]).catch(() => "0");
	return parseInt(found, 10) || 0;
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/google-search.mjs "<query>" [--tab <prefix>] [--max <n>]\n';

async function main() {
	const args = process.argv.slice(2);
	validateQuery(args, USAGE);

	// Parse --max flag BEFORE parseArgs so it doesn't leak into query
	let maxResults = 10;
	const maxIdx = args.indexOf("--max");
	const cleanArgs = [...args];
	if (maxIdx !== -1) {
		maxResults = parseInt(args[maxIdx + 1], 10) || 10;
		cleanArgs.splice(maxIdx, 2); // Remove --max and its value
	}

	const { query, tabPrefix } = parseArgs(cleanArgs);

	try {
		await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		// Navigate to google.com
		await cdp(["nav", tab, "https://www.google.com"], 35000);
		await new Promise((r) => setTimeout(r, TIMING.postNavSlow));
		await dismissConsent(tab, cdp);

		// Wait for search box to be ready
		const deadline = Date.now() + 8000;
		while (Date.now() < deadline) {
			const ready = await cdp([
				"eval",
				tab,
				`!!document.querySelector('${SEARCH_BOX.replace(/'/g, "\\'")}')`,
			]).catch(() => "false");
			if (ready === "true") break;
			await new Promise((r) => setTimeout(r, TIMING.inputPoll));
		}

		// Type query and submit
		await typeIntoSearchBox(tab, query);
		await new Promise((r) => setTimeout(r, TIMING.postType));
		await submitSearch(tab);

		// Wait for results
		const count = await waitForResults(tab, 15000);
		if (count === 0) {
			throw new Error("No search results found on page");
		}

		// Extract results
		const results = await extractResults(tab, maxResults);
		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => `https://www.google.com/search?q=${encodeURIComponent(query)}`,
		);

		outputJson({
			query,
			url: finalUrl,
			results,
		});
	} catch (e) {
		handleError(e);
	}
}

main();

#!/usr/bin/env node

// extractors/bing-aria.mjs — ARIA-tree-based Bing Copilot extractor
//
// Instead of copy button → clipboard polling → DOM fallback → iframe spelunking,
// this extractor builds an ARIA accessibility tree of the page, finds the
// Copilot answer region, and extracts structured text + sources directly.
//
// Inspiration: browser-use-rs extract_dom.js (Playwright's ariaSnapshot)
//
// Usage:
//   node extractors/bing-aria.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors to stderr only — stdout is always clean JSON for piping.

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

// ============================================================================
// ARIA-tree answer extraction
// ============================================================================

const EXTRACT_ARIA_JS = String.raw`
(async function() {
	'use strict';

	// ── visibility helpers ──────────────────────────
	function isHidden(el) {
		if (['STYLE','SCRIPT','NOSCRIPT','TEMPLATE'].includes(el.tagName)) return true;
		const s = window.getComputedStyle(el);
		if (s.visibility !== 'visible') return true;
		if (s.display === 'none') return true;
		if (el.getAttribute('aria-hidden') === 'true') return true;
		return false;
	}

	function isVisible(el) {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	}

	function getRole(el) {
		const explicit = el.getAttribute('role');
		if (explicit) return explicit.split(' ')[0];
		const tag = el.tagName;
		const map = {
			BUTTON:'button', A: el.hasAttribute('href')?'link':null,
			INPUT: (()=>{ const t=(el.type||'text').toLowerCase(); return {button:'button',checkbox:'checkbox',radio:'radio',range:'slider',search:'searchbox',text:'textbox',email:'textbox',tel:'textbox',url:'textbox',number:'spinbutton'}[t]||'textbox'; })(),
			TEXTAREA:'textbox', SELECT: el.hasAttribute('multiple')||el.size>1?'listbox':'combobox',
			H1:'heading',H2:'heading',H3:'heading',H4:'heading',H5:'heading',H6:'heading',
			IMG: el.getAttribute('alt')===''?'presentation':'img',
			NAV:'navigation', MAIN:'main', ARTICLE:'article',
			HEADER:'banner', FOOTER:'contentinfo', ASIDE:'complementary',
			FORM:'form', TABLE:'table', UL:'list', OL:'list', LI:'listitem',
			P:'paragraph', DIALOG:'dialog', IFRAME:'iframe'
		};
		return map[tag] || 'generic';
	}

	function getName(el) {
		const label = el.getAttribute('aria-label');
		if (label) return label;
		const labelledBy = el.getAttribute('aria-labelledby');
		if (labelledBy) {
			const texts = labelledBy.split(/\s+/).map(id => {
				const e = document.getElementById(id);
				return e ? e.textContent : '';
			}).filter(Boolean);
			if (texts.length) return texts.join(' ');
		}
		if (['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) {
			const id = el.id;
			if (id) {
				const lbl = document.querySelector('label[for="'+id+'"]');
				if (lbl) return lbl.textContent || '';
			}
			const parentLbl = el.closest('label');
			if (parentLbl) return parentLbl.textContent || '';
			const ph = el.getAttribute('placeholder');
			if (ph) return ph;
		}
		if (el.tagName === 'IMG') return el.getAttribute('alt') || '';
		const title = el.getAttribute('title');
		if (title) return title;
		return '';
	}

	// ── Build ARIA tree ──────────────────────────
	let indexCounter = 0;

	function buildTree(node, visited = new Set()) {
		if (visited.has(node)) return null;
		visited.add(node);

		if (node.nodeType === 3) { // text node
			return node.nodeValue;
		}
		if (node.nodeType !== 1) return null;

		const el = node;
		if (isHidden(el)) return null;

		const role = getRole(el);
		if (!role || role === 'presentation' || role === 'none') return null;

		const name = (getName(el) || '').replace(/\s+/g, ' ').trim();
		const box = el.getBoundingClientRect();
		const visible = isVisible(el);
		const cursor = window.getComputedStyle(el).cursor;

		const result = {
			role,
			name,
			children: [],
			visible,
			cursor,
			tag: el.tagName,
		};

		// index visible interactive + pointer-cursor elements
		if (visible && (cursor === 'pointer' || ['button','link','textbox','searchbox',
			'checkbox','radio','combobox','listbox','option','menuitem',
			'slider','spinbutton','switch','tab','heading'].includes(role))) {
			result.index = indexCounter++;
			if (el.tagName === 'A' && el.href) result.href = el.href;
			if (el.id) result.id = el.id;
		}

		// shadow DOM
		if (el.shadowRoot) {
			for (let c = el.shadowRoot.firstChild; c; c = c.nextSibling) {
				const child = buildTree(c, visited);
				if (child) result.children.push(child);
			}
		}

		// regular children
		for (let c = el.firstChild; c; c = c.nextSibling) {
			if (c.assignedSlot) continue;
			const child = buildTree(c, visited);
			if (child) result.children.push(child);
		}

		// aria-owns
		if (el.hasAttribute('aria-owns')) {
			for (const id of el.getAttribute('aria-owns').split(/\s+/)) {
				const owned = document.getElementById(id);
				if (owned) {
					const child = buildTree(owned, visited);
					if (child) result.children.push(child);
				}
			}
		}

		return result;
	}

	// ── Find answer region ──────────────────────────
	// Locale-agnostic: finds the LAST Copilot AI message container.
	// Copilot uses consistent CSS patterns across locales:
	//   - AI messages: class contains "ai-message" or "response"
	//   - User messages: different class prefix
	//   - We take the LAST ai-message container in DOM order.
	function findAnswerRegion() {
		// Look for AI message containers with the known Copilot class pattern
		// Tailwind-based: group/ai-message, .response-content, etc.
		const allDivs = document.querySelectorAll('div[class*="ai-message"], div[class*="response-content"], div[class*="message"]');
		let best = null;
		for (const el of allDivs) {
			const text = (el.innerText || '');
			if (text.length > 100) best = el;  // take last one with substantial text
		}
		if (best) return best;

		// Fallback: walk the DOM looking for containers with role=region/article
		// and substantial text, take the last one.
		const containers = [];
		(function walk(el) {
			if (!el || el.nodeType !== 1) return;
			const role = el.getAttribute('role');
			const cls = (el.className || '').toString();
			if (role === 'region' || role === 'article' ||
				cls.includes('ac-container')) {
				const text = (el.innerText || '');
				if (text.length > 100) containers.push(el);
			}
			for (const c of el.children) walk(c);
		})(document.body);
		if (containers.length > 0) return containers[containers.length - 1];

		return document.body;
	}

	// ── Extract text from tree ──────────────────────
	// Returns a normalized string. Block elements get newlines.
	// Inline elements flow with whitespace separation.
	// Locale-agnostic: filters by role/structure only, never by text content.
	function extractText(node, isInline = false) {
		if (typeof node === 'string') return node;
		if (!node) return '';

		// Skip UI buttons entirely
		if (node.role === 'button') return '';

		const parts = [];

		// heading → markdown heading with surrounding newlines (block)
		if (node.role === 'heading') {
			const level = parseInt(node.tag?.[1]) || 2;
			const inner = node.children.map(c => extractText(c)).join('');
			if (inner.trim()) parts.push('\n' + '#'.repeat(level) + ' ' + inner.trim() + '\n');
		}

		// link → markdown link (inline if inside text, block otherwise)
		else if (node.role === 'link' && node.href) {
			const text = node.children.map(c => extractText(c)).join('').trim();
			if (text && node.href.startsWith('http')) {
				parts.push('[' + text + '](' + node.href + ')');
			} else if (text) {
				parts.push(text);
			}
		}

		// listitem → preserve structure (block)
		else if (node.role === 'listitem') {
			const text = node.children.map(c => extractText(c)).join('').trim();
			if (text) parts.push('\n- ' + text);
		}

		// code blocks
		else if (node.tag === 'CODE' || node.tag === 'PRE') {
			const text = node.children.map(c => extractText(c)).join('').trim();
			if (text) parts.push('\n\x60\x60\x60\n' + text + '\n\x60\x60\x60\n');
		}

		// paragraph — block level, newlines around
		else if (node.role === 'paragraph') {
			const text = node.children.map(c => extractText(c)).join('').trim();
			if (text) parts.push('\n' + text + '\n');
		}

		// generic/inline — flow text, join tight (whitespace already in text nodes)
		else {
			for (const child of node.children) {
				parts.push(extractText(child));
			}
		}

		return parts.join('');
	}

	// ── Collect sources ──────────────────────────
	function collectLinks(node) {
		const links = [];
		function walk(n) {
			if (typeof n === 'string') return;
			if (!n) return;
			if (n.role === 'link' && n.href && n.href.startsWith('http') &&
				!n.href.includes('copilot.microsoft.com') &&
				!n.href.includes('bing.com') &&
				!n.href.includes('microsoft.com/privacy')) {
				links.push({ title: n.name || '', url: n.href });
			}
			for (const c of n.children) walk(c);
		}
		walk(node);
		// deduplicate by url
		const seen = new Set();
		return links.filter(l => { if (seen.has(l.url)) return false; seen.add(l.url); return true; });
	}

	// ── Execute ──────────────────────────────────
	try {
		// Wait for the answer to actually render — the stream may be "complete"
		// but React hasn't painted the AI message yet. Poll for ai-message content.
		await new Promise(r => setTimeout(r, 400));

		const deadline = Date.now() + 8000;
		let answerEl = null;
		while (Date.now() < deadline) {
			answerEl = findAnswerRegion();
			if (answerEl && (answerEl.innerText || '').length > 200) break;
			answerEl = null;
			await new Promise(r => setTimeout(r, 500));
		}

		if (!answerEl) {
			return JSON.stringify({ error: 'No answer region found (content too short or not rendered)', answer: '', sources: [] });
		}

		if (!answerEl) {
			return JSON.stringify({ error: 'No answer region found', answer: '', sources: [] });
		}

		const tree = buildTree(answerEl);
		if (!tree) {
			return JSON.stringify({ error: 'ARIA tree build failed', answer: '', sources: [] });
		}

		const text = extractText(tree);

		// Post-process: structural normalization only (locale-agnostic)
		// Buttons are already filtered by role in extractText.
		// Deduplication handles Copilot's mobile+desktop DOM variants.
		let clean = text
			.replace(/\n{3,}/g, '\n\n')
			.replace(/^\s+|\s+$/g, '')
			.trim();

		// Strip leading heading if it's the Copilot "X said" label
		// (locale-agnostic: just checks for markdown heading syntax at start)
		clean = clean.replace(/^#{1,6}\s+.+?\n\n/, '');

		// Deduplicate: Copilot sends duplicate DOM for responsive variants
		const lines = clean.split('\n');
		const seen = new Set();
		const deduped = [];
		for (const line of lines) {
			const normalized = line.trim();
			if (!normalized) { deduped.push(''); continue; }
			if (normalized.length <= 2 && /^[-–—•·]$/.test(normalized)) continue;
			if (seen.has(normalized)) continue;
			seen.add(normalized);
			deduped.push(line);
		}
		clean = deduped.join('\n').replace(/\n{3,}/g, '\n\n').trim();

		const sources = collectLinks(tree).slice(0, 10);

		return JSON.stringify({ answer: clean, sources });
	} catch (e) {
		return JSON.stringify({ error: e.toString(), answer: '', sources: [] });
	}
})()
`;

async function extractAnswer(tab) {
	console.error("[bing-aria] Extracting answer via ARIA tree...");

	const resultRaw = await cdp(["eval", tab, EXTRACT_ARIA_JS], 45000);

	let result;
	try {
		result = JSON.parse(resultRaw);
	} catch {
		throw new Error(
			`ARIA extraction returned invalid JSON: ${resultRaw.slice(0, 200)}`,
		);
	}

	if (result.error) {
		throw new Error(`ARIA extraction failed: ${result.error}`);
	}

	const { answer, sources: ariaSources } = result;

	if (!answer || answer.length < 10) {
		throw new Error(
			`ARIA extraction returned insufficient content (${answer?.length || 0} chars)`,
		);
	}

	// Hybrid: click copy button for markdown sources only (answer already extracted via ARIA).
	// At this point the copy button is guaranteed rendered — no hydration race, no retries.
	const GLOBAL_VAR = "__bingAriaClipboard";
	await injectClipboardInterceptor(tab, GLOBAL_VAR);
	const clipSources = await grabClipboardSources(tab, GLOBAL_VAR);
	console.error(`[bing-aria] Clipboard sources: ${clipSources.length}`);

	// Merge: ARIA DOM sources + clipboard markdown sources
	const allSources = [...ariaSources, ...clipSources]
		.filter((v, i, arr) => arr.findIndex((x) => x.url === v.url) === i)
		.slice(0, 10);

	console.error(
		`[bing-aria] Extracted ${answer.length} chars, ${allSources.length} sources`,
	);
	return { answer: answer.trim(), sources: allSources };
}

/**
 * Click the Bing copy button, grab clipboard markdown, extract just the [title](url) sources.
 * Lightweight — no retries, no hydration delay (button is already visible at this point).
 */
async function grabClipboardSources(tab, globalVar) {
	try {
		// Click last copy button (the most recent AI message)
		const copyBtn = S.copyButton;
		await cdp([
			"eval",
			tab,
			`(() => {
				window.${globalVar} = '';
				const buttons = document.querySelectorAll('${copyBtn}');
				buttons[buttons.length - 1]?.click();
			})()`,
		]);

		// Poll clipboard briefly (2s max — if it doesn't work, no big deal)
		const deadline = Date.now() + 2000;
		while (Date.now() < deadline) {
			const text = await cdp(["eval", tab, `window.${globalVar} || ''`]).catch(
				() => "",
			);
			if (text && text.length > 20) {
				return parseSourcesFromMarkdown(text);
			}
			await new Promise((r) => setTimeout(r, 200));
		}
	} catch (e) {
		console.error(`[bing-aria] Clipboard source grab failed: ${e.message}`);
	}
	return [];
}

// ============================================================================
// Main
// ============================================================================

const USAGE =
	'Usage: node extractors/bing-aria.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);

	try {
		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

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

		const verifyResult = await handleVerification(tab, cdp, 10000);
		if (verifyResult === "needs-human") {
			throw new Error(
				"Copilot verification required — please solve it manually in the browser window",
			);
		}

		if (verifyResult === "clicked") {
			await new Promise((r) => setTimeout(r, TIMING.afterVerify));
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

		const inputReady = await waitForSelector(tab, S.input, 15000, 500);
		await new Promise((r) => setTimeout(r, jitter(300)));

		if (!inputReady) {
			throw new Error(
				"Copilot input not found — verification may have failed or page is in unexpected state",
			);
		}

		// NO clipboard interceptor needed — ARIA extraction reads the DOM directly
		await cdp(["click", tab, S.input]);
		await new Promise((r) => setTimeout(r, TIMING.postClick));
		await cdp(["type", tab, query]);
		await new Promise((r) => setTimeout(r, TIMING.postType));

		await cdp([
			"eval",
			tab,
			`document.querySelector('${S.input}')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`,
		]);

		// Wait for Copilot's response to finish streaming
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

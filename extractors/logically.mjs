#!/usr/bin/env node

// extractors/logically.mjs
// Navigate logically.app/research-assistant, submit a question, wait for the
// answer to stream, then extract the rendered answer HTML and citation popovers.
//
// Usage:
//   node extractors/logically.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { query, url, answer, answerHtml, sources }
// Errors go to stderr only — stdout is always clean JSON for piping.

import {
	buildEnvelope,
	cdp,
	cdpWithInput,
	formatAnswer,
	getOrOpenTab,
	handleError,
	jitter,
	logStage,
	outputJson,
	parseArgs,
	prepareArgs,
	TIMING,
	validateQuery,
	waitForSelector,
} from "./common.mjs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ensureChrome } from "../src/search/chrome.mjs";

const START_URL = "https://logically.app/research-assistant/";

const SELECTORS = {
	input:
		'.chat-control div.ProseMirror[contenteditable="true"][role="textbox"]',
	submitButton: '.chat-control button[class*="MuiButton-black"]',
	answerContainer: "#last-message .chat-content",
	citationSpan: "#last-message .chat-content span[title]",
};

async function startNewChat(tab) {
	// Best-effort. A new navigation usually lands on a blank prompt, but if the
	// SPA restores the previous anonymous chat, the sidebar Create button resets it.
	const code = `(() => {
		const buttons = Array.from(document.querySelectorAll('button'));
		const create = buttons.find((b) => (b.innerText || '').trim() === 'Create');
		if (!create) return 'missing';
		create.click();
		return 'clicked';
	})()`;
	return cdp(["eval", tab, code], 5000).catch(() => "error");
}

async function detectLoginWall(tab) {
	const code = `(() => {
		const url = document.location.href || '';
		if (url.includes('/login') || url.includes('/signup') || url.includes('/sign-up')) return true;
		const modalText = Array.from(document.querySelectorAll('[role="dialog"], .MuiModal-root'))
			.map((el) => el.innerText || '')
			.join('\n');
		return /create a free account|continue with google|have an account[?] log in|log in|sign up/i.test(modalText);
	})()`;
	return (await cdp(["eval", tab, code], 5000).catch(() => "false")) === "true";
}

async function activateTab(tab) {
	try {
		await cdp(["list"]);
		const cachePath = `${tmpdir().replaceAll("\\\\", "/")}/cdp-pages.json`;
		const pages = JSON.parse(readFileSync(cachePath, "utf8"));
		const fullTargetId = pages.find((p) =>
			p.targetId?.startsWith(tab),
		)?.targetId;
		if (fullTargetId) {
			await cdp([
				"browse",
				tab,
				"Target.activateTarget",
				JSON.stringify({ targetId: fullTargetId }),
			]).catch(() => null);
			await new Promise((r) => setTimeout(r, 250));
		}
	} catch {
		// Best-effort only. Headless does not need activation, and visible Chrome
		// still often accepts CDP input without it.
	}
}

async function typeIntoLogically(tab, text) {
	await activateTab(tab);
	const pointRaw = await cdp([
		"eval",
		tab,
		`(() => {
			const inputs = Array.from(document.querySelectorAll('${SELECTORS.input}'));
			const input = inputs.find((el) => {
				const r = el.getBoundingClientRect();
				return r.width > 20 && r.height > 5;
			});
			if (!input) return '';
			input.scrollIntoView({ block: 'center', inline: 'center' });
			const r = input.getBoundingClientRect();
			return JSON.stringify({ x: Math.round(r.left + Math.min(80, r.width / 2)), y: Math.round(r.top + r.height / 2) });
		})()`,
	]);
	if (!pointRaw) throw new Error("Logically visible input not found");
	const point = JSON.parse(pointRaw);
	// Use both selector click and coordinate click. The ProseMirror editor is
	// sometimes nested in animated MUI layout; selector click can land on a stale
	// box, while coordinate click reliably focuses the visible editor after the
	// in-page scrollIntoView above.
	await cdp(["click", tab, SELECTORS.input]).catch(() => null);
	await new Promise((r) => setTimeout(r, jitter(120)));
	await cdp(["clickxy", tab, String(point.x), String(point.y)]);
	await new Promise((r) => setTimeout(r, jitter(TIMING.postClick)));
	await cdpWithInput(["type", tab, "--stdin"], text);
	await new Promise((r) => setTimeout(r, jitter(TIMING.postType)));

	const inserted = await cdp([
		"eval",
		tab,
		`Array.from(document.querySelectorAll('${SELECTORS.input}')).some((el) => (el.innerText || '').length >= ${Math.floor(text.length * 0.8)})`,
	]);
	if (inserted !== "true") {
		throw new Error(
			"Logically input did not accept text — input verification failed",
		);
	}
}

async function waitForLogicallyAnswer(tab, timeoutMs = 90000) {
	const code = String.raw`
	new Promise((resolve, reject) => {
		const deadline = Date.now() + ${timeoutMs};
		let last = '';
		let stable = 0;
		function poll() {
			try {
				const answer = document.querySelector('${SELECTORS.answerContainer}');
				const text = (answer?.innerText || '').trim();
				const body = document.body.innerText || '';
				const stillGenerating = /Generating answer|Thinking\.\.\.|Searching the internet|Discovered \d+/.test(body) && text.length < 200;
				if (text.length >= 200 && !stillGenerating) {
					if (text === last) stable += 1;
					else { last = text; stable = 0; }
					if (stable >= 3) { resolve(text.length); return; }
				}
				if (Date.now() < deadline) setTimeout(poll, 700 + Math.random() * 250);
				else reject(new Error('Logically answer did not stabilise within ${timeoutMs}ms'));
			} catch (e) { reject(e); }
		}
		poll();
	})`;
	return cdp(["eval", tab, code], timeoutMs + 10000);
}

async function extractAnswer(tab) {
	const code = `(() => {
		const el = document.querySelector('${SELECTORS.answerContainer}');
		if (!el) return JSON.stringify({ answer: '', answerHtml: '' });
		const clone = el.cloneNode(true);
		clone.querySelectorAll('svg').forEach((n) => n.remove());
		clone.querySelectorAll('span[width], span[height]').forEach((n) => {
			if (!(n.innerText || '').trim()) n.remove();
		});
		return JSON.stringify({
			answer: (el.innerText || '').trim(),
			answerHtml: clone.innerHTML,
		});
	})()`;
	return JSON.parse(await cdp(["eval", tab, code], 10000));
}

async function extractFullCitationSources(tab) {
	// The rendered answer has inline citations, but the complete citation set is
	// behind the `Citations (N)` button. Click it and parse the popover's Academic
	// cards plus Web URL blocks. This is the only place where Logically exposes
	// the full citation count (for example Academic (20) + Web (29) = 49).
	const code = String.raw`
	(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

		function clickElement(el) {
			el.scrollIntoView({ block: 'center', inline: 'center' });
			for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
				el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
			}
		}

		function waitForFullCitationsPopover() {
			return new Promise((resolve) => {
				const deadline = Date.now() + 5000;
				function poll() {
					const pop = Array.from(document.querySelectorAll('.MuiPopover-root'))
						.find((el) => /Academic \(\d+\)|Web \(\d+\)/.test(el.innerText || ''));
					if (pop) { resolve(pop); return; }
					if (Date.now() < deadline) setTimeout(poll, 100);
					else resolve(null);
				}
				poll();
			});
		}

		function linesOf(el) {
			return (el?.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
		}

		function textAfter(label, text) {
			const re = new RegExp(label + ':\\s*([^\\n]+)', 'i');
			return text.match(re)?.[1]?.trim() || '';
		}

		function parseAcademicCard(card, idx) {
			const lines = linesOf(card);
			const text = lines.join('\n');
			const citationCount = Number((lines[1] || '').match(/\d+/)?.[0] || '') || null;
			return {
				type: 'academic',
				citationIndex: idx + 1,
				url: '',
				title: lines[2] || '',
				authors: lines[3] || textAfter('Authors', text),
				venue: lines[4] || textAfter('Journal', text),
				publicationDate: textAfter('Publication Date', text),
				citationCount,
				references: Number(text.match(/References:\s*(\d+)/i)?.[1] || '') || null,
				fieldsOfStudy: textAfter('Fields of Study', text),
				publicationTypes: textAfter('Publication Types', text),
				snippet: lines.find((line) => /^(TLDR|Abstract):/i.test(line)) || '',
			};
		}

		function isUrlBlockAnchor(a) {
			let n = a;
			for (let i = 0; n && i < 5; i++, n = n.parentElement) {
				if (/^URL:\s*/.test((n.innerText || '').trim())) return true;
			}
			return false;
		}

		function parseWebAnchor(a, idx) {
			let card = a;
			for (let i = 0; card && i < 10; i++, card = card.parentElement) {
				const text = card.innerText || '';
				if (/\nUpdated:\s*/.test(text) && /\nURL:\s*/.test(text)) break;
			}
			const lines = linesOf(card || a.parentElement);
			const url = a.href || '';
			let title = lines.find((line) => line && !/^URL:|^Updated:|^Add to library$|^View$/.test(line) && line !== a.innerText) || '';
			if (/^[\w.-]+\.[a-z]{2,}$/i.test(title)) title = lines[1] || title;
			return {
				type: 'web',
				citationIndex: idx + 1,
				url,
				title: title || a.innerText || url,
				domain: (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
				updated: textAfter('Updated', lines.join('\n')),
				snippet: lines.filter((line) => !/^URL:|^Updated:|^Add to library$|^View$/.test(line)).slice(0, 8).join('\n'),
			};
		}

		const btn = Array.from(document.querySelectorAll('button'))
			.find((b) => /Citations\s*\n*\s*\(\d+\)/i.test(b.innerText || ''));
		if (!btn) return JSON.stringify({ sources: [], summary: { expectedTotal: 0, academic: 0, web: 0, reason: 'button-not-found' } });
		clickElement(btn);
		const pop = await waitForFullCitationsPopover();
		if (!pop) return JSON.stringify({ sources: [], summary: { expectedTotal: 0, academic: 0, web: 0, reason: 'popover-not-found' } });

		const header = pop.innerText || '';
		const academicExpected = Number(header.match(/Academic \((\d+)\)/)?.[1] || '0');
		const webExpected = Number(header.match(/Web \((\d+)\)/)?.[1] || '0');
		const allDivs = Array.from(pop.querySelectorAll('div'));
		const academicCandidates = allDivs.filter((el) => {
			const text = (el.innerText || '').trim();
			return /^Academic\n\n/.test(text) && text.includes('\nView');
		});
		const academicCards = academicCandidates.filter((el) =>
			!academicCandidates.some((other) => other !== el && el.contains(other))
		);
		const academicSources = academicCards.map(parseAcademicCard).filter((s) => s.title);

		const webAnchors = Array.from(pop.querySelectorAll('a[href]')).filter(isUrlBlockAnchor);
		const webSources = webAnchors.map(parseWebAnchor).filter((s) => s.url);

		return JSON.stringify({
			sources: [...academicSources, ...webSources],
			summary: {
				expectedTotal: academicExpected + webExpected,
				academicExpected,
				webExpected,
				academicCaptured: academicSources.length,
				webCaptured: webSources.length,
			},
		});
	})()`;
	const raw = await cdp(["eval", tab, code], 20000);
	return JSON.parse(raw);
}

async function extractCitationSources(tab) {
	// Logically renders citation labels inside the answer as clickable spans.
	// The actual source URL and metadata are mounted into a MUI Popover only
	// after clicking the span. This single browser-side async routine clicks the
	// distinct citation spans, walks grouped citations with the next button, and
	// returns the popover metadata without Node-side DOM polling.
	const code = String.raw`
	(async () => {
		const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
		const answer = document.querySelector('${SELECTORS.answerContainer}');
		if (!answer) return JSON.stringify([]);

		function parseUrlFromId(id) {
			const m = String(id || '').match(/^citation-(https?:\/\/.+)-(\d+)$/);
			return m ? { url: m[1], index: Number(m[2]) } : { url: '', index: null };
		}

		function scrapePopover() {
			const pop = document.querySelector('.MuiPopover-root[id^="citation-"]');
			if (!pop) return null;
			const lines = (pop.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
			const posIdx = lines.findIndex((line) => /^\d+\s+of\s+\d+$/i.test(line));
			const { url, index } = parseUrlFromId(pop.id);
			const citationCountLine = lines.find((line) => /^\d+\s+citations?$/i.test(line));
			return {
				url,
				index,
				type: lines[0] || '',
				citationCount: citationCountLine ? Number(citationCountLine.match(/\d+/)?.[0]) : null,
				position: posIdx !== -1 ? lines[posIdx] : '',
				title: posIdx !== -1 ? (lines[posIdx + 1] || '') : '',
				authors: posIdx !== -1 ? (lines[posIdx + 2] || '') : '',
				venue: posIdx !== -1 ? (lines[posIdx + 3] || '') : '',
				snippet: lines.find((line) => /^(TLDR|Abstract|Snippet|Description):/i.test(line)) || '',
			};
		}

		async function waitForPopover(previousId = '') {
			const deadline = Date.now() + 4000;
			while (Date.now() < deadline) {
				const pop = document.querySelector('.MuiPopover-root[id^="citation-"]');
				if (pop && pop.id !== previousId) return pop;
				await sleep(100);
			}
			return document.querySelector('.MuiPopover-root[id^="citation-"]');
		}

		function clickElement(el) {
			el.scrollIntoView({ block: 'center', inline: 'center' });
			for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
				el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
			}
		}

		const spans = Array.from(answer.querySelectorAll('span[title]'))
			.filter((s) => (s.innerText || s.title || '').trim());
		const groups = [];
		const seenGroups = new Set();
		for (const span of spans) {
			const text = (span.innerText || '').trim();
			const plus = Number(text.match(/\(\+(\d+)\)/)?.[1] || '0');
			const key = String(span.title) + '::' + String(plus);
			if (seenGroups.has(key)) continue;
			seenGroups.add(key);
			groups.push({ span, title: span.title, count: Math.min(plus + 1, 12) });
			if (groups.length >= 25) break;
		}

		const sources = [];
		const seenUrls = new Set();
		for (const group of groups) {
			const previous = document.querySelector('.MuiPopover-root[id^="citation-"]')?.id || '';
			clickElement(group.span);
			await waitForPopover(previous);
			for (let i = 0; i < group.count; i++) {
				await sleep(150);
				const src = scrapePopover();
				if (src) {
					if (!src.title) src.title = group.title;
					if (src.url && !seenUrls.has(src.url)) {
						seenUrls.add(src.url);
						sources.push(src);
					} else if (!src.url) {
						const key = 'title:' + String(src.title || '');
						if (!seenUrls.has(key)) { seenUrls.add(key); sources.push(src); }
					}
				}
				if (i < group.count - 1) {
					const pop = document.querySelector('.MuiPopover-root[id^="citation-"]');
					const before = pop?.id || '';
					const buttons = Array.from(pop?.querySelectorAll('button') || []);
					const next = buttons.find((b) => !b.disabled && !(b.innerText || '').trim());
					if (!next) break;
					next.click();
					await waitForPopover(before);
				}
			}
		}

		if (sources.length === 0) {
			for (const span of spans) {
				const title = span.title || (span.innerText || '').trim();
				const key = 'title:' + String(title || '');
				if (title && !seenUrls.has(key)) {
					seenUrls.add(key);
					sources.push({ title, url: '', type: 'citation-label' });
				}
			}
		}
		return JSON.stringify(sources);
	})()`;
	const raw = await cdp(["eval", tab, code], 45000);
	return JSON.parse(raw);
}

const USAGE =
	'Usage: node extractors/logically.mjs "<query>" [--tab <prefix>]\n';

async function main() {
	const args = await prepareArgs(process.argv.slice(2));
	validateQuery(args, USAGE);

	const { query, tabPrefix, short } = parseArgs(args);
	const startTime = Date.now();
	const mode =
		process.env.GREEDY_SEARCH_VISIBLE === "1" ? "visible" : "headless";
	const env = {
		engine: "logically",
		mode,
		clipboardEmpty: null,
		fallbackUsed: null,
		blockedBy: null,
		verificationResult: null,
		inputReady: null,
	};

	try {
		if (
			process.env.GREEDY_SEARCH_VISIBLE !== "1" &&
			process.env.GREEDY_SEARCH_ALWAYS_VISIBLE !== "1"
		) {
			process.env.GREEDY_SEARCH_HEADLESS = "1";
		}
		await ensureChrome();

		if (!tabPrefix) await cdp(["list"]);
		const tab = await getOrOpenTab(tabPrefix);

		const currentUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		let onLogically = false;
		try {
			const host = new URL(currentUrl).hostname.toLowerCase();
			onLogically = host === "logically.app" || host.endsWith(".logically.app");
		} catch {}

		if (!onLogically) {
			logStage(env, "nav", startTime);
			await cdp(["nav", tab, START_URL], 25000);
			await new Promise((r) => setTimeout(r, 900));
		}

		logStage(env, "new-chat", startTime);
		await startNewChat(tab);
		await new Promise((r) => setTimeout(r, 700));

		logStage(env, "input-wait", startTime);
		const inputReady = await waitForSelector(tab, SELECTORS.input, 20000, 400);
		env.inputReady = inputReady;
		if (!inputReady) {
			throw new Error(
				"Logically input not found — page may not have loaded or is in unexpected state",
			);
		}

		logStage(env, "type-and-submit", startTime);
		await typeIntoLogically(tab, query);
		const submitted = await cdp([
			"eval",
			tab,
			`(() => { const btn = document.querySelector('${SELECTORS.submitButton}'); if (!btn) return 'missing'; btn.click(); return 'clicked'; })()`,
		]);
		if (submitted !== "clicked")
			throw new Error("Logically submit button not found");

		// Anonymous sessions have a small free-message quota. Once exhausted,
		// Logically opens a sign-up/login modal instead of generating an answer.
		// Surface this like Consensus so the orchestrator can switch to visible
		// Chrome and leave the browser open for the user to authenticate.
		await new Promise((r) => setTimeout(r, 1500));
		if (await detectLoginWall(tab)) {
			env.blockedBy = "signin";
			env.verificationResult = "needs-human";
			throw new Error(
				"Logically login required — please log in or create a free account in the visible browser window. Once signed in, cookies persist for future runs.",
			);
		}

		logStage(env, "answer-wait", startTime);
		await waitForLogicallyAnswer(tab, 90000);

		logStage(env, "extract-answer-html", startTime);
		const { answer, answerHtml } = await extractAnswer(tab);
		if (!answer)
			throw new Error("No answer extracted — Logically may not have responded");

		logStage(env, "extract-inline-citations", startTime);
		const inlineSources = await extractCitationSources(tab);

		logStage(env, "extract-full-citations", startTime);
		const fullCitations = await extractFullCitationSources(tab);
		const sources = fullCitations.sources?.length
			? fullCitations.sources
			: inlineSources;

		const finalUrl = await cdp(["eval", tab, "document.location.href"]).catch(
			() => "",
		);
		env.durationMs = Date.now() - startTime;
		env.sourcePath = fullCitations.sources?.length
			? "citations-popover"
			: "inline-citation-popovers";
		logStage(env, "done", startTime);

		outputJson({
			query,
			url: finalUrl,
			answer: formatAnswer(answer, short),
			answerHtml,
			sources,
			inlineSources,
			citationSummary: fullCitations.summary,
			_envelope: buildEnvelope(env),
		});
	} catch (e) {
		env.durationMs = Date.now() - startTime;
		handleError(e, buildEnvelope(env));
	}
}

main();

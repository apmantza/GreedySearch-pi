#!/usr/bin/env node

// search.mjs - unified CLI for GreedySearch extractors
//
// Usage:
//   node search.mjs <engine> "<query>"
//   node search.mjs all "<query>"
//
// Engines:
//   perplexity | pplx | p
//   bing       | copilot | b
//   google     | g
//   gemini     | gem
//   all        - fan-out to all engines in parallel
//
// Output: JSON to stdout, errors to stderr
//
// Examples:
//   node search.mjs p "what is memoization"
//   node search.mjs gem "latest React features"
//   node search.mjs all "how does TCP congestion control work"

import { existsSync, readFileSync } from "node:fs";
// Config file for user defaults
import { homedir } from "node:os";
import { join } from "node:path";
import {
	activateTab,
	cdp,
	closeTab,
	closeTabs,
	ensureChrome,
	openNewTab,
} from "../src/search/chrome.mjs";
import { ALL_ENGINES, ENGINES } from "../src/search/constants.mjs";
import { runExtractor } from "../src/search/engines.mjs";
import {
	fetchMultipleSources,
	fetchTopSource,
} from "../src/search/fetch-source.mjs";
import { writeOutput } from "../src/search/output.mjs";
import {
	buildSourceRegistry,
	mergeFetchDataIntoSources,
} from "../src/search/sources.mjs";
import { buildConfidence } from "../src/search/synthesis.mjs";
import { synthesizeWithGemini } from "../src/search/synthesis-runner.mjs";

const CONFIG_DIR = join(homedir(), ".config", "greedysearch");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function loadUserConfig() {
	try {
		if (existsSync(CONFIG_FILE)) {
			return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
		}
	} catch {
		// Ignore errors
	}
	return {};
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
	const args = process.argv.slice(2);
	if (args.length < 2 || args[0] === "--help") {
		process.stderr.write(
			`${[
				'Usage: node search.mjs <engine> "<query>"',
				"",
				"Engines: perplexity (p), bing (b), google (g), gemini (gem), all",
				"",
				"Flags:",
				"  --fast              Quick mode: no source fetching or synthesis",
				"  --synthesize        Deprecated: synthesis is now default for multi-engine",
				"  --deep-research     Deprecated: source fetching is now default",
				"  --fetch-top-source  Fetch content from top source",
				"  --inline            Output JSON to stdout (for piping)",
				"  --locale <lang>     Force results language (en, de, fr, etc.)",
				"",
				"Environment:",
				"  GREEDY_SEARCH_LOCALE    Default locale (default: en)",
				"  GREEDY_SEARCH_VISIBLE   Set to 1 to show Chrome window",
				"",
				"Examples:",
				'  node search.mjs all "Node.js streams"           # Default: sources + synthesis',
				'  node search.mjs all "quick check" --fast        # Fast: no sources/synthesis',
				'  node search.mjs p "what is memoization"         # Single engine: fast mode',
			].join("\n")}\n`,
		);
		process.exit(1);
	}

	await ensureChrome();

	// Depth modes: fast (no synthesis/fetch), standard (synthesis+fetch 5 sources)
	const depthIdx = args.indexOf("--depth");
	let depth = "standard"; // DEFAULT: synthesis + source fetch

	if (depthIdx !== -1 && args[depthIdx + 1]) {
		depth = args[depthIdx + 1];
	} else if (args.includes("--fast")) {
		depth = "fast"; // Explicit fast mode requested
	}

	// For single engine (not "all"), default to fast unless explicit
	const engineArg = args.find((a) => !a.startsWith("--"))?.toLowerCase();
	if (engineArg !== "all" && depthIdx === -1 && !args.includes("--fast")) {
		depth = "fast";
	}

	// --deep-research / --deep flags map to deep mode (backward compat)
	if (args.includes("--deep-research")) {
		depth = "standard";
		process.stderr.write(
			"[greedysearch] --deep-research is deprecated; use --depth standard (now default)\n",
		);
	}
	if (args.includes("--deep")) {
		depth = "deep";
	}
	if (args.includes("--synthesize")) {
		process.stderr.write(
			"[greedysearch] --synthesize is deprecated; synthesis is now default for multi-engine\n",
		);
	}

	const full = args.includes("--full");
	const short = !full;
	const fetchSource = args.includes("--fetch-top-source");
	const inline = args.includes("--inline");
	const outIdx = args.indexOf("--out");
	const outFile = outIdx !== -1 ? args[outIdx + 1] : null;

	// Locale handling: CLI flag > env var > config file > default (en)
	const localeIdx = args.indexOf("--locale");
	const envLocale = process.env.GREEDY_SEARCH_LOCALE;
	const userConfig = loadUserConfig();
	let locale = "en"; // Default to English

	if (localeIdx !== -1 && args[localeIdx + 1]) {
		locale = args[localeIdx + 1];
	} else if (envLocale) {
		locale = envLocale;
	} else if (userConfig.locale) {
		locale = userConfig.locale;
	}
	const rest = args.filter(
		(a, i) =>
			a !== "--full" &&
			a !== "--short" &&
			a !== "--fast" &&
			a !== "--fetch-top-source" &&
			a !== "--synthesize" &&
			a !== "--deep-research" &&
			a !== "--deep" &&
			a !== "--inline" &&
			a !== "--depth" &&
			a !== "--out" &&
			a !== "--help" &&
			(depthIdx === -1 || i !== depthIdx + 1) &&
			(outIdx === -1 || i !== outIdx + 1),
	);
	const engine = rest[0].toLowerCase();
	const query = rest.slice(1).join(" ");

	if (engine === "all") {
		await cdp(["list"]); // refresh pages cache

		// Create fresh tabs for each engine to avoid race conditions
		const engineTabs = [];
		for (let i = 0; i < ALL_ENGINES.length; i++) {
			if (i > 0) await new Promise((r) => setTimeout(r, 300));
			const tab = await openNewTab();
			engineTabs.push(tab);
		}

		try {
			const results = await Promise.allSettled(
				ALL_ENGINES.map((e, i) =>
					runExtractor(ENGINES[e], query, engineTabs[i], short, null, locale)
						.then((r) => {
							process.stderr.write(`PROGRESS:${e}:done\n`);
							return { engine: e, ...r };
						})
						.catch((err) => {
							process.stderr.write(`PROGRESS:${e}:error\n`);
							throw err;
						}),
				),
			);

			const out = {};
			for (let i = 0; i < results.length; i++) {
				const r = results[i];
				if (r.status === "fulfilled") {
					out[r.value.engine] = r.value;
				} else {
					out[ALL_ENGINES[i]] = { error: r.reason?.message || "unknown error" };
				}
			}

			// Build a canonical source registry across all engines
			out._sources = buildSourceRegistry(out, query);

			// Source fetching: default for all "all" searches
			if (depth !== "fast" && out._sources.length > 0) {
				process.stderr.write("PROGRESS:source-fetch:start\n");
				const fetchedSources = await fetchMultipleSources(
					out._sources,
					5,
					8000,
				);

				out._sources = mergeFetchDataIntoSources(out._sources, fetchedSources);
				out._fetchedSources = fetchedSources;
				process.stderr.write("PROGRESS:source-fetch:done\n");
			}

			// Synthesize with Gemini for all non-fast modes
			if (depth !== "fast") {
				process.stderr.write("PROGRESS:synthesis:start\n");
				process.stderr.write(
					"[greedysearch] Synthesizing results with Gemini...\n",
				);
				try {
					const geminiTab = await openNewTab();
					await activateTab(geminiTab);
					const synthesis = await synthesizeWithGemini(query, out, {
						grounded: depth === "deep",
						tabPrefix: geminiTab,
					});
					out._synthesis = {
						...synthesis,
						synthesized: true,
					};
					await closeTab(geminiTab);
					process.stderr.write("PROGRESS:synthesis:done\n");
				} catch (e) {
					process.stderr.write(
						`[greedysearch] Synthesis failed: ${e.message}\n`,
					);
					out._synthesis = { error: e.message, synthesized: false };
				}
			}

			if (fetchSource) {
				const top = pickTopSource(out);
				if (top)
					out._topSource = await fetchTopSource(top.canonicalUrl || top.url);
			}

			// Always include confidence metrics for non-fast searches
			if (depth !== "fast") out._confidence = buildConfidence(out);

			writeOutput(out, outFile, {
				inline,
				synthesize: depth !== "fast",
				query,
			});
			return;
		} finally {
			await closeTabs(engineTabs);
		}
	}

	// Single engine
	const script = ENGINES[engine];
	if (!script) {
		process.stderr.write(
			`Unknown engine: "${engine}"\nAvailable: ${Object.keys(ENGINES).join(", ")}\n`,
		);
		process.exit(1);
	}

	try {
		const result = await runExtractor(script, query, null, short, null, locale);
		if (fetchSource && result.sources?.length > 0) {
			result.topSource = await fetchTopSource(result.sources[0].url);
		}
		writeOutput(result, outFile, { inline, synthesize: false, query });
	} catch (e) {
		process.stderr.write(`Error: ${e.message}\n`);
		process.exit(1);
	}
}

function pickTopSource(out) {
	if (Array.isArray(out._sources) && out._sources.length > 0)
		return out._sources[0];
	for (const engine of ["perplexity", "google", "bing"]) {
		const r = out[engine];
		if (r?.sources?.length > 0) return r.sources[0];
	}
	return null;
}

/**
 * Minimize Chrome window via CDP after search completes.
 * Called at the end of search to keep window minimized.
 */
async function minimizeChrome() {
	if (process.env.GREEDY_SEARCH_VISIBLE === "1") return;

	try {
		const http = await import("node:http");
		const version = await new Promise((resolve, reject) => {
			http
				.get(`http://localhost:9222/json/version`, (res) => {
					let body = "";
					res.on("data", (d) => (body += d));
					res.on("end", () => resolve(JSON.parse(body)));
				})
				.on("error", reject);
		});

		const wsUrl = version.webSocketDebuggerUrl;
		const WebSocket = globalThis.WebSocket;
		if (!WebSocket) return;

		const ws = new WebSocket(wsUrl);
		let requestId = 0;
		const pending = new Map();

		ws.onopen = () => {
			const id = ++requestId;
			pending.set(id, {
				resolve: (result) => {
					const targets = result.targetInfos || [];
					const pageTarget = targets.find((t) => t.type === "page");
					if (!pageTarget) {
						ws.close();
						return;
					}

					const winId = ++requestId;
					pending.set(winId, {
						resolve: (winResult) => {
							const windowId = winResult.windowId;
							const minId = ++requestId;
							pending.set(minId, { resolve: () => {}, reject: () => {} });
							ws.send(
								JSON.stringify({
									id: minId,
									method: "Browser.setWindowBounds",
									params: { windowId, bounds: { windowState: "minimized" } },
								}),
							);
							setTimeout(() => ws.close(), 500);
						},
						reject: () => ws.close(),
					});
					ws.send(
						JSON.stringify({
							id: winId,
							method: "Browser.getWindowForTarget",
							params: { targetId: pageTarget.targetId },
						}),
					);
				},
				reject: () => ws.close(),
			});
			ws.send(JSON.stringify({ id, method: "Target.getTargets", params: {} }));
		};

		ws.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id && pending.has(msg.id)) {
				const { resolve, reject } = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error) reject?.(msg.error);
				else resolve?.(msg.result);
			}
		};

		setTimeout(() => ws.close(), 3000);
	} catch {
		// Best-effort
	}
}

main().finally(async () => {
	// Ensure window is minimized after search completes
	await minimizeChrome();
	// Give minimize time to complete before exit
	await new Promise((r) => setTimeout(r, 1500));
});

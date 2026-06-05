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
	cdp,
	closeTab,
	closeTabs,
	ensureChrome,
	killHeadlessChrome,
	openNewTab,
	touchActivity,
} from "../src/search/chrome.mjs";
import { ALL_ENGINES, ENGINES } from "../src/search/constants.mjs";
import { runExtractor } from "../src/search/engines.mjs";
import {
	fetchMultipleSources,
	fetchTopSource,
} from "../src/search/fetch-source.mjs";
import { writeSourcesToFiles } from "../src/search/file-sources.mjs";
import { writeOutput } from "../src/search/output.mjs";
import {
	findHeadlessBlockedEngines,
	isHeadlessBlockedResult,
	isManualVerificationError,
} from "../src/search/recovery.mjs";
import {
	buildSourceRegistry,
	mergeFetchDataIntoSources,
} from "../src/search/sources.mjs";
import { buildConfidence } from "../src/search/synthesis.mjs";
import { synthesizeWithGemini } from "../src/search/synthesis-runner.mjs";
import { normalizeQuery } from "../src/search/query.mjs";
import { runResearchMode } from "../src/search/research.mjs";

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

/** Read query/prompt from stdin (used with --stdin to avoid command-line leakage) */
async function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data.trim()));
		if (process.stdin.isTTY) resolve("");
	});
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
				"  --research          Iterative query/learnings loop (alias: --depth research)",
				"  --breadth <n>       Research mode query breadth, 1-5 (default: 3)",
				"  --iterations <n>    Research mode rounds, 1-3 (default: 2)",
				"  --max-sources <n>   Research mode fetched source cap, 3-12",
				"  --research-out-dir <dir>  Write research bundle to a specific directory",
				"  --no-research-bundle     Disable the default .pi/greedysearch-research bundle",
				"  --fetch-top-source  Fetch content from top source",
				"  --inline            Output JSON to stdout (for piping)",
				"  --locale <lang>     Force results language (en, de, fr, etc.)",
				"  --visible           Always use visible Chrome for this search",
				"  --always-visible    Alias for --visible",
				"  --stdin              Read query from stdin (avoids command-line leakage)",
				"",
				"Environment:",
				"  GREEDY_SEARCH_VISIBLE         Set to 1 to show Chrome window (disables headless)",
				"  GREEDY_SEARCH_ALWAYS_VISIBLE  Set to 1 to force visible mode for all runs",
				"  GREEDY_SEARCH_LOCALE          Default locale (default: en)",
				"",
				"Examples:",
				'  node search.mjs all "Node.js streams"           # Default: sources + synthesis',
				'  node search.mjs all "quick check" --fast        # Fast: no sources/synthesis',
				'  node search.mjs all "browser automation" --research --breadth 3 --iterations 2',
				'  node search.mjs p "what is memoization"         # Single engine: fast mode',
			].join("\n")}\n`,
		);
		process.exit(1);
	}

	const alwaysVisible =
		args.includes("--visible") ||
		args.includes("--always-visible") ||
		process.env.GREEDY_SEARCH_ALWAYS_VISIBLE === "1";
	if (alwaysVisible) {
		process.env.GREEDY_SEARCH_VISIBLE = "1";
		process.env.GREEDY_SEARCH_ALWAYS_VISIBLE = "1";
		delete process.env.GREEDY_SEARCH_HEADLESS;
	} else if (process.env.GREEDY_SEARCH_VISIBLE !== "1") {
		// Establish the desired mode BEFORE ensureChrome() so a stale visible
		// recovery browser is switched back to headless before research planning
		// and Gemini synthesis tabs are opened.
		process.env.GREEDY_SEARCH_HEADLESS = "1";
	}

	await ensureChrome();

	// Track activity for headless idle timeout
	touchActivity();

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
	if (args.includes("--research")) {
		depth = "research";
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
	const breadthIdx = args.indexOf("--breadth");
	const iterationsIdx = args.indexOf("--iterations");
	const maxSourcesIdx = args.indexOf("--max-sources");
	const researchBreadth = breadthIdx === -1 ? undefined : args[breadthIdx + 1];
	const researchIterations =
		iterationsIdx === -1 ? undefined : args[iterationsIdx + 1];
	const researchMaxSources =
		maxSourcesIdx === -1 ? undefined : args[maxSourcesIdx + 1];
	const researchOutDirIdx = args.indexOf("--research-out-dir");
	const researchOutDir =
		researchOutDirIdx === -1 ? undefined : args[researchOutDirIdx + 1];
	const writeResearchBundle = !args.includes("--no-research-bundle");
	const outIdx = args.indexOf("--out");
	const outFile = outIdx === -1 ? null : args[outIdx + 1];

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
			a !== "--research" &&
			a !== "--inline" &&
			a !== "--stdin" &&
			a !== "--headless" &&
			a !== "--visible" &&
			a !== "--always-visible" &&
			a !== "--depth" &&
			a !== "--out" &&
			a !== "--locale" &&
			a !== "--breadth" &&
			a !== "--iterations" &&
			a !== "--max-sources" &&
			a !== "--research-out-dir" &&
			a !== "--no-research-bundle" &&
			a !== "--help" &&
			(depthIdx === -1 || i !== depthIdx + 1) &&
			(outIdx === -1 || i !== outIdx + 1) &&
			(localeIdx === -1 || i !== localeIdx + 1) &&
			(breadthIdx === -1 || i !== breadthIdx + 1) &&
			(iterationsIdx === -1 || i !== iterationsIdx + 1) &&
			(maxSourcesIdx === -1 || i !== maxSourcesIdx + 1) &&
			(researchOutDirIdx === -1 || i !== researchOutDirIdx + 1),
	);
	const engine = rest[0]?.toLowerCase();
	// Read query from stdin when --stdin flag is set (avoids leaking query in process table)
	const useStdin = args.includes("--stdin");
	let query;
	if (useStdin) {
		query = await readStdin();
	} else {
		query = rest.slice(1).join(" ");
	}

	if (depth === "research") {
		if (engine !== "all") {
			process.stderr.write(
				`[greedysearch] Research mode uses all engines; ignoring engine "${engine}".\n`,
			);
		}
		const out = await runResearchMode({
			query: normalizeQuery(query),
			breadth: researchBreadth,
			iterations: researchIterations,
			maxSources: researchMaxSources,
			locale,
			short,
			writeBundle: writeResearchBundle,
			researchOutDir,
		});
		writeOutput(out, outFile, {
			inline,
			synthesize: true,
			query,
		});
		return;
	}

	if (engine === "all") {
		await cdp(["list"]); // refresh pages cache

		// Create fresh tabs for each engine in parallel, seeded directly to the
		// engine homepage so extractors can skip the initial navigation.
		const ENGINE_START_URLS = {
			perplexity: "https://www.perplexity.ai/",
			google: "https://www.google.com/",
		};
		const engineTabs = await Promise.all(
			ALL_ENGINES.map((e) => openNewTab(ENGINE_START_URLS[e])),
		);
		// Refresh cache so the new tabs are discoverable by cdp.mjs
		await cdp(["list"]);

		// Time-bounded per-engine extraction so slow engines don't stall the batch.
		const engineTimeoutFor = (engineName) => {
			if (depth !== "fast") return 70000;
			// ChatGPT needs ~25-30s solo; under CDP contention needs more headroom
			return engineName === "chatgpt" ? 60000 : 35000;
		};

		try {
			const results = await Promise.allSettled(
				ALL_ENGINES.map((e, i) =>
					runExtractor(
						ENGINES[e],
						normalizeQuery(query),
						engineTabs[i],
						short,
						engineTimeoutFor(e),
						locale,
					)
						.then((r) => {
							process.stderr.write(`PROGRESS:${e}:done\n`);
							return { engine: e, ...r };
						})
						.catch((err) => {
							// Do not emit PROGRESS:error yet: Bing/Perplexity may recover in
							// visible mode. Emit the final status after recovery has run.
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

			// Cloudflare/verification recovery: if Perplexity or Bing were blocked
			// in headless mode, retry in visible Chrome to establish cookies,
			// then continue headless with the profile now carrying valid session state.
			// Recovery is allowed even in fast mode because verification failure would
			// otherwise produce no usable result.
			const recoveryCandidates = findHeadlessBlockedEngines(out);

			if (
				recoveryCandidates.length > 0 &&
				process.env.GREEDY_SEARCH_VISIBLE !== "1"
			) {
				process.stderr.write(
					`[greedysearch] 🔓 Headless ${recoveryCandidates.join(", ")} search hit timeout/verification/antibot signals — retrying visible to establish cookies...\n`,
				);
				for (const blockedEngine of recoveryCandidates) {
					process.stderr.write(
						`[greedysearch] ${blockedEngine} recovery starting in visible mode...\n`,
					);
				}
				// Close headless tabs, kill headless Chrome
				await closeTabs(engineTabs);
				await killHeadlessChrome();
				process.env.GREEDY_SEARCH_VISIBLE = "1";
				delete process.env.GREEDY_SEARCH_HEADLESS;
				await ensureChrome();
				await cdp(["list"]);

				// Retry blocked engines in visible Chrome
				const retryTabs = [];
				let keepVisibleForHuman = false;
				let recovered = 0;
				for (let i = 0; i < recoveryCandidates.length; i++) {
					const tab = await openNewTab();
					retryTabs.push(tab);
				}
				try {
					// First visible retry: navigate to the engine page.
					// Cloudflare/Turnstile may resolve and redirect, disrupting the CDP session
					// ("Inspected target navigated or closed"). If so, the cookies are now cached
					// and a second retry on the same tab should succeed.
					const retries = await Promise.allSettled(
						recoveryCandidates.map((e, i) =>
							runExtractor(ENGINES[e], query, retryTabs[i], short, null, locale)
								.then((r) => ({ engine: e, ...r }))
								.catch((err) => ({ engine: e, error: err.message })),
						),
					);
					const stillBlocked = [];
					const manualVerification = [];
					for (const r of retries) {
						if (r.status === "fulfilled" && !r.value.error) {
							out[r.value.engine] = r.value;
							recovered++;
							process.stderr.write(`PROGRESS:${r.value.engine}:done\n`);
						} else if (r.status === "fulfilled") {
							out[r.value.engine] = r.value;
							stillBlocked.push(r.value.engine);
							if (isManualVerificationError(r.value.error)) {
								manualVerification.push(r.value.engine);
							}
						}
					}
					if (recovered > 0) {
						process.stderr.write(
							`[greedysearch] ✅ ${recovered}/${recoveryCandidates.length} engine(s) recovered — cookies cached for future headless runs.\n`,
						);
					} else {
						process.stderr.write(
							`[greedysearch] ⚠️ Recovery attempt did not extract an answer — ${recoveryCandidates.join(", ")} may still need manual verification or a DOM fallback.\n`,
						);
					}

					// Second retry for still-blocked engines: the first retry may have resolved
					// Cloudflare/Turnstile (navigating through the challenge), so cookies are now
					// cached and the page should load without the blocking challenge.
					if (stillBlocked.length > 0) {
						process.stderr.write(
							`[greedysearch] Second visible retry for ${stillBlocked.join(", ")} — Turnstile may have resolved on first attempt...\n`,
						);
						const secondRetries = await Promise.allSettled(
							stillBlocked.map((e) => {
								const idx = recoveryCandidates.indexOf(e);
								return runExtractor(
									ENGINES[e],
									query,
									retryTabs[idx],
									short,
									null,
									locale,
								)
									.then((r) => ({ engine: e, ...r }))
									.catch((err) => ({ engine: e, error: err.message }));
							}),
						);
						const secondStillBlocked = [];
						for (const r of secondRetries) {
							if (r.status === "fulfilled" && !r.value.error) {
								out[r.value.engine] = r.value;
								recovered++;
								process.stderr.write(`PROGRESS:${r.value.engine}:done\n`);
								process.stderr.write(
									`[greedysearch] ✅ ${r.value.engine} recovered on second visible retry.\n`,
								);
							} else {
								secondStillBlocked.push(r.value?.engine || "unknown");
							}
						}
						stillBlocked.length = 0;
						stillBlocked.push(...secondStillBlocked);
					}

					if (stillBlocked.length > 0) {
						for (const blockedEngine of stillBlocked) {
							process.stderr.write(`PROGRESS:${blockedEngine}:needs-human\n`);
						}
						keepVisibleForHuman = true;
						out._needsHumanVerification = {
							engines: stillBlocked,
							message:
								"Visible Chrome is open with the engine page loaded. Solve the Turnstile checkbox or other challenge in the visible window to store cookies. Cookies persist for future runs.",
						};
						process.stderr.write(
							`[greedysearch] 🔓 ${stillBlocked.join(", ")} still blocked — keeping visible Chrome open. Solve the challenge in the window to store cookies, then rerun.\n`,
						);
						// Visible Chrome stays open so the user can interact with any
						// Turnstile/Cloudflare challenge. Once solved, cookies are stored
						// in the shared profile and future headless runs will reuse them.
					}
				} finally {
					if (keepVisibleForHuman) {
						// User must interact — keep visible Chrome open but out of the way
						minimizeChrome().catch(() => {});
					} else {
						// Switch back to headless for synthesis + source fetch.
						// killHeadlessChrome() sends Browser.close first so Chrome flushes
						// its cookie database before the force-kill — cookies are preserved.
						await closeTabs(retryTabs);
						process.stderr.write(
							"[greedysearch] Switching back to headless Chrome...\n",
						);
						await killHeadlessChrome();
						delete process.env.GREEDY_SEARCH_VISIBLE;
						process.env.GREEDY_SEARCH_HEADLESS = "1";
						await ensureChrome();
						await cdp(["list"]);
					}
				}

				// Clear engineTabs — finally{} closeTabs handles empty arrays gracefully
				engineTabs.length = 0;
			}

			for (const engineName of ALL_ENGINES) {
				if (!out[engineName]?.error) continue;
				if (recoveryCandidates.includes(engineName)) {
					if (process.env.GREEDY_SEARCH_VISIBLE === "1") {
						process.stderr.write(
							`PROGRESS:${engineName}:${isManualVerificationError(out[engineName].error) ? "needs-human" : "error"}\n`,
						);
					}
					continue;
				}
				process.stderr.write(`PROGRESS:${engineName}:error\n`);
			}

			// Build a canonical source registry across all engines
			out._sources = buildSourceRegistry(out, query);

			// Source fetching: default for all "all" searches
			// Fetch all sources in a single batch (concurrency = source count).
			if (depth !== "fast" && out._sources.length > 0) {
				process.stderr.write("PROGRESS:source-fetch:start\n");
				const fetchedSources = await fetchMultipleSources(
					out._sources,
					5,
					8000,
				);

				out._sources = mergeFetchDataIntoSources(out._sources, fetchedSources);
				out._fetchedSources = writeSourcesToFiles(fetchedSources);
				process.stderr.write("PROGRESS:source-fetch:done\n");
			}

			// Synthesize with Gemini for all non-fast modes.
			// Open the Gemini tab HERE (after source fetch) instead of pre-opening
			// before source fetch. Pre-opening was fragile: Chrome could be killed
			// during visible recovery or idle-timeout between source fetch and
			// synthesis, leaving a stale tab ID that causes "No target matching prefix".
			if (depth !== "fast") {
				process.stderr.write("PROGRESS:synthesis:start\n");
				process.stderr.write(
					"[greedysearch] Synthesizing results with Gemini...\n",
				);
				try {
					const geminiTab = await openNewTab("https://gemini.google.com/app");
					const synthesis = await synthesizeWithGemini(query, out, {
						grounded: depth === "deep",
						tabPrefix: geminiTab,
						visible: process.env.GREEDY_SEARCH_VISIBLE === "1",
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
		const result = await runExtractor(
			script,
			normalizeQuery(query),
			null,
			short,
			null,
			locale,
		);
		if (fetchSource && result.sources?.length > 0) {
			result.topSource = await fetchTopSource(result.sources[0].url);
		}
		writeOutput(result, outFile, { inline, synthesize: false, query });
	} catch (e) {
		const recoveryEngine = script.includes("bing")
			? "bing"
			: script.includes("perplexity")
				? "perplexity"
				: null;
		const canRetryVisible =
			recoveryEngine &&
			process.env.GREEDY_SEARCH_VISIBLE !== "1" &&
			isHeadlessBlockedResult(e);

		if (canRetryVisible) {
			process.stderr.write(
				`[greedysearch] 🔓 ${recoveryEngine} blocked in headless — retrying visible to establish cookies...\n`,
			);
			await killHeadlessChrome();
			process.env.GREEDY_SEARCH_VISIBLE = "1";
			delete process.env.GREEDY_SEARCH_HEADLESS;
			await ensureChrome();
			await cdp(["list"]);

			const retryTab = await openNewTab();
			let keepVisibleForHuman = false;
			try {
				const result = await runExtractor(
					script,
					query,
					retryTab,
					short,
					null,
					locale,
				);
				if (fetchSource && result.sources?.length > 0) {
					result.topSource = await fetchTopSource(result.sources[0].url);
				}
				writeOutput(result, outFile, { inline, synthesize: false, query });
				return;
			} catch (retryErr) {
				// Any visible retry failure: keep Chrome open so user can solve Turnstile.
				// Once solved, cookies are stored in the shared profile for future headless runs.
				keepVisibleForHuman = true;
				writeOutput(
					{
						query,
						error: retryErr.message,
						_needsHumanVerification: {
							engines: [recoveryEngine],
							message:
								"Visible Chrome is open with the engine page loaded. Solve the Turnstile checkbox or other challenge to store cookies. Cookies persist for future runs.",
						},
					},
					outFile,
					{ inline, synthesize: false, query },
				);
				return;
			} finally {
				if (!keepVisibleForHuman) {
					await closeTab(retryTab);
					await killHeadlessChrome();
					delete process.env.GREEDY_SEARCH_VISIBLE;
					process.env.GREEDY_SEARCH_HEADLESS = "1";
				} else {
					// Minimize the visible window so it's out of the way
					minimizeChrome().catch(() => {});
				}
			}
		}

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
 * Skipped in headless mode (no window to minimize).
 */
async function minimizeChrome() {
	// In headless mode (default), there's no window to minimize
	if (process.env.GREEDY_SEARCH_HEADLESS === "1") return;

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
	// Touch activity timestamp for headless idle timeout
	touchActivity();
	// Ensure window is minimized after search completes (best-effort, non-blocking)
	minimizeChrome().catch(() => {});
});

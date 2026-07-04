#!/usr/bin/env node
// scripts/stealth-check.mjs — informational fingerprint smoke check for GreedySearch Chrome.
//
// This is intentionally non-gating in v1: it prints observations from direct
// fingerprint probes plus public test pages (Sannysoft, Intoli, CreepJS) and
// exits 0 unless the browser/check infrastructure itself fails.
//
// Usage:
//   npm run stealth-check
//   npm run stealth-check -- --visible
//   node scripts/stealth-check.mjs --json

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PROFILE_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const args = new Set(process.argv.slice(2));
const visible = args.has("--visible");
const jsonOutput = args.has("--json");
const strictMode = args.has("--strict");
const diffMode = args.has("--diff") || args.has("--baseline-compare");

process.env.CDP_PROFILE_DIR = PROFILE_DIR;
if (visible) process.env.GREEDY_SEARCH_VISIBLE = "1";

const TESTS = [
	{
		id: "sannysoft",
		name: "Sannysoft Bot Detection",
		url: "https://bot.sannysoft.com/",
		settleMs: 8000,
	},
	{
		id: "intoli",
		name: "Intoli Headless Detection",
		url: "https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html",
		settleMs: 4000,
	},
	{
		id: "creepjs",
		name: "CreepJS Fingerprint",
		url: "https://abrahamjuliot.github.io/creepjs/",
		settleMs: 9000,
	},
];

const BASELINE_DIR = join(
	process.env.HOME || process.env.USERPROFILE || process.cwd(),
	".greedysearch",
);
const BASELINE_FILE = join(BASELINE_DIR, "stealth-baseline.json");
const BASELINE_VERSION = 1;

function runNode(script, scriptArgs = [], options = {}) {
	const result = spawnSync(process.execPath, [script, ...scriptArgs], {
		cwd: ROOT,
		encoding: "utf8",
		env: process.env,
		...options,
	});
	if (result.status !== 0) {
		const detail = [result.stdout, result.stderr]
			.filter((value) => typeof value === "string" && value)
			.join("\n")
			.trim();
		throw new Error(
			`${script} ${scriptArgs.join(" ")} failed${detail ? `:\n${detail}` : ""}`,
		);
	}
	return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function ensureChrome() {
	const launch = join(ROOT, "bin", "launch.mjs");
	const launchArgs = visible ? [] : ["--headless"];
	runNode(launch, launchArgs, { stdio: jsonOutput ? "pipe" : "inherit" });
	const activePort = join(PROFILE_DIR, "DevToolsActivePort");
	if (!existsSync(activePort)) {
		throw new Error(
			`Chrome launched but DevToolsActivePort is missing at ${activePort}`,
		);
	}
}

function tryJson(value) {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}

function summarizeSannysoft(text) {
	const scannerText = text.includes("Fingerprint Scanner tests")
		? text.slice(text.indexOf("Fingerprint Scanner tests"))
		: text;
	const scannerMatches = [
		...scannerText.matchAll(
			/\b([A-Z][A-Z0-9_]{2,})\s+(ok|failed|warning)\b/gim,
		),
	];
	const scannerTests = scannerMatches.map((m) => ({
		name: m[1],
		status: m[2].toLowerCase(),
	}));

	const tableFind = (label) => {
		const lines = text.split(/\r?\n/).map((line) => line.trim());
		const target = label.toLowerCase();
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			const lower = line.toLowerCase();
			if (lower.startsWith(`${target}\t`) || lower.startsWith(`${target} `)) {
				return line.slice(label.length).trim();
			}
			if (lower !== target) continue;
			for (let offset = 1; offset <= 3; offset += 1) {
				const candidate = lines[index + offset];
				if (!candidate || /^\([^)]*\)$/.test(candidate)) continue;
				return candidate;
			}
		}
		return null;
	};

	return {
		textLength: text.length,
		sample: text.slice(0, 500),
		total: scannerTests.length,
		ok: scannerTests.filter((t) => t.status === "ok").length,
		failed: scannerTests.filter((t) => t.status === "failed").length,
		warning: scannerTests.filter((t) => t.status === "warning").length,
		tests: scannerTests,
		intoliAdditions: {
			webdriver: tableFind("WebDriver"),
			webdriverAdvanced: tableFind("WebDriver Advanced"),
			chrome: tableFind("Chrome"),
			pluginsType: tableFind("Plugins is of type PluginArray"),
		},
	};
}

function summarizeIntoli(text) {
	const lowered = text.toLowerCase();
	const rows = [];
	for (const line of text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean)) {
		if (
			/\b(pass|failed?|present|missing|yes|no)\b/i.test(line) &&
			line.length < 180
		) {
			rows.push(line);
		}
	}
	return {
		mentionsHeadless: lowered.includes("headless"),
		mentionsWebdriver: lowered.includes("webdriver"),
		passCount: (text.match(/\bpass(?:ed)?\b/gi) || []).length,
		failCount: (text.match(/\bfail(?:ed)?\b/gi) || []).length,
		rows: rows.slice(0, 20),
	};
}

function summarizeCreepjs(text) {
	const lines = text
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	const interesting = lines.filter((line) =>
		/headless|stealth|webdriver|trust|bot|lie|lied|score|rating/i.test(line),
	);
	// Structured score extraction
	const likeHeadlessMatch = text.match(/(\d+)%\s*like headless\s*:\s*(\w+)/i);
	const headlessMatch = text.match(/(\d+)%\s*headless\s*:\s*(\w+)/i);
	const stealthMatch = text.match(/(\d+)%\s*stealth\s*:\s*(\w+)/i);
	const trustMatch = text.match(/trust[:\s]*(\d+)%/i);
	const botMatch = text.match(/bot[:\s]*(\d+)%/i);
	return {
		textLength: text.length,
		interesting: interesting.slice(0, 30),
		scores: {
			likeHeadless: likeHeadlessMatch
				? {
						percent: parseInt(likeHeadlessMatch[1], 10),
						fingerprint: likeHeadlessMatch[2],
					}
				: null,
			headless: headlessMatch
				? {
						percent: parseInt(headlessMatch[1], 10),
						fingerprint: headlessMatch[2],
					}
				: null,
			stealth: stealthMatch
				? {
						percent: parseInt(stealthMatch[1], 10),
						fingerprint: stealthMatch[2],
					}
				: null,
			trust: trustMatch ? parseInt(trustMatch[1], 10) : null,
			bot: botMatch ? parseInt(botMatch[1], 10) : null,
		},
	};
}

function summarizeGeneric(testId, text) {
	if (testId === "sannysoft") return summarizeSannysoft(text);
	if (testId === "intoli") return summarizeIntoli(text);
	if (testId === "creepjs") return summarizeCreepjs(text);
	return { textLength: text.length, sample: text.slice(0, 1000) };
}

function loadBaseline() {
	try {
		const data = JSON.parse(readFileSync(BASELINE_FILE, "utf8"));
		if (data && data.version === BASELINE_VERSION) return data;
	} catch {}
	return null;
}

function createBaseline(results) {
	const creepjs = results.pages.find((p) => p.id === "creepjs");
	const sannysoft = results.pages.find((p) => p.id === "sannysoft");
	return {
		version: BASELINE_VERSION,
		createdAt: new Date().toISOString(),
		sannysoft: sannysoft?.summary
			? {
					ok: sannysoft.summary.ok,
					total: sannysoft.summary.total,
					failed: sannysoft.summary.failed,
					warning: sannysoft.summary.warning,
					intoliAdditions: sannysoft.summary.intoliAdditions,
				}
			: null,
		creepjs: creepjs?.summary?.scores ? { ...creepjs.summary.scores } : null,
	};
}

function saveBaseline(results) {
	try {
		if (!existsSync(BASELINE_DIR)) mkdirSync(BASELINE_DIR, { recursive: true });
		const baseline = createBaseline(results);
		writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2), "utf8");
		return baseline;
	} catch (error) {
		console.error("Warning: could not save baseline:", error.message);
		return null;
	}
}

function diffBaseline(baseline, results) {
	const changes = [];
	const creepjs = results.pages.find((p) => p.id === "creepjs");
	const sannysoft = results.pages.find((p) => p.id === "sannysoft");
	if (baseline.creepjs && creepjs?.summary?.scores) {
		for (const key of ["likeHeadless", "headless", "stealth"]) {
			const before = baseline.creepjs[key];
			const after = creepjs.summary.scores[key];
			if (before && after && before.percent !== after.percent) {
				changes.push({
					metric: `creepjs.${key}`,
					before: before.percent,
					after: after.percent,
					improved: after.percent < before.percent,
				});
			}
		}
	}
	if (baseline.sannysoft && sannysoft?.summary) {
		for (const key of ["ok", "failed", "warning"]) {
			const before = baseline.sannysoft[key];
			const after = sannysoft.summary[key];
			if (before !== after) {
				changes.push({
					metric: `sannysoft.${key}`,
					before,
					after,
					improved: key === "ok" ? after > before : after < before,
				});
			}
		}
	}
	return changes;
}

function checkStrict(results) {
	const failures = [];
	for (const page of results.pages) {
		if (!page.ok) {
			failures.push(`${page.name}: page load failed — ${page.error}`);
			continue;
		}
		if (page.id === "sannysoft") {
			const s = page.summary;
			if (s.failed > 0 || s.warning > 0) {
				failures.push(
					`Sannysoft: ${s.failed} failed, ${s.warning} warning scanner tests`,
				);
			}
			for (const [key, value] of Object.entries(s.intoliAdditions || {})) {
				if (value && !/\bpassed\b/i.test(value)) {
					failures.push(
						`Sannysoft Intoli: ${key}=${value} (expected "passed")`,
					);
				}
			}
		}
		if (page.id === "creepjs") {
			const scores = page.summary?.scores;
			if (!scores) {
				failures.push("CreepJS: no scores extracted");
				continue;
			}
			if (scores.likeHeadless && scores.likeHeadless.percent > 0) {
				failures.push(
					`CreepJS: likeHeadless=${scores.likeHeadless.percent}% (expected 0%)`,
				);
			}
			if (scores.headless && scores.headless.percent > 0) {
				failures.push(
					`CreepJS: headless=${scores.headless.percent}% (expected 0%)`,
				);
			}
			if (scores.stealth && scores.stealth.percent > 0) {
				failures.push(
					`CreepJS: stealth=${scores.stealth.percent}% (expected 0%)`,
				);
			}
		}
	}
	return failures;
}

async function evalNoContext(cdp, tab, expression, timeoutMs = 20000) {
	const raw = await cdp(
		[
			"evalraw",
			tab,
			"Runtime.evaluate",
			JSON.stringify({ expression, returnByValue: true, awaitPromise: true }),
		],
		timeoutMs,
	);
	let result;
	try {
		result = JSON.parse(raw);
	} catch (error) {
		throw new Error(`Runtime.evaluate returned invalid JSON: ${error.message}`);
	}
	if (result.exceptionDetails) {
		throw new Error(
			result.exceptionDetails.text ||
				result.exceptionDetails.exception?.description ||
				"Runtime.evaluate failed",
		);
	}
	return String(result.result?.value ?? "");
}

async function waitForPageText(cdp, tab, predicate, timeoutMs = 12000) {
	const deadline = Date.now() + timeoutMs;
	let lastText = "";
	while (Date.now() < deadline) {
		lastText = await evalNoContext(
			cdp,
			tab,
			"document.body ? document.body.innerText : ''",
			20000,
		);
		if (predicate(lastText)) return lastText;
		await new Promise((resolve) => setTimeout(resolve, 750));
	}
	return lastText;
}

const DIRECT_PROBE = String.raw`
(async () => {
  const webdriverProtoDesc = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver');
  const nativeString = webdriverProtoDesc?.get ? Function.prototype.toString.call(webdriverProtoDesc.get) : null;
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 16;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textBaseline = 'top';
    ctx.font = '14px Arial';
    ctx.fillText('greedy-stealth-check', 1, 1);
  }
  let webglVendor = null;
  let webglRenderer = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        webglVendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        webglRenderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      }
    }
  } catch (_) {}
  let uaData = null;
  try {
    uaData = navigator.userAgentData ? {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
      highEntropy: await navigator.userAgentData.getHighEntropyValues(['architecture','bitness','fullVersionList','platformVersion','uaFullVersion','wow64'])
    } : null;
  } catch (error) {
    uaData = { error: String(error && error.message || error) };
  }
  return {
    url: location.href,
    userAgent: navigator.userAgent,
    webdriverPresent: 'webdriver' in navigator,
    webdriverOwnProperty: Object.prototype.hasOwnProperty.call(navigator, 'webdriver'),
    webdriverPrototypeProperty: !!webdriverProtoDesc,
    webdriverType: typeof navigator.webdriver,
    webdriverValue: navigator.webdriver,
    webdriverGetterNative: nativeString == null ? null : nativeString.includes('[native code]'),
    platform: navigator.platform,
    vendor: navigator.vendor,
    languages: navigator.languages,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    pluginsLength: navigator.plugins ? navigator.plugins.length : null,
    mimeTypesLength: navigator.mimeTypes ? navigator.mimeTypes.length : null,
    pdfViewerEnabled: navigator.pdfViewerEnabled,
    hasChrome: !!window.chrome,
    chromeKeys: window.chrome ? Object.keys(window.chrome).sort() : [],
    outer: { width: window.outerWidth, height: window.outerHeight, innerWidth, innerHeight },
    screen: { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, pixelDepth: screen.pixelDepth },
    webglVendor,
    webglRenderer,
    canvasHashSample: canvas.toDataURL().slice(0, 80),
    uaData,
  };
})()
`;

async function main() {
	ensureChrome();

	const { cdp, getOrOpenTab } = await import("../extractors/common.mjs");
	const tab = await getOrOpenTab(null);
	const results = {
		mode: visible ? "visible" : "headless",
		tab,
		directProbe: null,
		pages: [],
	};

	// New document navigation ensures Page.addScriptToEvaluateOnNewDocument stealth
	// patches installed by getOrOpenTab() run before the probe executes.
	await cdp(
		[
			"nav",
			tab,
			"data:text/html,<title>GreedySearch stealth check</title><body>probe</body>",
		],
		15000,
	);
	results.directProbe = tryJson(await cdp(["eval", tab, DIRECT_PROBE], 15000));

	for (const test of TESTS) {
		const page = {
			id: test.id,
			name: test.name,
			url: test.url,
			ok: false,
			error: null,
			summary: null,
		};
		try {
			await cdp(["nav", tab, test.url], 45000);
			await new Promise((resolve) => setTimeout(resolve, test.settleMs));
			const text = await waitForPageText(
				cdp,
				tab,
				(bodyText) => {
					if (test.id === "sannysoft") return /\bPHANTOM_UA\b/i.test(bodyText);
					if (test.id === "intoli") return /\bwebdriver\b/i.test(bodyText);
					if (test.id === "creepjs")
						return /headless|stealth|trust|fingerprint/i.test(bodyText);
					return bodyText.length > 200;
				},
				test.id === "sannysoft" ? 30000 : 15000,
			);
			page.ok = true;
			page.summary = summarizeGeneric(test.id, text);
		} catch (error) {
			page.error = error.message;
		}
		results.pages.push(page);
	}

	if (jsonOutput) {
		console.log(JSON.stringify(results, null, 2));
		if (strictMode) {
			const sf = checkStrict(results);
			if (sf.length) process.exit(1);
		}
		return;
	}

	printHuman(results);

	// Baseline management
	if (diffMode) {
		const baseline = loadBaseline();
		if (baseline) {
			const changes = diffBaseline(baseline, results);
			if (changes.length) {
				console.log("\nBaseline comparison:");
				for (const c of changes) {
					const arrow = c.improved ? "\u2713" : "\u2717";
					console.log(`  ${arrow} ${c.metric}: ${c.before} \u2192 ${c.after}`);
				}
			} else {
				console.log("\nNo baseline changes detected.");
			}
		} else {
			console.log("\nNo baseline found. Run without --diff to create one.");
		}
	} else if (!strictMode) {
		// Auto-save baseline on normal runs when none exists yet
		const baseline = loadBaseline();
		if (!baseline) {
			const saved = saveBaseline(results);
			if (saved) console.log(`\nBaseline saved to ${BASELINE_FILE}`);
		}
	}

	// Strict gating (after baseline so record is written on failures too)
	if (strictMode) {
		const sf = checkStrict(results);
		if (sf.length) {
			console.log("\n❌ Strict mode failures:");
			for (const f of sf) console.log(`  - ${f}`);
			process.exit(1);
		}
		console.log("\n✅ Strict mode: all checks passed");
	}
}

function printHuman(results) {
	console.log("\nGreedySearch stealth check (informational v1)");
	console.log(`Mode: ${results.mode}`);
	console.log(`Tab:  ${results.tab}`);

	console.log("\nDirect fingerprint probe");
	const p = results.directProbe || {};
	const rows = [
		["navigator.webdriver", `${p.webdriverType} / ${String(p.webdriverValue)}`],
		[
			"webdriver present",
			`${String(p.webdriverPresent)} (own=${String(p.webdriverOwnProperty)}, proto=${String(p.webdriverPrototypeProperty)})`,
		],
		[
			"webdriver getter native",
			p.webdriverGetterNative === null || p.webdriverGetterNative === undefined
				? "n/a"
				: String(p.webdriverGetterNative),
		],
		["platform", p.platform],
		["vendor", p.vendor],
		[
			"languages",
			Array.isArray(p.languages) ? p.languages.join(", ") : String(p.languages),
		],
		["plugins / mimeTypes", `${p.pluginsLength} / ${p.mimeTypesLength}`],
		[
			"hardware / memory",
			`${p.hardwareConcurrency} cores / ${p.deviceMemory} GB`,
		],
		[
			"window outer",
			`${p.outer?.width}x${p.outer?.height} (inner ${p.outer?.innerWidth}x${p.outer?.innerHeight})`,
		],
		["webgl", `${p.webglVendor || "?"} / ${p.webglRenderer || "?"}`],
		["UA-CH platform", p.uaData?.platform || p.uaData?.error || "n/a"],
	];
	for (const [label, value] of rows) {
		console.log(`  ${label.padEnd(24)} ${value ?? "n/a"}`);
	}

	console.log("\nPublic test pages");
	for (const page of results.pages) {
		console.log(`\n- ${page.name}`);
		console.log(`  ${page.url}`);
		if (!page.ok) {
			console.log(`  ERROR: ${page.error}`);
			continue;
		}
		if (page.id === "sannysoft") {
			const s = page.summary;
			console.log(`  Text length: ${s.textLength}`);
			console.log(
				`  Fingerprint scanner: ${s.ok}/${s.total} ok, ${s.failed} failed, ${s.warning} warning`,
			);
			if (!s.total && s.sample)
				console.log(`  Sample: ${s.sample.replace(/\s+/g, " ").slice(0, 180)}`);
			if (s.intoliAdditions) {
				console.log(
					`  Intoli additions: webdriver=${s.intoliAdditions.webdriver || "n/a"}, ` +
						`advanced=${s.intoliAdditions.webdriverAdvanced || "n/a"}, ` +
						`chrome=${s.intoliAdditions.chrome || "n/a"}, ` +
						`pluginsType=${s.intoliAdditions.pluginsType || "n/a"}`,
				);
			}
			const failed = s.tests.filter((t) => t.status !== "ok");
			if (failed.length)
				console.log(
					`  Non-ok scanner rows: ${failed.map((t) => `${t.name}:${t.status}`).join(", ")}`,
				);
		} else if (page.id === "intoli") {
			const s = page.summary;
			console.log(
				`  Text signals: pass=${s.passCount}, fail=${s.failCount}, mentions webdriver=${s.mentionsWebdriver}`,
			);
			if (s.rows.length)
				console.log(`  Sample rows: ${s.rows.slice(0, 5).join(" | ")}`);
		} else if (page.id === "creepjs") {
			const s = page.summary;
			console.log(`  Text length: ${s.textLength}`);
			if (s.scores) {
				const parts = [];
				if (s.scores.likeHeadless)
					parts.push(`like headless: ${s.scores.likeHeadless.percent}%`);
				if (s.scores.headless)
					parts.push(`headless: ${s.scores.headless.percent}%`);
				if (s.scores.stealth)
					parts.push(`stealth: ${s.scores.stealth.percent}%`);
				if (s.scores.trust !== null && s.scores.trust !== undefined)
					parts.push(`trust: ${s.scores.trust}%`);
				if (s.scores.bot !== null && s.scores.bot !== undefined)
					parts.push(`bot: ${s.scores.bot}%`);
				console.log(`  Scores: ${parts.join(" | ")}`);
			}
			if (s.interesting.length)
				console.log(`  Raw lines: ${s.interesting.slice(0, 5).join(" | ")}`);
		}
	}

	const notes = [];
	if (strictMode)
		notes.push("Strict mode enabled — exit code reflects pass/fail.");
	if (diffMode) notes.push("Baseline comparison mode enabled.");
	notes.push("Use --json for machine-readable output.");
	console.log(`\nNote: ${notes.join(" ")}`);
}

main().catch((error) => {
	console.error(`stealth-check failed: ${error.stack || error.message}`);
	process.exit(1);
});

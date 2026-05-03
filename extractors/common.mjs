// extractors/common.mjs — shared utilities for CDP-based extractors
// Extracts common patterns: cdp wrapper, tab management, clipboard interception, source parsing

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, "..", "bin", "cdp.mjs");

// ============================================================================
// CDP wrapper
// ============================================================================

/**
 * Execute a CDP command through the cdp.mjs CLI
 * @param {string[]} args - Command arguments
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
export function cdp(args, timeoutMs = 30000) {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [CDP, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		proc.stdout.on("data", (d) => (out += d));
		proc.stderr.on("data", (d) => (err += d));
		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`cdp timeout: ${args[0]}`));
		}, timeoutMs);
		proc.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve(out.trim());
			else reject(new Error(err.trim() || `cdp exit ${code}`));
		});
	});
}

// ============================================================================
// Tab management
// ============================================================================

/**
 * Get an existing tab by prefix or open a new one
 * @param {string|null} tabPrefix - Existing tab prefix, or null to create new
 * @returns {Promise<string>} Tab identifier
 */
export async function getOrOpenTab(tabPrefix) {
	if (tabPrefix) return tabPrefix;
	// Always open a fresh tab to avoid SPA navigation issues
	const list = await cdp(["list"]);
	const anchor = list.split("\n")[0]?.slice(0, 8);
	if (!anchor)
		throw new Error(
			"No Chrome tabs found. Is Chrome running with --remote-debugging-port=9222?",
		);
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		'{"url":"about:blank"}',
	]);
	const { targetId } = JSON.parse(raw);
	await cdp(["list"]); // refresh cache
	const tid = targetId.slice(0, 8);
	// Inject stealth patches (headless is default; skip if GREEDY_SEARCH_VISIBLE=1)
	if (process.env.GREEDY_SEARCH_VISIBLE !== "1") {
		injectHeadlessStealth(tid).catch(() => {});
	}
	return tid;
}

// ============================================================================
// Clipboard interception (for extractors that use copy-to-clipboard)
// ============================================================================

/**
 * Inject clipboard interceptor to capture text when copy buttons are clicked.
 * Each engine uses a unique global variable to avoid conflicts.
 * @param {string} tab - Tab identifier
 * @param {string} globalVar - Global variable name (e.g., '__pplxClipboard', '__geminiClipboard')
 */
export async function injectClipboardInterceptor(tab, globalVar) {
	const code = `
    window.${globalVar} = null;
    const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      window.${globalVar} = text;
      return _origWriteText(text);
    };
    const _origWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async function(items) {
      try {
        for (const item of items) {
          if (item.types && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            window.${globalVar} = await blob.text();
            break;
          }
        }
      } catch(e) {}
      return _origWrite(items);
    };
  `;
	await cdp(["eval", tab, code]);
}

// ============================================================================
// Headless stealth injection
// ============================================================================

/**
 * Inject anti-detection patches into a page in headless mode.
 * Based on production patterns from screenshotrun.com.
 */
export async function injectHeadlessStealth(tab) {
	const code = `
(function() {
  // ── Runtime.enable / CDP detection masking ──────────────
  try { delete window.__REBROWSER_RUNTIME_ENABLE; } catch(_) {}
  try { delete window.__REBROWSER_DEVTOOLS; } catch(_) {}
  try { delete window.__nightmare; } catch(_) {}
  try { delete window.__phantom; } catch(_) {}
  try { delete window.callPhantom; } catch(_) {}
  try { delete window._phantom; } catch(_) {}
  try { delete window.Buffer; } catch(_) {}

  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      var p = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      p.length = 3;
      return p;
    },
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  if (!window.chrome) {
    window.chrome = {
      runtime: { connect: () => {}, sendMessage: () => {}, onMessage: { addListener: () => {} } },
      loadTimes: () => ({}),
      csi: () => ({}),
    };
  }
  var origQuery = navigator.permissions?.query;
  if (origQuery) {
    navigator.permissions.query = function(params) {
      if (params.name === 'notifications') return Promise.resolve({ state: Notification.permission });\n      return origQuery(params);
    };
  }
  try {
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    };
  } catch(_) {}
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
})();
`;
	await cdp([
		"evalraw",
		tab,
		"Page.addScriptToEvaluateOnNewDocument",
		JSON.stringify({ source: code }),
	]);
}

// ============================================================================
// Source extraction from markdown
// ============================================================================

/**
 * Parse Markdown links from text to extract sources
 * @param {string} text - Text containing Markdown links like [title](url)
 * @returns {Array<{title: string, url: string}>} Extracted sources
 */
export function parseSourcesFromMarkdown(text) {
	return Array.from(text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g))
		.map((m) => ({ title: m[1], url: m[2] }))
		.filter((v, i, arr) => arr.findIndex((x) => x.url === v.url) === i)
		.slice(0, 10);
}

// ============================================================================
// Timing constants
// ============================================================================

export const TIMING = {
	postNav: 1500, // settle after navigation
	postNavSlow: 2000, // settle after slower navigations (Bing, Gemini)
	postClick: 400, // settle after a UI click
	postType: 400, // settle after typing
	inputPoll: 400, // polling interval when waiting for input to appear
	copyPoll: 600, // polling interval when waiting for copy button
	afterVerify: 3000, // settle after a verification challenge completes
};

// ============================================================================
// Copy button polling
// ============================================================================

/**
 * Wait for a copy button to appear in the DOM.
 * @param {string} tab - Tab identifier
 * @param {string} selector - CSS selector for the copy button
 * @param {object} [options]
 * @param {number} [options.timeout=60000] - Max wait in ms
 * @param {Function} [options.onPoll] - Optional async callback on each poll tick (e.g. scroll)
 * @returns {Promise<void>}
 */
export async function waitForCopyButton(tab, selector, options = {}) {
	const { timeout = 60000, onPoll } = options;
	const deadline = Date.now() + timeout;
	let tick = 0;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, TIMING.copyPoll));
		if (onPoll) await onPoll(++tick).catch(() => null);
		const found = await cdp([
			"eval",
			tab,
			`!!document.querySelector('${selector}')`,
		]).catch(() => "false");
		if (found === "true") return;
	}
	throw new Error(
		`Copy button ('${selector}') did not appear within ${timeout}ms`,
	);
}

// ============================================================================
// Stream completion detection
// ============================================================================

/**
 * Wait for generation/streaming to complete by monitoring text length stability
 * @param {string} tab - Tab identifier
 * @param {object} options - Options
 * @param {number} [options.timeout=30000] - Maximum wait time in ms
 * @param {number} [options.interval=600] - Polling interval in ms
 * @param {number} [options.stableRounds=3] - Required stable rounds to consider complete
 * @param {string} [options.selector='document.body'] - Element to monitor (default: body)
 * @returns {Promise<number>} Final text length
 */
export async function waitForStreamComplete(tab, options = {}) {
	const {
		timeout = 20000,
		interval = 600,
		stableRounds = 3,
		selector = "document.body",
		minLength = 0,
	} = options;

	const deadline = Date.now() + timeout;
	let lastLen = -1;
	let stableCount = 0;

	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, interval));
		const lenStr = await cdp([
			"eval",
			tab,
			`${selector}?.innerText?.length ?? 0`,
		]).catch(() => "0");
		const currentLen = parseInt(lenStr, 10) || 0;

		if (currentLen >= minLength) {
			if (currentLen === lastLen) {
				stableCount++;
				if (stableCount >= stableRounds) return currentLen;
			} else {
				lastLen = currentLen;
				stableCount = 0;
			}
		}
	}

	if (lastLen >= minLength) return lastLen;
	throw new Error(`Generation did not stabilise within ${timeout}ms`);
}

// ============================================================================
// CLI argument parsing
// ============================================================================

/**
 * Parse standard extractor CLI arguments
 * @param {string[]} args - process.argv.slice(2)
 * @returns {{query: string, tabPrefix: string|null, short: boolean, locale: string|null}}
 */
export function parseArgs(args) {
	const short = args.includes("--short");
	let rest = args.filter((a) => a !== "--short");

	const tabFlagIdx = rest.indexOf("--tab");
	const tabPrefix = tabFlagIdx === -1 ? null : rest[tabFlagIdx + 1];
	if (tabFlagIdx !== -1) {
		rest = rest.filter((_, i) => i !== tabFlagIdx && i !== tabFlagIdx + 1);
	}

	const localeIdx = rest.indexOf("--locale");
	const locale = localeIdx === -1 ? null : rest[localeIdx + 1];
	if (localeIdx !== -1) {
		rest = rest.filter((_, i) => i !== localeIdx && i !== localeIdx + 1);
	}

	const query = rest.join(" ");
	return { query, tabPrefix, short, locale };
}

/**
 * Validate that a query was provided, show usage and exit if not
 * @param {string[]} args - process.argv.slice(2)
 * @param {string} usage - Usage string for error message
 */
export function validateQuery(args, usage) {
	if (!args.length || args[0] === "--help") {
		process.stderr.write(usage);
		process.exit(1);
	}
}

// ============================================================================
// Output formatting
// ============================================================================

/**
 * Truncate answer if short mode is enabled
 * @param {string} answer - Full answer text
 * @param {boolean} short - Whether to truncate
 * @param {number} [maxLen=300] - Maximum length in short mode
 * @returns {string} Formatted answer
 */
export function formatAnswer(answer, short, maxLen = 300) {
	if (!short || answer.length <= maxLen) return answer;
	return `${answer.slice(0, maxLen).replace(/\s+\S*$/, "")}…`;
}

/**
 * Output JSON result to stdout
 * @param {object} data - Data to output
 */
export function outputJson(data) {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Handle and output error, then exit
 * @param {Error} error - Error to handle
 */
export function handleError(error) {
	process.stderr.write(`Error: ${error.message}\n`);
	process.exit(1);
}

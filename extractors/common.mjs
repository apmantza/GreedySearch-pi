// extractors/common.mjs — shared utilities for CDP-based extractors
// Extracts common patterns: cdp wrapper, tab management, clipboard interception, source parsing

import { randomInt } from "node:crypto";
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
		const proc = spawn(process.execPath, [CDP, ...args], {
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
	// Inject stealth patches for anti-detection coverage (both headless + visible)
	injectHeadlessStealth(tid).catch(() => {});
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

  // Real Chrome without automation does not expose a useful webdriver value.
  // A literal false value is itself a common stealth tell; prefer undefined and
  // make the descriptor configurable like native browser properties.
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
  Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
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
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      var m = [
        { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null },
        { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null },
      ];
      m.item = function(i) { return m[i] || null; };
      m.namedItem = function(name) { return m.find(function(x) { return x.type === name; }) || null; };
      return m;
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  try {
    Object.defineProperty(navigator, 'connection', { get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, saveData: false }), configurable: true });
  } catch(_) {}
  if (!navigator.mediaDevices) {
    Object.defineProperty(navigator, 'mediaDevices', {
      get: () => ({
        enumerateDevices: () => Promise.resolve([
          { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'default' },
          { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'default' },
          { deviceId: '', kind: 'videoinput', label: '', groupId: '' },
        ]),
        getUserMedia: () => Promise.reject(new DOMException('NotAllowedError')),
        getDisplayMedia: () => Promise.reject(new DOMException('NotAllowedError')),
      }),
      configurable: true,
    });
  }
  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      runtime: {
        OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {},
        connect: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {} }
      },
      loadTimes: () => ({}),
      csi: () => ({}),
    };
  }
  var __greedyNativeFns = [];
  function __markNative(fn) { try { __greedyNativeFns.push(fn); } catch(_) {} return fn; }

  var origQuery = navigator.permissions?.query;
  if (origQuery) {
    navigator.permissions.query = __markNative(function query(params) {
      if (params && params.name === 'notifications') return Promise.resolve({ state: Notification.permission || 'default', onchange: null });
      return origQuery.apply(this, arguments);
    });
  }
  try {
    var getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = __markNative(function getParameter(p) {
      if (p === 37445) return 'Intel Inc.';
      if (p === 37446) return 'Intel Iris OpenGL Engine';
      return getParam.call(this, p);
    });
  } catch(_) {}
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

  // ── Canvas fingerprint noise ─────────────────────────
  // Headless rendering engines produce slightly different canvas output
  // than headed Chrome. Subtle noise breaks hash-based fingerprinting.
  try {
    var __canvasNoise = ((Date.now() % 997) + Math.floor(Math.random() * 997)) & 1;
    var origFill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = __markNative(function fillText() {
      this.globalAlpha = 0.9995;
      return origFill.apply(this, arguments);
    });
  } catch(_) {}
  try {
    var origStroke = CanvasRenderingContext2D.prototype.strokeText;
    CanvasRenderingContext2D.prototype.strokeText = __markNative(function strokeText() {
      this.globalAlpha = 0.9995;
      return origStroke.apply(this, arguments);
    });
  } catch(_) {}
  try {
    var origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = __markNative(function toDataURL() {
      var ctx = this.getContext('2d');
      if (ctx) {
        // Add 1px noise pixel in corner (invisible but changes hash)
        var imgData = ctx.getImageData(0, 0, 1, 1);
        if (imgData) imgData.data[0] ^= __canvasNoise;
        ctx.putImageData(imgData, 0, 0);
      }
      return origToDataURL.apply(this, arguments);
    });
  } catch(_) {}

  // ── window outer dimensions ──────────────────────────
  // outerWidth/Height = 0 in headless — a well-known bot signal.
  // Mirror innerWidth/Height (set by --window-size flag) so the ratio is sane.
  try {
    if (!window.outerWidth)  Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth  || 1920, configurable: true });
    if (!window.outerHeight) Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight || 1080, configurable: true });
  } catch(_) {}

  // ── screen properties ─────────────────────────────────
  try {
    if (!screen.colorDepth) Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
    if (!screen.pixelDepth) Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
  } catch(_) {}

  // ── navigator.userAgentData (UA Client Hints) ─────────
  // Derive version from the UA string already set by --user-agent flag so the
  // two APIs are always consistent. Removes any "HeadlessChrome" brand entry.
  try {
    var _uaMajor = (navigator.userAgent.match(new RegExp('Chrome/([0-9]+)')) || [])[1] || '136';
    var _uaFull  = (navigator.userAgent.match(new RegExp('Chrome/([0-9.]+)')) || [])[1] || (_uaMajor + '.0.0.0');
    var _brands  = [
      { brand: 'Not)A;Brand',  version: '99' },
      { brand: 'Google Chrome', version: _uaMajor },
      { brand: 'Chromium',      version: _uaMajor },
    ];
    Object.defineProperty(navigator, 'userAgentData', {
      get: function() {
        return {
          brands: _brands, mobile: false, platform: 'Windows',
          getHighEntropyValues: function() {
            return Promise.resolve({
              architecture: 'x86', bitness: '64',
              brands: _brands,
              fullVersionList: [
                { brand: 'Not)A;Brand',   version: '99.0.0.0' },
                { brand: 'Google Chrome', version: _uaFull },
                { brand: 'Chromium',      version: _uaFull },
              ],
              mobile: false, model: '', platform: 'Windows',
              platformVersion: '15.0.0', uaFullVersion: _uaFull, wow64: false,
            });
          },
          toJSON: function() { return { brands: _brands, mobile: false, platform: 'Windows' }; },
        };
      },
      configurable: true,
    });
  } catch(_) {}

  // ── CDP Runtime serialization guard ──────────────────
  // Sites detect CDP by putting a getter on Error.prototype.stack
  // and checking if console.log triggers it (only happens when
  // Runtime domain is enabled). We monkey-patch console methods to
  // strip custom getters from arguments before they reach CDP.
  try {
    var _origLog = console.log, _origError = console.error,
        _origWarn = console.warn, _origDebug = console.debug,
        _origInfo = console.info;
    var _safeArg = function(a) {
      if (a instanceof Error) {
        try { return new Error(a.message); } catch(_) { return a; }
      }
      return a;
    };
    console.log = __markNative(function log() { return _origLog.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.error = __markNative(function error() { return _origError.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.warn = __markNative(function warn() { return _origWarn.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.debug = __markNative(function debug() { return _origDebug.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
    console.info = __markNative(function info() { return _origInfo.apply(console, Array.prototype.map.call(arguments, _safeArg)); });
  } catch(_) {}

  // ── Native function masking ──────────────────────────
  // Patched APIs should not stringify as user-defined stealth code.
  try {
    var __nativeToString = Function.prototype.toString;
    Function.prototype.toString = function toString() {
      if (__greedyNativeFns.indexOf(this) !== -1) {
        var name = this.name || '';
        return 'function ' + name + '() { [native code] }';
      }
      return __nativeToString.call(this);
    };
  } catch(_) {}
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
	if (!text) return [];
	const results = [];
	let idx = 0;
	while (idx < text.length && results.length < 10) {
		const openBracket = text.indexOf("[", idx);
		if (openBracket === -1) break;
		const closeBracket = text.indexOf("](", openBracket);
		if (closeBracket === -1) break;
		const openParen = closeBracket + 2;
		// Validate URL prefix and find closing paren
		let closeParen = -1;
		for (let p = openParen; p < text.length; p++) {
			const ch = text[p];
			if (ch === ")") {
				closeParen = p;
				break;
			}
			if (/\s/.test(ch)) break; // whitespace in URL = invalid markdown link
		}
		if (closeParen !== -1) {
			const title = text.slice(openBracket + 1, closeBracket);
			const url = text.slice(openParen, closeParen);
			if (/^https?:\/\//i.test(url) && title) {
				// Deduplicate by URL
				if (!results.some((r) => r.url === url)) {
					results.push({ title, url });
				}
			}
			idx = closeParen + 1;
		} else {
			idx = openBracket + 1;
		}
	}
	return results;
}

// ============================================================================
// Timing constants
// ============================================================================

export const TIMING = {
	postNav: 800, // settle after navigation
	postNavSlow: 1200, // settle after slower navigations (Bing, Gemini)
	postClick: 300, // settle after a UI click
	postType: 300, // settle after typing
	inputPoll: 400, // polling interval when waiting for input to appear
	copyPoll: 600, // polling interval when waiting for copy button
	afterVerify: 1500, // settle after a verification challenge completes
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
		await new Promise((r) => setTimeout(r, jitter(TIMING.copyPoll)));
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
// Timing jitter
// ============================================================================

/**
 * Add ±20% random jitter to a timing value to avoid bot-like regularity.
 * Also floors at 50ms minimum to prevent micro-polling.
 * @param {number} ms - Base interval in milliseconds
 * @returns {number} Jittered interval
 */
export function jitter(ms) {
	const variance = ms * 0.4;
	const offset = randomInt(-Math.floor(variance), Math.floor(variance) + 1);
	return Math.max(50, Math.round(ms + offset));
}

// ============================================================================
// Stream completion detection
// ============================================================================

/**
 * Wait for generation/streaming to complete by monitoring text length stability.
 *
 * Uses a SINGLE Runtime.evaluate call with awaitPromise: true — the stability
 * polling runs entirely inside the browser context, emitting no CDP traffic
 * during the wait. This avoids the CDP Runtime serialization detection vector
 * that would otherwise fire on every poll tick (~50 evals → 1 eval).
 *
 * @param {string} tab - Tab identifier
 * @param {object} options - Options
 * @param {number} [options.timeout=30000] - Maximum wait time in ms
 * @param {number} [options.interval=600] - Polling interval in ms (jittered ±20%)
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

	// Single self-contained eval — polling runs in the browser, no CDP chatter.
	// The promise resolves when stability is reached or timeout expires.
	const code = String.raw`
	new Promise((resolve, reject) => {
		const _deadline = Date.now() + ${timeout};
		const _baseInterval = ${interval};
		const _stableRounds = ${stableRounds};
		const _minLength = ${minLength};
		let _lastLen = -1;
		let _stableCount = 0;

		function _jitter(ms) {
			return Math.max(50, ms + (Math.random() * ms * 0.4 - ms * 0.2));
		}

		function _poll() {
			try {
				// Re-query DOM each tick — element may not exist at eval start
				const el = ${selector};
				const cur = el?.innerText?.length ?? 0;
				if (cur >= _minLength) {
					if (cur === _lastLen) {
						_stableCount++;
						if (_stableCount >= _stableRounds) { resolve(cur); return; }
					} else {
						_lastLen = cur;
						_stableCount = 0;
					}
				}
				if (Date.now() < _deadline) {
					setTimeout(_poll, _jitter(_baseInterval));
				} else {
					if (_lastLen >= _minLength) { resolve(_lastLen); }
					else { reject(new Error('Generation did not stabilise within ${timeout}ms')); }
				}
			} catch(e) { reject(e); }
		}

		_poll();
	})
	`;

	// Use eval (which has awaitPromise:true in cdp.mjs) with generous timeout.
	// This is ONE Runtime.evaluate call — the polling loop runs in the browser.
	const lenStr = await cdp(["eval", tab, code], timeout + 10000);
	const currentLen = parseInt(lenStr, 10) || 0;

	if (currentLen >= minLength) return currentLen;
	throw new Error(`Generation did not stabilise within ${timeout}ms`);
}

// ============================================================================
// DOM selector waiting (single eval, no polling)
// ============================================================================

/**
 * Wait for a CSS selector to appear in the DOM using a single self-contained
 * eval. The polling loop runs in the browser — zero CDP traffic until done.
 *
 * @param {string} tab - Tab identifier
 * @param {string} selector - CSS selector to wait for
 * @param {number} [timeoutMs=15000] - Maximum wait time in ms
 * @param {number} [interval=500] - Base polling interval in ms (jittered ±20%)
 * @returns {Promise<boolean>} true if selector was found, false on timeout
 */
export async function waitForSelector(
	tab,
	selector,
	timeoutMs = 15000,
	interval = 500,
) {
	const code = String.raw`
	new Promise((resolve) => {
		const _deadline = Date.now() + ${timeoutMs};
		const _baseInterval = ${interval};

		function _jitter(ms) {
			return Math.max(50, ms + (Math.random() * ms * 0.4 - ms * 0.2));
		}

		function _poll() {
			try {
				if (document.querySelector('${selector}')) { resolve(true); return; }
				if (Date.now() < _deadline) { setTimeout(_poll, _jitter(_baseInterval)); }
				else { resolve(false); }
			} catch(_) { resolve(false); }
		}

		_poll();
	})
	`;

	const result = await cdp(["eval", tab, code], timeoutMs + 5000);
	return result === "true";
}

// ============================================================================
// CLI argument parsing
// ============================================================================

/**
 * Prepare args — if --stdin is present, read the query/prompt from stdin
 * and replace the --stdin flag with the content. This avoids leaking queries
 * and prompts via command-line arguments visible in the process table.
 * Call this before parseArgs().
 * @param {string[]} args - process.argv.slice(2)
 * @returns {Promise<string[]>} modified args with query in place of --stdin
 */
export async function prepareArgs(args) {
	const stdinIdx = args.indexOf("--stdin");
	if (stdinIdx === -1) return args;

	const query = await new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data.trim()));
	});

	// Replace --stdin with the query text (parseArgs will extract it as query)
	const modified = [...args];
	modified[stdinIdx] = query;
	return modified;
}

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
	const truncated = answer.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	return lastSpace > 0 ? `${truncated.slice(0, lastSpace)}…` : `${truncated}…`;
}

/**
 * Output JSON result to stdout
 * @param {object} data - Data to output
 */
export function outputJson(data) {
	process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Build a lightweight result envelope from data already collected during extraction.
 * Zero additional CDP calls — everything here is already known.
 * @param {object} fields
 * @returns {object}
 */
export function buildEnvelope({
	engine,
	mode = "headless",
	clipboardEmpty = null,
	fallbackUsed = null,
	blockedBy = null,
	verificationResult = null,
	inputReady = null,
	durationMs = null,
} = {}) {
	return {
		engine,
		mode,
		clipboardEmpty,
		fallbackUsed,
		blockedBy,
		verificationResult,
		inputReady,
		durationMs,
	};
}

/**
 * Handle and output error, then exit.
 * If an envelope is provided, writes it to stdout as JSON so the runner
 * can parse structured diagnostics even on failure.
 * @param {Error} error - Error to handle
 * @param {object} [envelope] - Optional envelope object
 */
export function handleError(error, envelope = null) {
	if (envelope) {
		const out = JSON.stringify({ _envelope: envelope, error: error.message });
		process.stdout.write(`${out}\n`);
	}
	process.stderr.write(`Error: ${error.message}\n`);
	process.exit(1);
}

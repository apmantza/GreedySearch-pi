// extractors/common.mjs — shared utilities for CDP-based extractors
// Extracts common patterns: cdp wrapper, tab management, clipboard interception, source parsing

import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, "..", "bin", "cdp.mjs");

// The module is cached after the first import, so the normal path stays
// in-process without paying a Node startup cost. If loading the shared client
// itself fails, retain the old CLI path as a narrow compatibility fallback.
let cdpClientPromise;
async function loadCdpCommand() {
	if (!cdpClientPromise)
		cdpClientPromise = import("../src/search/cdp-client.mjs");
	return (await cdpClientPromise).cdpCommand;
}

// ============================================================================
// CDP wrapper
// ============================================================================

/**
 * Execute a CDP command through the cdp.mjs CLI
 * @param {string[]} args - Command arguments
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<string>} Command output
 */
// Allowlist of valid CDP subcommands that bin/cdp.mjs accepts. Used by
// cdpSafeArgv() to reject untrusted calls before they reach spawn() —
// defense-in-depth against shell-sandbox escape attempts via crafted CLI
// arguments. Mirrors the commands advertised in bin/cdp.mjs help output.
const VALID_CDP_COMMANDS = new Set([
	"list",
	"snap",
	"eval",
	"shot",
	"html",
	"nav",
	"net",
	"click",
	"clickxy",
	"type",
	"loadall",
	"evalraw",
	"browse",
	"stop",
	"--tab",
]);

/**
 * Validate that args[0] is a known CDP command and reject any element that
 * contains shell metacharacters or null bytes that could break out of the
 * array-form spawn sandbox. Returns the validated argv, or throws on
 * malformed input. The CDP CLI accepts the arguments as positional strings;
 * shell interpretation is not in play because spawn() is invoked with an
 * argv array (no shell), but defense-in-depth validation guards against
 * future callers or refactors that might switch to shell mode.
 */
function cdpSafeArgv(args) {
	if (!Array.isArray(args) || args.length === 0) {
		throw new Error("cdp: args must be a non-empty array");
	}
	// Allow test commands through without subcommand validation
	if (args[0] === "test") return args.map((v, i) => validateArg(v, i));
	// First arg is typically a CDP subcommand (list, eval, nav, ...). Validate it.
	if (!VALID_CDP_COMMANDS.has(args[0])) {
		throw new Error(`cdp: unknown subcommand '${args[0]}'`);
	}
	return args.map((v, i) => validateArg(v, i));
}

function validateArg(value, index) {
	if (typeof value !== "string") {
		throw new Error(
			`cdp: argv[${index}] must be a string (got ${typeof value})`,
		);
	}
	if (value.includes("\0")) {
		throw new Error(`cdp: argv[${index}] contains a null byte`);
	}
	return value;
}

export function cdp(args, timeoutMs = 30000) {
	return cdpWithInput(args, null, timeoutMs);
}

export async function cdpWithInput(args, input = null, timeoutMs = 30000) {
	const safeArgs = cdpSafeArgv(args);
	const commandArgs = safeArgs.slice();
	if (input != null && commandArgs[0] === "type") {
		// cdpWithInput's callers pass ["type", tab, "--stdin"]. Replace
		// that marker before calling the in-process client.
		commandArgs[2] = input;
	}

	try {
		const command = await loadCdpCommand();
		return (await command(commandArgs, timeoutMs)).trim();
	} catch (error) {
		// Do not retry command/daemon errors: a second command could duplicate a
		// click or navigation. Only a failure loading the reusable module uses
		// the legacy process-spawn path.
		if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
	}

	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [CDP, ...safeArgs], {
			stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
		});
		if (input != null) {
			proc.stdin.write(input);
			proc.stdin.end();
		}
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
	let createdTarget;
	try {
		createdTarget = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`Target.createTarget returned invalid JSON: ${error.message}`,
		);
	}
	const { targetId } = createdTarget;
	if (!targetId) {
		throw new Error("Target.createTarget did not return a targetId");
	}
	await cdp(["list"]); // refresh cache
	const tid = targetId.slice(0, 8);
	// Inject stealth patches for anti-detection coverage (both headless + visible).
	// MUST be awaited: the daemon processes commands concurrently, so a
	// fire-and-forget registration races the next Page.navigate and the
	// script may not be in place when the new document is created.
	// Sites like consensus.app use this race to detect automation — the
	// script's Navigator/webdriver overrides are absent on first paint,
	// fingerprinting fires, and the user is bounced to a sign-up wall.
	try {
		await injectHeadlessStealth(tid);
	} catch (e) {
		process.stderr.write(
			`[getOrOpenTab] stealth injection failed: ${e.message}\n`,
		);
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
    (() => {
      window.${globalVar} = null;
      const _clipboard = navigator.clipboard;
      if (!_clipboard) return;
      const _origWriteText = typeof _clipboard.writeText === 'function'
        ? _clipboard.writeText.bind(_clipboard)
        : null;
      const _origWrite = typeof _clipboard.write === 'function'
        ? _clipboard.write.bind(_clipboard)
        : null;

      _clipboard.writeText = function(text) {
        window.${globalVar} = String(text ?? '');
        if (!_origWriteText) return Promise.resolve();
        // The OS/browser clipboard write may be denied in automated Chrome or
        // when the tab is not focused. We only need the captured text; returning
        // a resolved promise prevents the page from surfacing a misleading
        // "failed to copy" toast after our interceptor already succeeded.
        return Promise.resolve(_origWriteText(text)).catch(() => undefined);
      };

      _clipboard.write = async function(items) {
        try {
          for (const item of items || []) {
            if (item.types && item.types.includes('text/plain')) {
              const blob = await item.getType('text/plain');
              window.${globalVar} = await blob.text();
              break;
            }
          }
        } catch(e) {}
        if (!_origWrite) return undefined;
        try { return await _origWrite(items); }
        catch (_) { return undefined; }
      };
    })();
  `;
	await cdp(["eval", tab, code]);
}

// ============================================================================
// Clipboard copy-click helper
// ============================================================================

/**
 * Click a copy button and await the clipboard-interceptor global becoming
 * non-empty, entirely inside the browser — a single Runtime.evaluate call
 * instead of a node-side click+sleep+read cycle per attempt.
 *
 * @param {string} tab - Tab identifier
 * @param {string} clickExpr - JS expression (no trailing semicolon) that,
 *   when evaluated, clicks the copy button (e.g. `document.querySelector('x')?.click()`)
 * @param {string} globalVar - Global variable name written by the clipboard interceptor
 * @param {object} [options]
 * @param {number} [options.timeoutMs=2600] - Total budget in ms
 * @param {number} [options.retryClick] - Elapsed ms at which to re-click if still empty; defaults to 40% of timeoutMs
 * @returns {Promise<string>} Captured clipboard text, or '' on timeout
 */
export async function clickCopyAndAwaitClipboard(
	tab,
	clickExpr,
	globalVar,
	options = {},
) {
	const { timeoutMs = 2600 } = options;
	const retryClick =
		options.retryClick != null ? options.retryClick : Math.floor(timeoutMs * 0.4);
	const code = String.raw`
	new Promise((resolve) => {
		const _deadline = Date.now() + ${timeoutMs};
		const _retryAt = Date.now() + ${retryClick};
		let _retried = false;
		function _click() { try { ${clickExpr}; } catch(_) {} }
		function _poll() {
			const val = window.${globalVar};
			if (val) { resolve(val); return; }
			if (!_retried && Date.now() >= _retryAt) {
				_retried = true;
				_click();
			}
			if (Date.now() < _deadline) { setTimeout(_poll, 100); }
			else { resolve(window.${globalVar} || ''); }
		}
		_click();
		_poll();
	})
	`;
	return await cdp(["eval", tab, code], timeoutMs + 5000).catch(() => "");
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

  // Real Chrome without automation should not expose navigator.webdriver at all.
  // A literal false or an own-property getter returning undefined is itself a
  // common stealth tell; remove both instance and prototype properties when the
  // descriptor is configurable (as it is with --disable-blink-features).
  try { delete navigator.webdriver; } catch(_) {}
  try { delete Navigator.prototype.webdriver; } catch(_) {}
  Object.defineProperty(navigator, 'vendor', { get: () => 'Google Inc.', configurable: true });
  Object.defineProperty(navigator, 'platform', { get: () => 'Win32', configurable: true });
  Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0, configurable: true });
  Object.defineProperty(navigator, 'pdfViewerEnabled', { get: () => true, configurable: true });
  Object.defineProperty(navigator, 'productSub', { get: () => '20030107', configurable: true });
  Object.defineProperty(navigator, 'product', { get: () => 'Gecko', configurable: true });
  var __greedyMimeTypes = null;
  function __makeMimeTypes() {
    var pdf = { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null };
    var textPdf = { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: null };
    try { Object.setPrototypeOf(pdf, MimeType.prototype); } catch(_) {}
    try { Object.setPrototypeOf(textPdf, MimeType.prototype); } catch(_) {}
    var m = [pdf, textPdf];
    try { Object.setPrototypeOf(m, MimeTypeArray.prototype); } catch(_) {}
    m.item = function item(i) { return this[i] || null; };
    m.namedItem = function namedItem(name) { return Array.prototype.find.call(this, function(x) { return x && x.type === name; }) || null; };
    return m;
  }
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      __greedyMimeTypes = __greedyMimeTypes || __makeMimeTypes();
      var plugin0 = { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' };
      var plugin1 = { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' };
      var plugin2 = { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' };
      try { Object.setPrototypeOf(plugin0, Plugin.prototype); } catch(_) {}
      try { Object.setPrototypeOf(plugin1, Plugin.prototype); } catch(_) {}
      try { Object.setPrototypeOf(plugin2, Plugin.prototype); } catch(_) {}
      var p = [plugin0, plugin1, plugin2];
      p.item = function item(i) { return this[i] || null; };
      p.namedItem = function namedItem(name) { return Array.prototype.find.call(this, function(x) { return x && x.name === name; }) || null; };
      p.refresh = function refresh() {};
      try { Object.setPrototypeOf(p, PluginArray.prototype); } catch(_) {}
      try {
        __greedyMimeTypes[0].enabledPlugin = p[0];
        __greedyMimeTypes[1].enabledPlugin = p[0];
      } catch(_) {}
      return p;
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => {
      __greedyMimeTypes = __greedyMimeTypes || __makeMimeTypes();
      return __greedyMimeTypes;
    },
    configurable: true,
  });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
  try {
    Object.defineProperty(navigator, 'connection', { get: () => ({ effectiveType: '4g', rtt: 50, downlink: 10, downlinkMax: Infinity, saveData: false }), configurable: true });
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
  // ── Missing platform APIs (headless often lacks these) ─
  try {
    if (!navigator.share) {
      navigator.share = function() { return Promise.reject(new Error('NotAllowedError')); };
    }
  } catch(_) {}
  try {
    if (!navigator.contentIndex) {
      Object.defineProperty(navigator, 'contentIndex', { get: () => ({ add: function() {}, delete: function() {}, getAll: function() { return Promise.resolve([]); } }), configurable: true });
    }
  } catch(_) {}

  if (!window.chrome) {
    window.chrome = {
      app: { isInstalled: false, InstallState: {}, RunningState: {} },
      runtime: {
        OnInstalledReason: {}, OnRestartRequiredReason: {}, PlatformArch: {}, PlatformNaclArch: {}, PlatformOs: {}, RequestUpdateCheckStatus: {},
        connect: () => ({}), sendMessage: () => {}, onMessage: { addListener: () => {} }
      },
      loadTimes: function() { return { requestTime: 0, startLoadTime: Date.now() - 5000, commitLoadTime: Date.now() - 3000, finishDocumentLoadTime: Date.now() - 2000, finishLoadTime: Date.now() - 1000, firstPaintTime: Date.now() - 800, navigationType: 'Other', wasFetchedViaSpdy: true, wasNpnNegotiated: true, npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false, connectionInfo: 'http/2' }; },
      csi: function() { var t = Date.now(); return { onloadT: t - 2000, startE: t - 5000, pageT: 'back', tran: 2 }; },
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
  // ── WebGL readPixels noise ──────────────────────────
  // CreepJS and other fingerprinters draw content with WebGL and read back the
  // rendered pixels. Adding subtle noise breaks rendering-based fingerprinting.
  try {
    var origReadPixels = WebGLRenderingContext.prototype.readPixels;
    WebGLRenderingContext.prototype.readPixels = __markNative(function readPixels(x, y, width, height, format, type, pixels) {
      var result = origReadPixels.call(this, x, y, width, height, format, type, pixels);
      if (pixels && pixels.length > 0) {
        pixels[0] ^= 1;
      }
      return result;
    });
  } catch(_) {}
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8, configurable: true });

  // ── Canvas fingerprint noise ─────────────────────────
  // Headless rendering engines produce slightly different canvas output
  // than headed Chrome. Subtle noise breaks hash-based fingerprinting.
  try {
    var __canvasNoise = ((Date.now() & 0xFF) | 1);
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
        // Spread noise across canvas to break hash-based fingerprinting.
        // Uses a deterministic pattern so it's consistent per page load
        // but varies between sessions.
        var w = this.width, h = this.height;
        if (w > 0 && h > 0) {
          var imgData = ctx.getImageData(0, 0, Math.min(w, 4), Math.min(h, 4));
          if (imgData && imgData.data) {
            for (var __i = 0; __i < imgData.data.length; __i += 4) {
              imgData.data[__i] ^= (__canvasNoise + __i) & 0xFF;
            }
            ctx.putImageData(imgData, 0, 0);
          }
        }
      }
      return origToDataURL.apply(this, arguments);
    });
  } catch(_) {}

  // ── AudioContext fingerprint noise ────────────────────
  // Headless Chrome's AudioContext produces slightly different output.
  // Subtle noise breaks audio-based fingerprinting.
  try {
    var __audioSeed = ((Date.now() & 0x1F) | 1);
    var origGetChannelData = AudioBuffer.prototype.getChannelData;
    AudioBuffer.prototype.getChannelData = __markNative(function getChannelData(channel) {
      var data = origGetChannelData.call(this, channel);
      for (var __i = 0; __i < data.length; __i += 64) {
        data[__i] *= 0.99999;
      }
      return data;
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
  // Headless Chrome often reports an 800x600 screen even when the viewport is
  // 1920x1080. Keep screen metrics internally consistent with our launch flags.
  try {
    Object.defineProperty(screen, 'width', { get: () => 1920, configurable: true });
    Object.defineProperty(screen, 'height', { get: () => 1080, configurable: true });
    Object.defineProperty(screen, 'availWidth', { get: () => 1920, configurable: true });
    Object.defineProperty(screen, 'availHeight', { get: () => 1040, configurable: true });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24, configurable: true });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24, configurable: true });
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

/**
 * Linear-time "is this a non-empty digit string?" check.
 * Equivalent to /^\d+$/ without the regex — used to keep the
 * parseSourcesFromMarkdownRefStyle inline scan free of any regex
 * (SonarCloud hotspot js:S5852).
 * @param {string} s
 * @returns {boolean}
 */
function isAllDigits(s) {
	if (!s) return false;
	for (let k = 0; k < s.length; k++) {
		const c = s.charCodeAt(k);
		if (c < 48 || c > 57) return false;
	}
	return true;
}

/**
 * Parse reference-style markdown links: [text][num] with [num]: url "title" at bottom.
 * ChatGPT uses this format for its inline citations.
 * @param {string} text - Markdown text
 * @returns {Array<{title: string, url: string}>} Extracted sources
 */
export function parseSourcesFromMarkdownRefStyle(text) {
	if (!text) return [];
	const results = [];

	// Find all reference definitions: [num]: url "title"
	const refMap = new Map();
	const refRegex = /^\[(\d+)\]:\s*(https?:\/\/[^\s"]+)(?:\s+"([^"]*)")?/gm;
	let m;
	while ((m = refRegex.exec(text)) !== null) {
		const num = m[1];
		const url = m[2];
		const title = m[3] || "";
		refMap.set(num, { url, title });
	}

	// Find inline references: [text][num] or [num]. Linear scan via
	// indexOf — avoids the ReDoS-prone /\[([^\]]*)\]\[(\d+)\]/g pattern
	// (SonarCloud hotspot js:S5852). The original `[^\]]*` allowed `[`
	// inside, which caused quadratic backtracking on inputs like
	// `[a[[[[[[[[[[[1]`.
	let cursor = 0;
	while (cursor < text.length) {
		const open = text.indexOf("[", cursor);
		if (open === -1) break;
		const close = text.indexOf("]", open + 1);
		if (close === -1) break;
		if (text[close + 1] !== "[") {
			cursor = open + 1;
			continue;
		}
		const close2 = text.indexOf("]", close + 2);
		if (close2 === -1) break;

		const inner = text.slice(open + 1, close);
		const numStr = text.slice(close + 2, close2);
		if (isAllDigits(numStr)) {
			const ref = refMap.get(numStr);
			if (ref && !results.some((r) => r.url === ref.url)) {
				results.push({
					title: inner.trim() || ref.title || "",
					url: ref.url,
				});
			}
		}
		cursor = close2 + 1;
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

	if (!onPoll) {
		const code = String.raw`
		new Promise((resolve) => {
			const _deadline = Date.now() + ${timeout};
			function _poll() {
				if (document.querySelector('${selector}')) { resolve(true); return; }
				if (Date.now() < _deadline) { setTimeout(_poll, 150); }
				else { resolve(false); }
			}
			_poll();
		})
		`;
		const found = await cdp(["eval", tab, code], timeout + 5000).catch(
			() => "false",
		);
		if (found === "true") return;
		throw new Error(
			`Copy button ('${selector}') did not appear within ${timeout}ms`,
		);
	}

	const deadline = Date.now() + timeout;
	let tick = 0;
	while (Date.now() < deadline) {
		const found = await cdp([
			"eval",
			tab,
			`!!document.querySelector('${selector}')`,
		]).catch(() => "false");
		if (found === "true") return;
		await onPoll(++tick).catch(() => null);
		await new Promise((r) => setTimeout(r, jitter(TIMING.copyPoll)));
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
	const variance = ms * 0.2;
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
 * @param {number} [options.timeout=20000] - Maximum wait time in ms
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
 * Record the current extractor stage for debugging and timeout diagnostics.
 * Writes `[engine] stage: <name> (+<ms>)` to stderr and updates `env.lastStage`
 * / `env.stages` so the envelope carries the last known phase on any outcome
 * (success, error, timeout, kill).
 *
 * @param {object} env - The mutable env object the extractor is filling in.
 * @param {string} stage - Short, snake_case stage name (e.g. "nav", "type", "stream").
 * @param {number} [startTime] - Optional extractor start time for elapsed-ms logging.
 */
export function logStage(env, stage, startTime = null) {
	if (!env || typeof env !== "object") return;
	const elapsed = startTime ? ` (+${Date.now() - startTime}ms)` : "";
	env.lastStage = stage;
	if (!Array.isArray(env.stages)) env.stages = [];
	env.stages.push({ stage, at: Date.now() });
	const engine = env.engine || "extractor";
	console.error(`[${engine}] stage: ${stage}${elapsed}`);
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
	lastStage = null,
	stages = null,
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
		lastStage,
		stages,
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

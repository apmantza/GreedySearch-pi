import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";

// consent.mjs — auto-dismiss common cookie/consent banners and human-verification pages
// Call dismissConsent(tab, cdpFn) after navigating to any page.

const CONSENT_JS = `
(function() {
  // Google consent page (consent.google.com)
  var g = document.querySelector('#L2AGLb, button[jsname="b3VHJd"], .tHlp8d');
  if (g) { g.click(); return 'google'; }

  // OneTrust (used by many sites including Stack Overflow)
  var ot = document.querySelector('#onetrust-accept-btn-handler, .onetrust-accept-btn-handler');
  if (ot) { ot.click(); return 'onetrust'; }

  // Generic "accept all" / "agree" buttons
  var btns = Array.from(document.querySelectorAll('button, a[role=button]'));
  var accept = btns.find(b => /^(accept all|accept cookies|agree|i agree|got it|allow all|allow cookies)$/i.test(b.innerText?.trim()));
  if (accept) { accept.click(); return 'generic:' + accept.innerText.trim(); }

  return null;
})()
`;

// Detect verification challenges — returns element info (NOT clicking).
// The CDP-side handleVerification performs human-like clicks on found elements.
const VERIFY_DETECT_JS = `
(function() {
  var url = document.location.href;

  // --- Google "sorry" page (hard CAPTCHA, can't auto-solve) ---
  if (url.includes('/sorry/') || url.includes('sorry.google')) return 'sorry-page';

  // --- Microsoft account verification page ---
  if (url.includes('login.microsoftonline.com') || url.includes('login.live.com') || url.includes('account.microsoft.com')) {
    var msBtns = Array.from(document.querySelectorAll('button, input[type=submit], a'));
    var msVerify = msBtns.find(b => /verify|continue|next/i.test(b.innerText?.trim() || b.value || ''));
    if (msVerify) { msVerify.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:msVerify.innerText?.trim()||msVerify.value}); }
  }

  // --- Copilot / modal verification ---
  var modal = document.querySelector('[role="dialog"], .b_modal, [class*="verify"], [class*="challenge"]');
  if (modal) {
    var modalBtns = Array.from(modal.querySelectorAll('button, a[role="button"], input[type="submit"]'));
    var actionBtn = modalBtns.find(b => /^(continue|verify|submit|next|i agree|accept|got it)$/i.test(b.innerText?.trim() || b.value || ''));
    if (actionBtn) { actionBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:actionBtn.innerText?.trim()}); }
  }

  // --- Turnstile / Cloudflare challenge iframe (return coordinates for humanClickXY) ---
  var turnstileIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge"]');
  if (turnstileIframe) {
    var r = turnstileIframe.getBoundingClientRect();
    return JSON.stringify({t:'xy',x:r.left+30,y:r.top+r.height/2});
  }

  // --- Cloudflare Turnstile widget inside closed shadow DOM (Copilot, etc.) ---
  // The iframe is not queryable from main document, but the host container
  // (#cf-turnstile) and the hidden response input are.
  var cfTurnstileHost = document.querySelector('#cf-turnstile, [id^="cf-chl-widget-"]');
  if (cfTurnstileHost) {
    var r2 = cfTurnstileHost.getBoundingClientRect();
    return JSON.stringify({t:'xy',x:r2.left+r2.width/2,y:r2.top+r2.height/2});
  }

  // --- Cloudflare challenge page ---
  var cfCheckbox = document.querySelector('#cf-stage input[type="checkbox"], .ctp-checkbox-container input');
  if (cfCheckbox) { cfCheckbox.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:'cloudflare-checkbox'}); }
  var cfBtn = document.querySelector('#challenge-form button, .cf-challenge button');
  if (cfBtn) { cfBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:cfBtn.innerText?.trim()}); }

  // --- Microsoft "I am human" button ---
  var msHumanBtn = document.querySelector('button[id*="i0"], button[id*="id__"]');
  if (msHumanBtn && /verify|human|robot|continue/i.test(msHumanBtn.innerText?.trim())) {
    msHumanBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:msHumanBtn.innerText.trim()});
  }

  // --- Generic verify/continue/proceed buttons (catch-all) ---
  // IMPORTANT: exclude sign-in / OAuth buttons (e.g. "Continue with Google")
  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var verify = btns.find(b => {
    var t = (b.innerText?.trim() || b.value || '').toLowerCase();
    var isVerifyLike = (t.includes('verify') || t.includes('human') || t.includes('robot') || t.includes('continue') || t.includes('proceed')) &&
           !t.includes('verified') && !document.querySelector('iframe[src*="recaptcha"]');
    if (!isVerifyLike) return false;
    // Exclude OAuth / sign-in buttons to prevent accidental login flows
    var isSignIn = /sign.in|log.in|google|microsoft|apple|facebook|github|auth/i.test(t);
    return !isSignIn;
  });
  if (verify) { verify.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:verify.innerText?.trim()||verify.value}); }

  // --- Google reCAPTCHA checkbox ---
  var recaptchaCheckbox = document.querySelector('.recaptcha-checkbox-unchecked, input[type=checkbox][id*="recaptcha"]');
  if (recaptchaCheckbox) { recaptchaCheckbox.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:'recaptcha'}); }

  return null;
})()
`;

// Retry detection — returns 'cleared' if no verification page, or selector info
const VERIFY_RETRY_JS = `
(function() {
  var url = document.location.href;
  var isVerifyPage = url.includes('/sorry/') ||
                     url.includes('challenges.cloudflare.com') ||
                     url.includes('login.microsoftonline.com') ||
                     document.querySelector('#challenge-running, #challenge-stage, .cf-turnstile, [role="dialog"]');
  if (!isVerifyPage) return 'cleared';

  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var btn = btns.find(b => {
    var t = (b.innerText?.trim() || b.value || '').toLowerCase();
    var isVerifyLike = t.includes('verify') || t.includes('human') || t.includes('robot') || t.includes('continue') || t.includes('next') || t.includes('submit');
    if (!isVerifyLike) return false;
    var isSignIn = /sign.in|log.in|google|microsoft|apple|facebook|github|auth/i.test(t);
    return !isSignIn;
  });
  if (btn) { btn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:btn.innerText?.trim()||btn.value}); }

  var cf = document.querySelector('#cf-stage input[type="checkbox"], .cf-turnstile input');
  if (cf) { cf.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:'turnstile'}); }

  // Cloudflare Turnstile widget inside closed shadow DOM (detected via host container)
  var cfTurnstileHost = document.querySelector('#cf-turnstile, [id^="cf-chl-widget-"]');
  if (cfTurnstileHost) { return 'still-verifying'; }

  var modal = document.querySelector('[role="dialog"], .b_modal, [class*="verify"]');
  if (modal) {
    var modalBtn = modal.querySelector('button, a[role="button"]');
    if (modalBtn) { modalBtn.setAttribute('data-gs-verify','1'); return JSON.stringify({t:'sel',s:'[data-gs-verify="1"]',txt:modalBtn.innerText?.trim()}); }
  }

  return 'still-verifying';
})()
`;

export async function dismissConsent(tab, cdp) {
	const result = await cdp(["eval", tab, CONSENT_JS]).catch(() => null);
	if (result && result !== "null") {
		await new Promise((r) => setTimeout(r, 1500));
	}
}

// ─── Human-like click simulation (multi-event with jitter) ────────────

function rng(min, max) {
	// crypto.randomInt is used instead of Math.random() to comply with SonarCloud security hotspot S2245.
	// This is NOT security-sensitive — the random values are only used for mouse-jitter and timing delays.
	return randomInt(min * 1000, max * 1000) / 1000;
}

/**
 * Fire a browser-level Input.dispatchMouseEvent via Chrome's top-level CDP
 * WebSocket. Unlike page-session dispatch, this routes through the compositor
 * and reaches OOPIFs (e.g. Cloudflare Turnstile in a cross-origin iframe).
 * Best-effort — errors are silently swallowed.
 */
async function browserLevelClick(x, y) {
	if (!globalThis.WebSocket) return;
	const profileDir = process.env.CDP_PROFILE_DIR;
	if (!profileDir) return;
	const portFile = `${profileDir.replaceAll("\\", "/")}/DevToolsActivePort`;
	if (!existsSync(portFile)) return;
	const port = readFileSync(portFile, "utf8").trim().split("\n")[0];

	const version = await new Promise((resolve, reject) => {
		const req = http.get(`http://localhost:${port}/json/version`, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => {
				try {
					resolve(JSON.parse(body));
				} catch {
					reject(new Error("bad JSON"));
				}
			});
		});
		req.on("error", reject);
		req.setTimeout(1000, () => {
			req.destroy();
			reject(new Error("timeout"));
		});
	});

	const ws = new globalThis.WebSocket(version.webSocketDebuggerUrl);
	let msgId = 0;

	await new Promise((resolve) => {
		ws.onopen = async () => {
			const send = (method, params) =>
				new Promise((r) => {
					const id = ++msgId;
					const handler = (evt) => {
						if (JSON.parse(evt.data).id === id) {
							ws.removeEventListener("message", handler);
							r();
						}
					};
					ws.addEventListener("message", handler);
					ws.send(JSON.stringify({ id, method, params }));
				});

			const cx = x + rng(-2, 2);
			const cy = y + rng(-2, 2);
			await send("Input.dispatchMouseEvent", {
				type: "mouseMoved",
				x: cx,
				y: cy,
				button: "none",
			});
			await new Promise((r) => setTimeout(r, rng(80, 160)));
			await send("Input.dispatchMouseEvent", {
				type: "mousePressed",
				x: cx,
				y: cy,
				button: "left",
				clickCount: 1,
			});
			await new Promise((r) => setTimeout(r, rng(30, 80)));
			await send("Input.dispatchMouseEvent", {
				type: "mouseReleased",
				x: cx + rng(-1, 1),
				y: cy + rng(-1, 1),
				button: "left",
				clickCount: 1,
			});
			setTimeout(() => {
				ws.close();
				resolve();
			}, 200);
		};
		ws.onerror = () => resolve();
		setTimeout(resolve, 3000);
	});
}

/**
 * Perform a human-like click at specific coordinates via CDP Input.dispatchMouseEvent.
 * Sends: mouseMoved → randomPause → mousePressed → randomPause → mouseReleased
 * with coordinate jitter and variable timing to mimic human motor variance.
 */
export async function humanClickXY(tab, cdpFn, x, y) {
	const cx = Number.parseFloat(x);
	const cy = Number.parseFloat(y);
	if (Number.isNaN(cx) || Number.isNaN(cy)) {
		throw new Error(`humanClickXY: invalid coordinates (${x}, ${y})`);
	}

	const base = { button: "left", clickCount: 1, modifiers: 0 };

	// ── mouseMoved with slight jitter ──
	const jx = cx + rng(-3, 3);
	const jy = cy + rng(-3, 3);
	await cdpFn([
		"evalraw",
		tab,
		"Input.dispatchMouseEvent",
		JSON.stringify({ ...base, type: "mouseMoved", x: jx, y: jy }),
	]);
	// Brief hover delay (80-180ms) — humans don't instant-click
	await new Promise((r) => setTimeout(r, rng(80, 180)));

	// ── mousePressed at jittered position ──
	const px = cx + rng(-2, 2);
	const py = cy + rng(-2, 2);
	await cdpFn([
		"evalraw",
		tab,
		"Input.dispatchMouseEvent",
		JSON.stringify({ ...base, type: "mousePressed", x: px, y: py }),
	]);
	// Hold delay (30-90ms) — mimics human click duration
	await new Promise((r) => setTimeout(r, rng(30, 90)));

	// ── mouseReleased at jittered position ──
	const rx = px + rng(-1, 1);
	const ry = py + rng(-1, 1);
	await cdpFn([
		"evalraw",
		tab,
		"Input.dispatchMouseEvent",
		JSON.stringify({ ...base, type: "mouseReleased", x: rx, y: ry }),
	]);

	// Also fire via browser-level CDP WebSocket so the click reaches OOPIFs
	// (cross-origin iframes like Cloudflare Turnstile) that page-session
	// dispatch can't route to. Best-effort — never throws.
	await browserLevelClick(cx, cy).catch(() => {});

	// Post-click settle
	await new Promise((r) => setTimeout(r, rng(100, 300)));

	return `human-clicked at (${cx.toFixed(0)}, ${cy.toFixed(0)})`;
}

/**
 * Find an element by CSS selector and perform a human-like click on its center.
 */
export async function humanClickElement(tab, cdpFn, selector) {
	// Get element bounding rect
	const rect = await cdpFn([
		"eval",
		tab,
		`(function() {
			var el = document.querySelector('${selector.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}');
			if (!el) return 'null';
			var r = el.getBoundingClientRect();
			return JSON.stringify({x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height});
		})()`,
	]).catch(() => "null");

	if (!rect || rect === "null") {
		return null; // Element not found
	}

	const parsed = JSON.parse(rect);
	// Skip elements with zero dimensions or off-screen position — clicking at
	// (0,0) is a false positive (hidden/unmounted element matched the selector).
	if (parsed.w === 0 || parsed.h === 0 || (parsed.x === 0 && parsed.y === 0)) {
		return null;
	}

	const { x, y } = parsed;
	return humanClickXY(tab, cdpFn, x, y);
}

/**
 * Parse a detection result and perform a human click if it found something.
 * Returns true if a click was performed.
 */
async function tryHumanClick(tab, cdp, detectResult) {
	if (
		!detectResult ||
		detectResult === "null" ||
		detectResult === "cleared" ||
		detectResult === "still-verifying"
	)
		return false;

	// JSON format: {t:"sel",s:"...",txt:"..."} or {t:"xy",x:...,y:...}
	try {
		const info = JSON.parse(detectResult);
		if (info.t === "sel" && info.s) {
			process.stderr.write(
				`[greedysearch] Human-clicking "${info.txt}" via CDP...\n`,
			);
			const r = await humanClickElement(tab, cdp, info.s);
			return r !== null;
		}
		if (info.t === "xy") {
			// Skip zero/invalid coordinates — element is off-screen or not rendered
			if (!info.x && !info.y) return false;
			process.stderr.write(
				`[greedysearch] Human-clicking at (${info.x.toFixed(0)}, ${info.y.toFixed(0)})...\n`,
			);
			await humanClickXY(tab, cdp, info.x, info.y);
			return true;
		}
	} catch {}

	return false;
}

export async function detectVerificationChallenge(tab, cdp) {
	const result = await cdp(["eval", tab, VERIFY_DETECT_JS]).catch(() => null);
	return result && result !== "null" ? result : null;
}

// Returns 'clear' | 'clicked' | 'needs-human'
export async function handleVerification(tab, cdp, waitMs = 30000) {
	const result = await detectVerificationChallenge(tab, cdp);

	if (!result) return "clear";

	// Hard CAPTCHA page — wait for user to solve it manually
	if (result === "sorry-page") {
		process.stderr.write(
			`[greedysearch] Google CAPTCHA detected — please solve it in the browser window (waiting up to ${Math.floor(waitMs / 1000)}s)...\n`,
		);
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 2000));
			const url = await cdp(["eval", tab, "document.location.href"]).catch(
				() => "",
			);
			if (!url.includes("/sorry/")) return "cleared-by-user";
		}
		return "needs-human";
	}

	// Perform human click on detected element
	const clicked = await tryHumanClick(tab, cdp, result);
	if (clicked) {
		await new Promise((r) => setTimeout(r, 2000));

		// Retry loop — keep checking until cleared or timeout
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			const retryResult = await cdp(["eval", tab, VERIFY_RETRY_JS]).catch(
				() => null,
			);
			if (retryResult === "cleared" || !retryResult || retryResult === "null") {
				process.stderr.write("[greedysearch] Verification cleared.\n");
				return "clicked";
			}
			if (retryResult !== "still-verifying") {
				await tryHumanClick(tab, cdp, retryResult);
				await new Promise((r) => setTimeout(r, 2000));
			} else {
				await new Promise((r) => setTimeout(r, 1500));
			}
		}
		process.stderr.write(
			"[greedysearch] Verification may require manual intervention.\n",
		);
		return "needs-human";
	}

	return "clear";
}

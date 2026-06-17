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
  // (#cf-turnstile) and the hidden response input are. When only the
  // hidden response input matches (no #cf-turnstile host and no visible
  // iframe), the actual challenge widget is rendered inside a closed
  // shadow DOM and cannot be auto-clicked. Return a sentinel so callers
  // know to surface this as needs-human verification instead of wasting
  // time on a doomed waitForSelector.
  var cfTurnstileHost = document.querySelector('#cf-turnstile');
  if (cfTurnstileHost) {
    var r2 = cfTurnstileHost.getBoundingClientRect();
    return JSON.stringify({t:'xy',x:r2.left+r2.width/2,y:r2.top+r2.height/2});
  }
  // Hidden cf-chl-widget-*_response input present but no visible host:
  // the widget is in closed shadow DOM. Signal this so handleVerification
  // can return 'needs-human' rather than 'clear'.
  var cfResponseInput = document.querySelector('input[name="cf-turnstile-response"], [id^="cf-chl-widget-"][id$="_response"]');
  if (cfResponseInput && cfResponseInput.value === '') {
    return 'cf-closed-shadow-dom';
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
 *
 * Returns a tristate string:
 *   - 'clicked'  — a click was successfully dispatched
 *   - 'cant-click' — challenge was detected but we couldn't click it
 *                    (zero-dimension element, OOPIF in closed shadow DOM, etc.)
 *                    Caller should treat this as needs-human verification.
 *   - 'no-challenge' — no challenge detected, nothing to click
 */
function tryHumanClick(tab, cdp, detectResult) {
	if (
		!detectResult ||
		detectResult === "null" ||
		detectResult === "cleared" ||
		detectResult === "still-verifying" ||
		detectResult === "cf-closed-shadow-dom"
	)
		return Promise.resolve("no-challenge");

	// JSON format: {t:"sel",s:"...",txt:"..."} or {t:"xy",x:...,y:...}
	try {
		const info = JSON.parse(detectResult);
		if (info.t === "sel" && info.s) {
			process.stderr.write(
				`[greedysearch] Human-clicking "${info.txt}" via CDP...\n`,
			);
			return humanClickElement(tab, cdp, info.s).then((r) =>
				r !== null ? "clicked" : "cant-click",
			);
		}
		if (info.t === "xy") {
			// Skip zero/invalid coordinates — element is off-screen or not rendered
			if (!info.x && !info.y) return Promise.resolve("cant-click");
			process.stderr.write(
				`[greedysearch] Human-clicking at (${info.x.toFixed(0)}, ${info.y.toFixed(0)})...\n`,
			);
			return humanClickXY(tab, cdp, info.x, info.y).then(() => "clicked");
		}
	} catch {}

	return Promise.resolve("no-challenge");
}

export async function detectVerificationChallenge(tab, cdp) {
	// Run the CDP-pierce probe FIRST so we get real click coordinates for
	// Cloudflare iframes hidden inside closed shadow roots (chatgpt.com,
	// perplexity.ai, etc.). The page-context probe falls back to a
	// cf-closed-shadow-dom sentinel when the iframe is opaque to JS DOM
	// queries, but that sentinel can't be auto-clicked.
	const cfIframe = await findCloudflareIframeViaPierce(tab, cdp).catch(
		() => null,
	);
	if (cfIframe) return cfIframe;

	const result = await cdp(["eval", tab, VERIFY_DETECT_JS]).catch(() => null);
	if (result && result !== "null") return result;

	return null;
}

/**
 * Walk the page DOM with pierce:true to locate a Cloudflare Turnstile
 * iframe that's hidden inside a closed shadow root. Returns JSON of the
 * shape `{t:'xy', x, y}` matching the main-document probe's convention,
 * OR null if nothing was found.
 *
 * The returned coords target the **checkbox area** of the Turnstile widget
 * (left ~25% of the 300x65 iframe, vertical center) rather than the
 * iframe's geometric center, because the visible "Verify you are human"
 * checkbox sits there in the standard widget layout.
 */
async function findCloudflareIframeViaPierce(tab, cdp) {
	if (typeof cdp !== "function") return null;

	// Step 1: enable DOM domain if needed (cheap idempotent call)
	await cdp(["evalraw", tab, "DOM.enable", "{}"]).catch(() => {});

	// Step 2: get the full DOM tree with pierce — walks closed shadow roots
	const doc = await cdp(["evalraw", tab, "DOM.getDocument", JSON.stringify({ depth: -1, pierce: true })]).catch(
		() => null,
	);
	if (!doc) return null;
	let docParsed;
	try {
		docParsed = JSON.parse(doc);
	} catch {
		return null;
	}
	if (docParsed.error || !docParsed.root) return null;

	// Step 3: recursive walk looking for an iframe whose src points at
	// challenges.cloudflare.com / turnstile
	const root = docParsed.root;
	const found = await walkForCfIframe(root, tab, cdp);
	return found;
}

async function walkForCfIframe(node, tab, cdp) {
	if (!node) return null;
	const children = [];
	if (node.shadowRoots && node.shadowRoots.length > 0) {
		for (const s of node.shadowRoots) {
			children.push(s);
		}
	}
	if (node.children) {
		for (const c of node.children) children.push(c);
	}
	for (const child of children) {
		if (child.nodeName === "IFRAME") {
			const attrs = child.attributes || [];
			const srcIdx = attrs.indexOf("src");
			const src = srcIdx >= 0 ? attrs[srcIdx + 1] : "";
			if (
				src &&
				/challenges\.cloudflare\.com|turnstile/i.test(src) &&
				child.backendNodeId
			) {
				// Get bounding box via DOM.getBoxModel
				const boxRes = await cdp([
					"evalraw",
					tab,
					"DOM.getBoxModel",
					JSON.stringify({ backendNodeId: child.backendNodeId }),
				]).catch(() => null);
				if (!boxRes) continue;
				let boxParsed;
				try {
					boxParsed = JSON.parse(boxRes);
				} catch {
					continue;
				}
				const content =
					boxParsed?.model?.content || boxParsed?.result?.model?.content;
				if (!content || content.length < 8) continue;
				// content = [x1, y1, x2, y2, x3, y3, x4, y4]
				const x1 = content[0];
				const y1 = content[1];
				const x3 = content[4];
				const y3 = content[5];
				const width = x3 - x1;
				const height = y3 - y1;
				// Skip degenerate boxes (hidden iframes)
				if (width < 50 || height < 20) continue;
				// Click the checkbox: standard CF widget is 300x65 with the
				// checkbox centered at ~25% width, 50% height.
				const checkboxX = x1 + width * 0.25;
				const checkboxY = y1 + height * 0.5;
				process.stderr.write(
					`[greedysearch] Found CF iframe via CDP pierce at (${x1.toFixed(0)}, ${y1.toFixed(0)}) ${width.toFixed(0)}x${height.toFixed(0)}, clicking checkbox at (${checkboxX.toFixed(0)}, ${checkboxY.toFixed(0)})\n`,
				);
				return JSON.stringify({ t: "xy", x: checkboxX, y: checkboxY });
			}
		}
		const deeper = await walkForCfIframe(child, tab, cdp);
		if (deeper) return deeper;
	}
	return null;
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

	// Cloudflare Turnstile rendered inside a closed shadow root (e.g.
	// chatgpt.com). detectVerificationChallenge now uses CDP-level
	// DOM.getDocument({pierce:true}) to walk into the closed root and
	// locate the iframe's screen-space bounding box. The result here is
	// a normal {t:'xy',x,y} coordinate payload that flows through the
	// regular click path. The historical "cf-closed-shadow-dom" sentinel
	// is kept in VERIFY_DETECT_JS only as a safety net for unusual pages.

	// Perform human click on detected element
	const clickResult = await tryHumanClick(tab, cdp, result);
	if (clickResult === "clicked") {
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

	// Challenge was detected but we couldn't auto-click it (zero-dimension
	// element, OOPIF without coordinates, etc.). Surface this rather than
	// silently returning 'clear' — the caller would otherwise proceed and
	// fail downstream on a selector that won't appear until the challenge
	// is solved.
	if (clickResult === "cant-click") {
		process.stderr.write(
			"[greedysearch] Verification challenge detected but cannot be auto-clicked — please solve it manually in the visible browser window.\n",
		);
		return "needs-human";
	}

	return "clear";
}

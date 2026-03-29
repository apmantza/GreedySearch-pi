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

// Detect and auto-click human verification challenges (Google, Microsoft, Cloudflare)
const VERIFY_DETECT_JS = `
(function() {
  var url = document.location.href;
  
  // --- Google "sorry" page (hard CAPTCHA, can't auto-solve) ---
  if (url.includes('/sorry/') || url.includes('sorry.google')) return 'sorry-page';
  
  // --- Microsoft account verification page ---
  if (url.includes('login.microsoftonline.com') || url.includes('login.live.com') || url.includes('account.microsoft.com')) {
    // Look for "Verify" or "Continue" buttons on Microsoft auth pages
    var msBtns = Array.from(document.querySelectorAll('button, input[type=submit], a'));
    var msVerify = msBtns.find(b => /verify|continue|next/i.test(b.innerText?.trim() || b.value || ''));
    if (msVerify) { msVerify.click(); return 'clicked-ms-verify:' + (msVerify.innerText?.trim() || msVerify.value); }
  }
  
  // --- Bing Copilot / Microsoft "Verify you're human" interstitial ---
  // Copilot sometimes shows a modal with "Continue" or "Verify" before allowing queries
  if (url.includes('copilot.microsoft.com') || url.includes('bing.com/chat')) {
    // Look for verification modal/dialog
    var modal = document.querySelector('[role="dialog"], .b_modal, .bnp_hfly, [class*="verify"], [class*="challenge"]');
    if (modal) {
      // Find any actionable button in the modal
      var modalBtns = Array.from(modal.querySelectorAll('button, a[role="button"], input[type="submit"]'));
      var actionBtn = modalBtns.find(b => /^(continue|verify|submit|next|i agree|accept|got it)$/i.test(b.innerText?.trim() || b.value || ''));
      if (actionBtn) { actionBtn.click(); return 'clicked-copilot-modal:' + actionBtn.innerText.trim(); }
    }
    
    // Check for Turnstile iframe (Copilot uses Cloudflare Turnstile)
    var turnstileIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge"], iframe[title*="Widget"]');
    if (turnstileIframe) {
      // Try clicking the iframe container or nearby checkbox
      var container = turnstileIframe.closest('[class*="turnstile"], [class*="challenge"], [id*="turnstile"]') || turnstileIframe.parentElement;
      if (container) {
        var checkbox = container.querySelector('input[type="checkbox"]');
        if (checkbox && !checkbox.checked) {
          checkbox.click();
          return 'clicked-turnstile-in-iframe';
        }
        // Click the container itself (Turnstile often captures clicks on parent)
        container.click();
        return 'clicked-turnstile-container-near-iframe';
      }
    }
  }
  
  // --- Cloudflare Turnstile (used by Copilot and many sites) ---
  // Turnstile widget in iframe
  var turnstileIframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]');
  if (turnstileIframe) {
    // Try to find and click the checkbox inside the iframe's container
    var turnstileCheckbox = document.querySelector('#cf-turnstile-response, [data-turnstile-callback] input, .cf-turnstile input[type="checkbox"]');
    if (turnstileCheckbox && !turnstileCheckbox.checked) {
      turnstileCheckbox.click();
      return 'clicked-turnstile-checkbox';
    }
    // Try clicking the turnstile container itself (some implementations)
    var turnstileContainer = document.querySelector('.cf-turnstile, [data-sitekey]');
    if (turnstileContainer) {
      turnstileContainer.click();
      return 'clicked-turnstile-container';
    }
  }
  
  // --- Cloudflare "Verify you are human" challenge page ---
  if (url.includes('challenges.cloudflare.com') || document.querySelector('#challenge-running, #challenge-stage')) {
    var cfCheckbox = document.querySelector('#cf-stage input[type="checkbox"], .ctp-checkbox-container input');
    if (cfCheckbox) { cfCheckbox.click(); return 'clicked-cloudflare-checkbox'; }
    var cfBtn = document.querySelector('#challenge-form button, .cf-challenge button');
    if (cfBtn) { cfBtn.click(); return 'clicked-cloudflare-button'; }
  }
  
  // --- Microsoft "I am human" / "Verify" challenge ---
  // Microsoft uses various verification UIs
  var msHumanBtn = document.querySelector('button[id*="i0"], button[id*="id__"]');
  if (msHumanBtn && /verify|human|robot|continue/i.test(msHumanBtn.innerText?.trim())) {
    msHumanBtn.click();
    return 'clicked-ms-human:' + msHumanBtn.innerText.trim();
  }
  
  // --- Generic verification buttons (catch-all) ---
  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var verify = btns.find(b => {
    var t = (b.innerText?.trim() || b.value || '').toLowerCase();
    return (t.includes('verify') || t.includes('human') || t.includes('robot') || t.includes('continue') || t.includes('proceed')) &&
           !t.includes('verified') && !document.querySelector('iframe[src*="recaptcha"]');
  });
  if (verify) {
    verify.click();
    return 'clicked-verify:' + (verify.innerText?.trim() || verify.value);
  }

  // --- Google reCAPTCHA (no image challenge, just checkbox) ---
  var recaptchaCheckbox = document.querySelector('.recaptcha-checkbox-unchecked, input[type=checkbox][id*="recaptcha"]');
  if (recaptchaCheckbox) { recaptchaCheckbox.click(); return 'clicked-recaptcha'; }

  return null;
})()
`;

// Retry loop for verification — keeps checking and clicking until page changes or timeout
const VERIFY_RETRY_JS = `
(function() {
  var url = document.location.href;
  
  // Check if we're still on a verification page
  var isVerifyPage = url.includes('/sorry/') || 
                     url.includes('challenges.cloudflare.com') ||
                     url.includes('login.microsoftonline.com') ||
                     document.querySelector('#challenge-running, #challenge-stage, .cf-turnstile, [role="dialog"]');
  
  if (!isVerifyPage) return 'cleared';
  
  // Try clicking any verify/continue button again
  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var btn = btns.find(b => {
    var t = (b.innerText?.trim() || b.value || '').toLowerCase();
    return t.includes('verify') || t.includes('human') || t.includes('robot') || t.includes('continue') || t.includes('next') || t.includes('submit');
  });
  if (btn) { btn.click(); return 'clicked:' + (btn.innerText?.trim() || btn.value); }
  
  // Try Turnstile checkbox
  var cf = document.querySelector('#cf-stage input[type="checkbox"], .cf-turnstile input');
  if (cf && !cf.checked) { cf.click(); return 'clicked-turnstile'; }
  
  // Check for modal dialog with continue button (Copilot interstitial)
  var modal = document.querySelector('[role="dialog"], .b_modal, [class*="verify"]');
  if (modal) {
    var modalBtn = modal.querySelector('button, a[role="button"]');
    if (modalBtn) { modalBtn.click(); return 'clicked-modal-btn:' + modalBtn.innerText.trim(); }
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

// Get iframe bounding box for coordinate-based clicking (for cross-origin Turnstile)
const GET_IFRAME_CENTER_JS = `
(function() {
  var iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[title*="challenge"], iframe[title*="Widget"]');
  if (!iframe) return null;
  var rect = iframe.getBoundingClientRect();
  // Click near the center-left where the checkbox usually is
  return JSON.stringify({ x: rect.left + 30, y: rect.top + rect.height / 2 });
})()
`;

// Returns 'clear' | 'clicked' | 'needs-human'
export async function handleVerification(tab, cdp, waitMs = 60000) {
	const result = await cdp(["eval", tab, VERIFY_DETECT_JS]).catch(() => null);

	if (!result || result === "null") return "clear";

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

	// We clicked something — wait for page to update, then keep retrying
	if (result.startsWith("clicked-")) {
		process.stderr.write(`[greedysearch] Clicked verification: ${result}\n`);
		await new Promise((r) => setTimeout(r, 2000));

		// Keep checking if verification cleared, retry clicking for up to waitMs
		const deadline = Date.now() + waitMs;
		while (Date.now() < deadline) {
			const retryResult = await cdp(["eval", tab, VERIFY_RETRY_JS]).catch(
				() => null,
			);

			if (retryResult === "cleared" || !retryResult || retryResult === "null") {
				process.stderr.write(`[greedysearch] Verification cleared.\n`);
				await new Promise((r) => setTimeout(r, 1000));
				return "clicked";
			}

			if (retryResult.startsWith("clicked:")) {
				process.stderr.write(`[greedysearch] Retrying verification click...\n`);
				await new Promise((r) => setTimeout(r, 2000));
			}

			// If verification is stuck, try clicking the Turnstile iframe by coordinates
			const iframeCenter = await cdp(["eval", tab, GET_IFRAME_CENTER_JS]).catch(
				() => null,
			);
			if (iframeCenter && iframeCenter !== "null") {
				try {
					const { x, y } = JSON.parse(iframeCenter);
					process.stderr.write(
						`[greedysearch] Trying coordinate click on Turnstile iframe at (${x}, ${y})...\n`,
					);
					await cdp(["clickxy", tab, String(x), String(y)]);
					await new Promise((r) => setTimeout(r, 3000));
				} catch {}
			}

			await new Promise((r) => setTimeout(r, 1500));
		}

		// Still stuck — might need user intervention
		process.stderr.write(
			`[greedysearch] Verification may require manual intervention.\n`,
		);
		return "needs-human";
	}

	// Detection didn't find anything initially, but check for Turnstile iframe with coordinates
	if (result === "null" || !result) {
		const iframeCenter = await cdp(["eval", tab, GET_IFRAME_CENTER_JS]).catch(
			() => null,
		);
		if (iframeCenter && iframeCenter !== "null") {
			process.stderr.write(
				`[greedysearch] Found Turnstile iframe, attempting coordinate click...\n`,
			);
			try {
				const { x, y } = JSON.parse(iframeCenter);
				await cdp(["clickxy", tab, String(x), String(y)]);
				await new Promise((r) => setTimeout(r, 3000));

				// Check if it worked
				const cleared = await cdp(["eval", tab, VERIFY_RETRY_JS]).catch(
					() => null,
				);
				if (cleared === "cleared" || cleared === "null") {
					return "clicked";
				}
			} catch {}
		}
	}

	return "clear";
}

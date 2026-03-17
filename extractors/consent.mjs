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

// Detect Google's "verify you're human" / unusual traffic page
const VERIFY_DETECT_JS = `
(function() {
  var url = document.location.href;
  if (url.includes('/sorry/') || url.includes('sorry.google')) return 'sorry-page';

  // Simple click-through verify button (not image CAPTCHA)
  var btns = Array.from(document.querySelectorAll('button, input[type=submit], a[role=button]'));
  var verify = btns.find(b => /verify|human|not a robot|continue/i.test(b.innerText?.trim() || b.value || ''));
  if (verify && !document.querySelector('iframe[src*="recaptcha"]')) {
    verify.click();
    return 'clicked-verify:' + (verify.innerText?.trim() || verify.value);
  }

  // Unchecked reCAPTCHA / Turnstile checkbox (no image challenge)
  var checkbox = document.querySelector('.recaptcha-checkbox-unchecked, input[type=checkbox][id*="recaptcha"], #cf-stage input[type=checkbox]');
  if (checkbox) { checkbox.click(); return 'clicked-checkbox'; }

  return null;
})()
`;

export async function dismissConsent(tab, cdp) {
  const result = await cdp(['eval', tab, CONSENT_JS]).catch(() => null);
  if (result && result !== 'null') {
    await new Promise(r => setTimeout(r, 1500));
  }
}

// Returns 'clear' | 'clicked' | 'needs-human'
export async function handleVerification(tab, cdp, waitMs = 60000) {
  const result = await cdp(['eval', tab, VERIFY_DETECT_JS]).catch(() => null);

  if (!result || result === 'null') return 'clear';

  if (result === 'sorry-page') {
    // Hard CAPTCHA page — wait for user to solve it manually
    process.stderr.write(`[greedysearch] Google verification required — please solve it in the browser window (waiting up to ${waitMs / 1000}s)...\n`);
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 2000));
      const url = await cdp(['eval', tab, 'document.location.href']).catch(() => '');
      if (!url.includes('/sorry/')) return 'cleared-by-user';
    }
    return 'needs-human';
  }

  if (result.startsWith('clicked-')) {
    await new Promise(r => setTimeout(r, 2000));
    return 'clicked';
  }

  return 'clear';
}

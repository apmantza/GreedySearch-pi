// consent.mjs — auto-dismiss common cookie/consent banners
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

export async function dismissConsent(tab, cdp) {
  const result = await cdp(['eval', tab, CONSENT_JS]).catch(() => null);
  if (result && result !== 'null') {
    // Give page a moment to react after dismissal
    await new Promise(r => setTimeout(r, 1500));
  }
}

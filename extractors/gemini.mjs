#!/usr/bin/env node
// extractors/gemini.mjs
// Navigate gemini.google.com/app, submit query, wait for answer, return clean answer + sources.
//
// Usage:
//   node extractors/gemini.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dismissConsent, handleVerification } from './consent.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(homedir(), '.claude', 'skills', 'chrome-cdp', 'scripts', 'cdp.mjs');
const PAGES_CACHE = `${tmpdir().replace(/\\/g, '/')}/cdp-pages.json`;

const COPY_POLL_INTERVAL = 600;
const COPY_TIMEOUT = 120000;    // wait up to 2 min for copy button to appear

// ---------------------------------------------------------------------------

function cdp(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CDP, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`cdp timeout: ${args[0]}`)); }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.trim() || `cdp exit ${code}`));
      else resolve(out.trim());
    });
  });
}

async function getOrOpenTab(tabPrefix) {
  if (tabPrefix) return tabPrefix;
  if (existsSync(PAGES_CACHE)) {
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    const existing = pages.find(p => p.url.includes('gemini.google.com'));
    if (existing) return existing.targetId.slice(0, 8);
  }
  const list = await cdp(['list']);
  return list.split('\n')[0].slice(0, 8);
}

async function typeIntoGemini(tab, text) {
  await cdp(['eval', tab, `
    (function(t) {
      var el = document.querySelector('rich-textarea .ql-editor');
      if (!el) return false;
      el.focus();
      document.execCommand('insertText', false, t);
      return true;
    })(${JSON.stringify(text)})
  `]);
}

async function injectClipboardInterceptor(tab) {
  // Override both clipboard APIs — Gemini uses clipboard.write(ClipboardItem) for rich copy.
  await cdp(['eval', tab, `
    window.__geminiClipboard = null;
    const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      window.__geminiClipboard = text;
      return _origWriteText(text);
    };
    const _origWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async function(items) {
      try {
        for (const item of items) {
          if (item.types && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            window.__geminiClipboard = await blob.text();
            break;
          }
        }
      } catch(e) {}
      return _origWrite(items);
    };
  `]);
}

async function waitForCopyButton(tab) {
  // The "Copy response" button appears only after streaming is complete.
  const deadline = Date.now() + COPY_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, COPY_POLL_INTERVAL));
    const found = await cdp(['eval', tab,
      `!!document.querySelector('button[aria-label="Copy"]')`
    ]).catch(() => 'false');
    if (found === 'true') return;
  }
  throw new Error(`Gemini copy button did not appear within ${COPY_TIMEOUT}ms`);
}

async function extractAnswer(tab) {
  // Click copy button → our interceptor captures the text.
  await cdp(['eval', tab, `document.querySelector('button[aria-label="Copy"]')?.click()`]);
  await new Promise(r => setTimeout(r, 400));

  const answer = await cdp(['eval', tab, `window.__geminiClipboard || ''`]);
  if (!answer) throw new Error('Clipboard interceptor returned empty text');

  // Sources: links rendered in the page (best-effort; Shadow DOM may hide some)
  const raw = await cdp(['eval', tab, `
    (function() {
      var sources = Array.from(document.querySelectorAll('a[href^="http"]'))
        .map(a => ({ url: a.href.split('#')[0], title: a.innerText?.trim().split('\\n')[0] || '' }))
        .filter(s => s.url && !s.url.includes('gemini.google') && !s.url.includes('gstatic') && !s.url.includes('google.com/search'))
        .filter((v, i, arr) => arr.findIndex(x => x.url === v.url) === i)
        .slice(0, 8);
      return JSON.stringify(sources);
    })()
  `]).catch(() => '[]');
  const sources = JSON.parse(raw);

  return { answer: answer.trim(), sources };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') {
    process.stderr.write('Usage: node extractors/gemini.mjs "<query>" [--tab <prefix>]\n');
    process.exit(1);
  }

  const short = args.includes('--short');
  const rest  = args.filter(a => a !== '--short');
  const tabFlagIdx = rest.indexOf('--tab');
  const tabPrefix = tabFlagIdx !== -1 ? rest[tabFlagIdx + 1] : null;
  const query = tabFlagIdx !== -1
    ? rest.filter((_, i) => i !== tabFlagIdx && i !== tabFlagIdx + 1).join(' ')
    : rest.join(' ');

  try {
    await cdp(['list']);
    const tab = await getOrOpenTab(tabPrefix);

    // Each search = fresh conversation
    await cdp(['nav', tab, 'https://gemini.google.com/app'], 35000);
    await new Promise(r => setTimeout(r, 2000));
    await dismissConsent(tab, cdp);
    await handleVerification(tab, cdp, 60000);

    // Wait for input to be ready
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ready = await cdp(['eval', tab, `!!document.querySelector('rich-textarea .ql-editor')`]).catch(() => 'false');
      if (ready === 'true') break;
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 300));

    await injectClipboardInterceptor(tab);
    await typeIntoGemini(tab, query);
    await new Promise(r => setTimeout(r, 400));

    await cdp(['eval', tab, `document.querySelector('button[aria-label*="Send"]')?.click()`]);

    await waitForCopyButton(tab);

    const { answer, sources } = await extractAnswer(tab);
    if (!answer) throw new Error('No answer captured from Gemini clipboard');
    const out = short ? answer.slice(0, 300).replace(/\s+\S*$/, '') + '…' : answer;

    const finalUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => 'https://gemini.google.com/app');
    process.stdout.write(JSON.stringify({ query, url: finalUrl, answer: out, sources }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();

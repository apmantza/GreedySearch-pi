#!/usr/bin/env node
// extractors/mistral.mjs
// Navigate chat.mistral.ai/chat, submit query, wait for answer, return clean answer.
//
// Usage:
//   node extractors/mistral.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { dismissConsent } from './consent.mjs';

const CDP = join(homedir(), '.claude', 'skills', 'chrome-cdp', 'scripts', 'cdp.mjs');
const PAGES_CACHE = `${tmpdir().replace(/\\/g, '/')}/cdp-pages.json`;

const COPY_POLL_INTERVAL = 600;
const COPY_TIMEOUT = 60000;

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
    const existing = pages.find(p => p.url.includes('chat.mistral.ai'));
    if (existing) return existing.targetId.slice(0, 8);
  }
  const list = await cdp(['list']);
  return list.split('\n')[0].slice(0, 8);
}

async function injectClipboardInterceptor(tab) {
  await cdp(['eval', tab, `
    window.__mistralClipboard = null;
    const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      window.__mistralClipboard = text;
      return _origWriteText(text);
    };
    const _origWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async function(items) {
      try {
        for (const item of items) {
          if (item.types && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            window.__mistralClipboard = await blob.text();
            break;
          }
        }
      } catch(e) {}
      return _origWrite(items);
    };
  `]);
}

async function waitForResponseCopyButton(tab) {
  // The "Like" button appears alongside the AI response copy button — only after
  // streaming is complete. The user-message "Copy to clipboard" appears instantly,
  // so we use "Like" as the real completion signal.
  const deadline = Date.now() + COPY_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, COPY_POLL_INTERVAL));
    const found = await cdp(['eval', tab,
      `!!document.querySelector('button[aria-label="Like"]')`
    ]).catch(() => 'false');
    if (found === 'true') return;
  }
  throw new Error(`Mistral response did not complete within ${COPY_TIMEOUT}ms`);
}

async function extractAnswer(tab) {
  // Re-inject interceptor here — Mistral SPA-navigates to a conversation URL
  // after send, which destroys any interceptor injected before the query.
  await injectClipboardInterceptor(tab);

  // Click the copy button that sits in the same action bar as "Like"
  await cdp(['eval', tab, `
    (function() {
      var like = document.querySelector('button[aria-label="Like"]');
      if (!like) return;
      var bar = like.closest('div');
      var copyBtn = bar && bar.querySelector('button[aria-label="Copy to clipboard"]');
      if (copyBtn) copyBtn.click();
    })()
  `]);
  await new Promise(r => setTimeout(r, 400));

  const answer = await cdp(['eval', tab, `window.__mistralClipboard || ''`]);
  if (!answer) throw new Error('Clipboard interceptor returned empty text');

  // Mistral free tier doesn't cite web sources
  return { answer: answer.trim(), sources: [] };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') {
    process.stderr.write('Usage: node extractors/mistral.mjs "<query>" [--tab <prefix>]\n');
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

    // Fresh conversation each search
    await cdp(['nav', tab, 'https://chat.mistral.ai/chat'], 35000);
    await new Promise(r => setTimeout(r, 1500));
    await dismissConsent(tab, cdp);

    // Wait for textarea to be ready (up to 8s)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await cdp(['eval', tab, `!!document.querySelector('textarea')`]).catch(() => 'false');
      if (found === 'true') break;
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 300));

    await cdp(['click', tab, 'textarea']);
    await new Promise(r => setTimeout(r, 300));
    await cdp(['type', tab, query]);
    await new Promise(r => setTimeout(r, 400));

    // Click send button
    await cdp(['eval', tab, `document.querySelector('button[aria-label="Send question"]')?.click()`]);

    await waitForResponseCopyButton(tab);

    const { answer, sources } = await extractAnswer(tab);
    if (!answer) throw new Error('No answer extracted from Mistral');
    const out = short ? answer.slice(0, 300).replace(/\s+\S*$/, '') + '…' : answer;

    const finalUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => 'https://chat.mistral.ai/chat');
    process.stdout.write(JSON.stringify({ query, url: finalUrl, answer: out, sources }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();

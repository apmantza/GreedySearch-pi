#!/usr/bin/env node
// extractors/perplexity.mjs
// Navigate Perplexity, wait for streaming to complete, return clean answer + sources.
//
// Usage:
//   node extractors/perplexity.mjs "<query>" [--tab <prefix>]
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
const COPY_TIMEOUT = 30000;

// ---------------------------------------------------------------------------

function cdp(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CDP, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
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
  // If caller specified a tab, use it
  if (tabPrefix) return tabPrefix;

  // Otherwise look for an existing Perplexity tab
  if (existsSync(PAGES_CACHE)) {
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    const existing = pages.find(p => p.url.includes('perplexity.ai'));
    if (existing) return existing.targetId.slice(0, 8);
  }

  // Fall back to first available tab
  const list = await cdp(['list']);
  const firstLine = list.split('\n')[0];
  if (!firstLine) throw new Error('No Chrome tabs found. Is Chrome running with --remote-debugging-port=9222?');
  return firstLine.slice(0, 8);
}

async function injectClipboardInterceptor(tab) {
  await cdp(['eval', tab, `
    window.__pplxClipboard = null;
    const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      window.__pplxClipboard = text;
      return _origWriteText(text);
    };
    const _origWrite = navigator.clipboard.write.bind(navigator.clipboard);
    navigator.clipboard.write = async function(items) {
      try {
        for (const item of items) {
          if (item.types && item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            window.__pplxClipboard = await blob.text();
            break;
          }
        }
      } catch(e) {}
      return _origWrite(items);
    };
  `]);
}

async function waitForCopyButton(tab) {
  const deadline = Date.now() + COPY_TIMEOUT;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, COPY_POLL_INTERVAL));
    const found = await cdp(['eval', tab,
      `!!document.querySelector('button[aria-label="Copy"]')`
    ]).catch(() => 'false');
    if (found === 'true') return;
  }
  throw new Error(`Perplexity copy button did not appear within ${COPY_TIMEOUT}ms`);
}

async function extractAnswer(tab) {
  await cdp(['eval', tab, `document.querySelector('button[aria-label="Copy"]')?.click()`]);
  await new Promise(r => setTimeout(r, 400));

  const answer = await cdp(['eval', tab, `window.__pplxClipboard || ''`]);
  if (!answer) throw new Error('Clipboard interceptor returned empty text');

  const raw = await cdp(['eval', tab, `
    (function() {
      var sources = Array.from(document.querySelectorAll('[data-pplx-citation-url]'))
        .map(el => ({ url: el.getAttribute('data-pplx-citation-url'), title: el.querySelector('a')?.innerText?.trim() || '' }))
        .filter(s => s.url)
        .filter((v, i, arr) => arr.findIndex(x => x.url === v.url) === i)
        .slice(0, 10);
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
    process.stderr.write('Usage: node extractors/perplexity.mjs "<query>" [--tab <prefix>]\n');
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
    // Refresh page list so cache is current
    await cdp(['list']);

    const tab = await getOrOpenTab(tabPrefix);

    // Navigate to homepage and use the search box (direct ?q= URLs trigger bot redirect)
    await cdp(['nav', tab, 'https://www.perplexity.ai/'], 35000);
    await dismissConsent(tab, cdp);

    // Wait for React app to mount #ask-input (up to 8s)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await cdp(['eval', tab, `!!document.querySelector('#ask-input')`]).catch(() => 'false');
      if (found === 'true') break;
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 300));

    await injectClipboardInterceptor(tab);
    await cdp(['click', tab, '#ask-input']);
    await new Promise(r => setTimeout(r, 400));
    await cdp(['type', tab, query]);
    await new Promise(r => setTimeout(r, 400));
    // Submit with Enter (most reliable across Chrome instances)
    await cdp(['eval', tab,
      `document.querySelector('#ask-input')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`
    ]);

    await waitForCopyButton(tab);

    const { answer, sources } = await extractAnswer(tab);

    if (!answer) throw new Error('No answer extracted — Perplexity may not have responded');
    const out = short ? answer.slice(0, 300).replace(/\s+\S*$/, '') + '…' : answer;

    const finalUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => '');
    process.stdout.write(JSON.stringify({ query, url: finalUrl, answer: out, sources }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();

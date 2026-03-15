#!/usr/bin/env node
// extractors/google-ai.mjs
// Navigate Google AI Mode (udm=50), wait for answer, return clean answer + sources.
//
// Usage:
//   node extractors/google-ai.mjs "<query>" [--tab <prefix>]
//
// Output (stdout): JSON { answer, sources, query, url }
// Errors go to stderr only — stdout is always clean JSON for piping.

import { readFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir, homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dismissConsent } from './consent.mjs';
const __dir = dirname(fileURLToPath(import.meta.url));

const CDP = join(homedir(), '.claude', 'skills', 'chrome-cdp', 'scripts', 'cdp.mjs');
const PAGES_CACHE = `${tmpdir().replace(/\\/g, '/')}/cdp-pages.json`;

const STREAM_POLL_INTERVAL = 600;
const STREAM_STABLE_ROUNDS = 3;
const STREAM_TIMEOUT = 45000;
const MIN_ANSWER_LENGTH = 50;

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
  if (tabPrefix) return tabPrefix;

  if (existsSync(PAGES_CACHE)) {
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    const existing = pages.find(p => p.url.includes('google.com'));
    if (existing) return existing.targetId.slice(0, 8);
  }

  const list = await cdp(['list']);
  const firstLine = list.split('\n')[0];
  if (!firstLine) throw new Error('No Chrome tabs found. Is Chrome running with --remote-debugging-port=9222?');
  return firstLine.slice(0, 8);
}

async function waitForStreamComplete(tab) {
  const deadline = Date.now() + STREAM_TIMEOUT;
  let stableCount = 0;
  let lastLen = -1;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, STREAM_POLL_INTERVAL));

    const lenStr = await cdp(['eval', tab,
      `(document.querySelector('.pWvJNd')?.innerText?.length || 0) + ''`
    ]).catch(() => '0');

    const len = parseInt(lenStr) || 0;

    if (len >= MIN_ANSWER_LENGTH && len === lastLen) {
      stableCount++;
      if (stableCount >= STREAM_STABLE_ROUNDS) return len;
    } else {
      stableCount = 0;
      lastLen = len;
    }
  }

  if (lastLen >= MIN_ANSWER_LENGTH) return lastLen;
  throw new Error(`Google AI answer did not stabilise within ${STREAM_TIMEOUT}ms`);
}

async function extractAnswer(tab) {
  const raw = await cdp(['eval', tab, `
    (function() {
      var el = document.querySelector('.pWvJNd');
      if (!el) return JSON.stringify({ answer: '', sources: [] });
      var answer = el.innerText.trim();
      var sources = Array.from(document.querySelectorAll('a[href^="http"]'))
        .filter(a => !a.href.includes('google.') && !a.href.includes('gstatic') && !a.href.includes('googleapis'))
        .map(a => ({ url: a.href.split('#')[0], title: (a.closest('[data-snhf]')?.querySelector('h3, [role=heading]')?.innerText || a.innerText?.trim().split('\\n')[0] || '').slice(0, 100) }))
        .filter(s => s.url && s.url.length > 10)
        .filter((v, i, arr) => arr.findIndex(x => x.url === v.url) === i)
        .slice(0, 10);
      return JSON.stringify({ answer, sources });
    })()
  `]);
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') {
    process.stderr.write('Usage: node extractors/google-ai.mjs "<query>" [--tab <prefix>]\n');
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

    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&udm=50`;
    await cdp(['nav', tab, url], 35000);
    await new Promise(r => setTimeout(r, 1500));
    await dismissConsent(tab, cdp);

    // If consent redirected us away, navigate back
    const currentUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => '');
    if (!currentUrl.includes('google.com/search')) {
      await cdp(['nav', tab, url], 35000);
      await new Promise(r => setTimeout(r, 1500));
    }

    await waitForStreamComplete(tab);

    const { answer, sources } = await extractAnswer(tab);
    if (!answer) throw new Error('No answer extracted — Google AI Mode may not have responded');
    const out = short ? answer.slice(0, 300).replace(/\s+\S*$/, '') + '…' : answer;

    const finalUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => url);
    process.stdout.write(JSON.stringify({ query, url: finalUrl, answer: out, sources }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();

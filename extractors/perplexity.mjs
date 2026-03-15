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

const STREAM_POLL_INTERVAL = 600;  // ms between length checks
const STREAM_STABLE_ROUNDS = 3;    // consecutive equal-length polls = done
const STREAM_TIMEOUT = 30000;      // bail out after 30s regardless
const MIN_ANSWER_LENGTH = 50;      // don't accept trivial answers

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

async function waitForStreamComplete(tab) {
  const deadline = Date.now() + STREAM_TIMEOUT;
  let stableCount = 0;
  let lastLen = -1;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, STREAM_POLL_INTERVAL));

    const lenStr = await cdp(['eval', tab,
      `(document.querySelector('.prose')?.innerText?.length || 0) + ''`
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

  // Timeout — return whatever we have if it meets minimum length
  if (lastLen >= MIN_ANSWER_LENGTH) return lastLen;
  throw new Error(`Perplexity answer did not stabilise within ${STREAM_TIMEOUT}ms`);
}

async function extractAnswer(tab) {
  const raw = await cdp(['eval', tab, `
    (function() {
      var prose = document.querySelector('.prose');
      if (!prose) return JSON.stringify({ answer: '', sources: [] });
      var answer = prose.innerText.trim();
      var sources = Array.from(document.querySelectorAll('[data-pplx-citation-url]'))
        .map(el => ({ url: el.getAttribute('data-pplx-citation-url'), title: el.querySelector('a')?.innerText?.trim() || '' }))
        .filter(s => s.url)
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

    await cdp(['click', tab, '#ask-input']);
    await new Promise(r => setTimeout(r, 400));
    await cdp(['type', tab, query]);
    await new Promise(r => setTimeout(r, 400));
    // Submit with Enter (most reliable across Chrome instances)
    await cdp(['eval', tab,
      `document.querySelector('#ask-input')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`
    ]);

    // Wait for streaming answer to complete
    await waitForStreamComplete(tab);

    // Extract
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

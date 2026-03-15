#!/usr/bin/env node
// extractors/stackoverflow-ai.mjs
// Navigate Stack Overflow AI Assist, wait for answer, return clean answer + sources.
//
// Usage:
//   node extractors/stackoverflow-ai.mjs "<query>" [--tab <prefix>]
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

const STREAM_POLL_INTERVAL = 700;
const STREAM_STABLE_ROUNDS = 3;
const STREAM_TIMEOUT = 60000;
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
    const existing = pages.find(p => p.url.includes('stackoverflow.com'));
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

    const lenStr = await cdp(['eval', tab, `
      (function(){
        var msgs = Array.from(document.querySelectorAll('.s-prose.assistantMessage'));
        var last = msgs[msgs.length - 1];
        return (last?.innerText?.length || 0) + '';
      })()
    `]).catch(() => '0');

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
  throw new Error(`Stack Overflow AI answer did not stabilise within ${STREAM_TIMEOUT}ms`);
}

async function extractAnswer(tab) {
  const raw = await cdp(['eval', tab, `
    (function() {
      var msgs = Array.from(document.querySelectorAll('.s-prose.assistantMessage'));
      var el = msgs[msgs.length - 1];
      if (!el) return JSON.stringify({ answer: '', sources: [] });
      var answer = el.innerText.trim();
      // Source cards appear as sibling elements with links to SO questions/docs
      var sources = Array.from(document.querySelectorAll('.d-flex.g16.px2 a[href], .s-card a[href]'))
        .map(a => ({ url: a.href, title: a.innerText?.trim().split('\\n')[0]?.slice(0, 100) || '' }))
        .filter(s => s.url && s.url.startsWith('http'))
        .filter(s => !s.url.includes('/users/') && !s.url.includes('/questions/ask'))
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
    process.stderr.write('Usage: node extractors/stackoverflow-ai.mjs "<query>" [--tab <prefix>]\n');
    process.exit(1);
  }

  const tabFlagIdx = args.indexOf('--tab');
  const tabPrefix = tabFlagIdx !== -1 ? args[tabFlagIdx + 1] : null;
  const query = tabFlagIdx !== -1
    ? args.filter((_, i) => i !== tabFlagIdx && i !== tabFlagIdx + 1).join(' ')
    : args.join(' ');

  try {
    await cdp(['list']);
    const tab = await getOrOpenTab(tabPrefix);

    await cdp(['nav', tab, 'https://stackoverflow.com/ai-assist'], 35000);
    await dismissConsent(tab, cdp);

    // Wait for React app to mount the textarea (up to 8s)
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await cdp(['eval', tab, `!!document.querySelector('textarea.s-textarea')`]).catch(() => 'false');
      if (found === 'true') break;
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 800)); // extra settle time for SO's React app

    // Set value and submit in one eval — prevents React re-render clearing the value between calls
    await cdp(['eval', tab, `
      (function(){
        var ta = document.querySelector('textarea.s-textarea');
        if (!ta) return;
        ta.focus();
        var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, ${JSON.stringify(query)});
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        // Submit immediately before React can re-render and clear the field
        ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 13 }));
      })()
    `]);

    await waitForStreamComplete(tab);

    const { answer, sources } = await extractAnswer(tab);
    if (!answer) throw new Error('No answer extracted — Stack Overflow AI may not have responded');

    const finalUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => '');
    process.stdout.write(JSON.stringify({ query, url: finalUrl, answer, sources }, null, 2) + '\n');
  } catch (e) {
    process.stderr.write(`Error: ${e.message}\n`);
    process.exit(1);
  }
}

main();

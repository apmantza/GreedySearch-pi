#!/usr/bin/env node
// coding-task.mjs — delegate a coding task to Gemini or Copilot via browser CDP
//
// Usage:
//   node coding-task.mjs "<task>" --engine gemini|copilot [--tab <prefix>]
//   node coding-task.mjs "<task>" --engine gemini --context "<code snippet>"
//   node coding-task.mjs all "<task>"   — run both engines in parallel
//
// Output (stdout): JSON { engine, task, code: [{language, code}], explanation, raw }
// Errors go to stderr only.

import { spawn } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { dismissConsent, handleVerification } from './extractors/consent.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, 'cdp.mjs');
const PAGES_CACHE = `${tmpdir().replace(/\\/g, '/')}/cdp-pages.json`;

// Mode system prompts — prepended to the user's task
const MODE_PROMPTS = {
  code: null,  // no preamble — default behaviour
  review: `You are a senior software engineer doing a thorough code review. Analyse the code below for: correctness and edge cases, security issues, performance problems, readability and naming, missing error handling, and anything that would not survive a production incident. Be specific — cite line-level issues where relevant. Suggest concrete fixes, not vague advice.`,
  plan: `You are a senior software architect. The user will describe something they want to build and their current plan. Your job is to: (1) identify risks, gaps, and hidden assumptions in the plan, (2) flag anything that will cause pain later (scaling, ops, security, maintainability), (3) suggest better alternatives where the plan is suboptimal, (4) call out what's missing entirely. Be direct and opinionated — the goal is to find problems before they're built.`,
  test: `You are a senior engineer writing tests for code written by someone else. Your goal is to find what they missed. Write a comprehensive test suite that covers: edge cases the author likely didn't think of, boundary conditions (empty input, nulls, max values, type coercion), error paths and exception handling, concurrency or ordering issues if relevant, and any behaviour that differs from what the function name implies. Use the same language and testing framework as the code if apparent, otherwise default to the most common one for that language. Output runnable test code — not a list of what to test.`,
  debug: `You are a senior engineer debugging someone else's code. You have fresh eyes — no prior assumptions about what should work. Given the bug description and relevant code: (1) identify the most likely root cause, being specific about the exact line or condition, (2) explain why it manifests the way it does, (3) suggest the minimal fix, (4) flag any other latent bugs you notice while reading. Do not guess vaguely — reason from the code. If you need information that isn't provided, say exactly what you'd add to narrow it down.`,
};

const STREAM_POLL_INTERVAL = 800;
const STREAM_STABLE_ROUNDS = 4;
const STREAM_TIMEOUT = 120000;  // coding tasks take longer
const MIN_RESPONSE_LENGTH = 50;

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

async function getAnyTab() {
  const list = await cdp(['list']);
  return list.split('\n')[0].slice(0, 8);
}

async function openNewTab() {
  const anchor = await getAnyTab();
  const raw = await cdp(['evalraw', anchor, 'Target.createTarget', '{"url":"about:blank"}']);
  return JSON.parse(raw).targetId;
}

// ---------------------------------------------------------------------------
// Engine implementations

const ENGINES = {
  gemini: {
    url: 'https://gemini.google.com/app',
    domain: 'gemini.google.com',

    async type(tab, text) {
      await cdp(['eval', tab, `
        (function(t) {
          var el = document.querySelector('rich-textarea .ql-editor');
          el.focus();
          document.execCommand('insertText', false, t);
        })(${JSON.stringify(text)})
      `]);
    },

    async send(tab) {
      await cdp(['eval', tab, `document.querySelector('button[aria-label*="Send"]')?.click()`]);
    },

    async waitReady(tab) {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const ok = await cdp(['eval', tab, `!!document.querySelector('rich-textarea .ql-editor')`]).catch(() => 'false');
        if (ok === 'true') return;
        await new Promise(r => setTimeout(r, 400));
      }
      throw new Error('Gemini input never appeared');
    },

    async waitStream(tab) {
      const deadline = Date.now() + STREAM_TIMEOUT;
      let started = false, stableCount = 0, lastLen = -1;

      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, STREAM_POLL_INTERVAL));
        const stopVisible = await cdp(['eval', tab, `!!document.querySelector('button[aria-label*="Stop"]')`]).catch(() => 'false');
        if (stopVisible === 'true') { started = true; }

        // Use p/li/h* — reliable even when message-content has aria-busy="true"
        const lenStr = await cdp(['eval', tab,
          `(function(){var els=document.querySelectorAll('model-response p,model-response li,model-response h1,model-response h2,model-response h3');return Array.from(els).reduce(function(a,e){return a+(e.innerText?.length||0)},0)+''})()`,
        ]).catch(() => '0');
        const len = parseInt(lenStr) || 0;
        if (len >= 10) started = true;
        if (!started) continue;
        if (len >= 10 && len === lastLen && stopVisible === 'false') {
          if (++stableCount >= STREAM_STABLE_ROUNDS) return;
        } else { stableCount = 0; lastLen = len; }
      }
      if (lastLen >= 10) return;
      throw new Error('Gemini response did not stabilise');
    },

    async extract(tab) {
      return cdp(['eval', tab, `
        (function(){
          var UI_LABELS = /^(Gemini said|Query successful|Show code|Analysis|Hide code|Run code|View code)$/i;
          var els = document.querySelectorAll('model-response p,model-response li,model-response h1,model-response h2,model-response h3');
          return Array.from(els).map(function(e){return e.innerText?.trim()}).filter(function(t){return t && !UI_LABELS.test(t)}).join('\\n') || '';
        })()
      `]);
    },
  },

  copilot: {
    url: 'https://copilot.microsoft.com/',
    domain: 'copilot.microsoft.com',

    async type(tab, text) {
      await cdp(['click', tab, '#userInput']);
      await new Promise(r => setTimeout(r, 300));
      await cdp(['type', tab, text]);
    },

    async send(tab) {
      await cdp(['eval', tab,
        `document.querySelector('#userInput')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,keyCode:13})), 'ok'`
      ]);
    },

    async waitReady(tab) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const ok = await cdp(['eval', tab, `!!document.querySelector('#userInput')`]).catch(() => 'false');
        if (ok === 'true') return;
        await new Promise(r => setTimeout(r, 400));
      }
      throw new Error('Copilot input never appeared');
    },

    async waitStream(tab) {
      const deadline = Date.now() + STREAM_TIMEOUT;
      let stableCount = 0, lastLen = -1;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, STREAM_POLL_INTERVAL));
        const lenStr = await cdp(['eval', tab, `
          (function(){
            var items = Array.from(document.querySelectorAll('[class*="ai-message-item"]'));
            var filled = items.filter(el => (el.innerText?.length||0) > 0);
            var last = filled[filled.length-1];
            return (last?.innerText?.length||0)+'';
          })()`
        ]).catch(() => '0');
        const len = parseInt(lenStr) || 0;
        if (len >= MIN_RESPONSE_LENGTH && len === lastLen) {
          if (++stableCount >= STREAM_STABLE_ROUNDS) return;
        } else { stableCount = 0; lastLen = len; }
      }
      if (lastLen >= MIN_RESPONSE_LENGTH) return;
      throw new Error('Copilot response did not stabilise');
    },

    async extract(tab) {
      return cdp(['eval', tab, `
        (function(){
          var items = Array.from(document.querySelectorAll('[class*="ai-message-item"]'));
          var last = items.filter(e=>(e.innerText?.length||0)>0).pop();
          return last?.innerText?.trim()||'';
        })()
      `]);
    },
  },
};

// ---------------------------------------------------------------------------

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ language: match[1] || 'text', code: match[2].trim() });
  }
  // If no fenced blocks, look for indented blocks as fallback
  if (blocks.length === 0) {
    const lines = text.split('\n');
    const indented = lines.filter(l => l.startsWith('    ')).map(l => l.slice(4));
    if (indented.length > 3) blocks.push({ language: 'text', code: indented.join('\n') });
  }
  return blocks;
}

function extractExplanation(text, codeBlocks) {
  // Remove code blocks from text to get the explanation
  let explanation = text.replace(/```[\s\S]*?```/g, '').trim();
  explanation = explanation.replace(/\n{3,}/g, '\n\n').trim();
  return explanation.slice(0, 1000);  // cap explanation at 1000 chars
}

async function runEngine(engineName, task, context, mode, tabPrefix) {
  const engine = ENGINES[engineName];
  if (!engine) throw new Error(`Unknown engine: ${engineName}`);

  // Find or open a tab
  let tab = tabPrefix;
  if (!tab) {
    if (existsSync(PAGES_CACHE)) {
      const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      const existing = pages.find(p => p.url.includes(engine.domain));
      if (existing) tab = existing.targetId.slice(0, 8);
    }
    if (!tab) tab = await openNewTab();
  }

  // Navigate to fresh conversation — fall back to new tab if cached tab is stale
  try {
    await cdp(['nav', tab, engine.url], 35000);
  } catch (e) {
    if (e.message.includes('No target matching')) {
      tab = await openNewTab();
      await cdp(['nav', tab, engine.url], 35000);
    } else throw e;
  }
  await new Promise(r => setTimeout(r, 2000));
  await dismissConsent(tab, cdp);
  await handleVerification(tab, cdp, 60000);
  await engine.waitReady(tab);
  await new Promise(r => setTimeout(r, 300));

  // Build the prompt
  const preamble = MODE_PROMPTS[mode] || null;
  const body = context
    ? `${task}\n\nHere is the relevant code/context:\n\`\`\`\n${context}\n\`\`\``
    : task;
  const prompt = preamble ? `${preamble}\n\n---\n\n${body}` : body;

  await engine.type(tab, prompt);
  await new Promise(r => setTimeout(r, 400));
  await engine.send(tab);
  await engine.waitStream(tab);

  const raw = await engine.extract(tab);
  if (!raw) throw new Error(`No response from ${engineName}`);

  const code = extractCodeBlocks(raw);
  const explanation = extractExplanation(raw, code);
  const url = await cdp(['eval', tab, 'document.location.href']).catch(() => engine.url);

  return { engine: engineName, task, code, explanation, raw, url };
}

// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args[0] === '--help') {
    process.stderr.write([
      'Usage: node coding-task.mjs "<task>" --engine gemini|copilot|all [--mode code|review|plan]',
      '       node coding-task.mjs "<task>" --engine gemini --context "<code>"',
      '',
      'Modes:',
      '  code   (default) — write or modify code',
      '  review — senior engineer code review: correctness, security, performance',
      '  plan   — architect review: risks, gaps, alternatives for a build plan',
      '  test   — write tests an author would miss: edge cases, error paths, boundary conditions',
      '  debug  — fresh-eyes root cause analysis: exact line, why it manifests, minimal fix',
      '',
      'Examples:',
      '  node coding-task.mjs "write a debounce function in JS" --engine gemini',
      '  node coding-task.mjs "review this module" --mode review --engine all --file src/myfile.mjs',
      '  node coding-task.mjs "debug this" --mode debug --engine all --file a.mjs --file b.mjs',
      '  node coding-task.mjs "I want to build X, here is my plan: ..." --mode plan --engine all',
    ].join('\n') + '\n');
    process.exit(1);
  }

  const engineFlagIdx = args.indexOf('--engine');
  const engineArg = engineFlagIdx !== -1 ? args[engineFlagIdx + 1] : 'gemini';
  const contextFlagIdx = args.indexOf('--context');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 ? args[outIdx + 1] : null;
  const tabFlagIdx = args.indexOf('--tab');
  const tabPrefix = tabFlagIdx !== -1 ? args[tabFlagIdx + 1] : null;
  const modeFlagIdx = args.indexOf('--mode');
  const mode = modeFlagIdx !== -1 ? args[modeFlagIdx + 1] : 'code';

  if (!MODE_PROMPTS.hasOwnProperty(mode)) {
    process.stderr.write(`Error: unknown mode "${mode}". Use: code, review, plan, test, debug\n`);
    process.exit(1);
  }

  // --file can be repeated: --file a.mjs --file b.mjs
  const fileIndices = [];
  const filePaths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && args[i + 1]) {
      fileIndices.push(i, i + 1);
      filePaths.push(args[i + 1]);
    }
  }
  const fileContext = filePaths.length > 0
    ? filePaths.map(p => `// FILE: ${p}\n${readFileSync(p, 'utf8')}`).join('\n\n')
    : null;
  const context = fileContext || (contextFlagIdx !== -1 ? args[contextFlagIdx + 1] : null);

  const skipFlags = new Set([
    ...(engineFlagIdx  >= 0 ? [engineFlagIdx,  engineFlagIdx  + 1] : []),
    ...(contextFlagIdx >= 0 ? [contextFlagIdx, contextFlagIdx + 1] : []),
    ...(outIdx         >= 0 ? [outIdx,         outIdx         + 1] : []),
    ...(tabFlagIdx     >= 0 ? [tabFlagIdx,     tabFlagIdx     + 1] : []),
    ...(modeFlagIdx    >= 0 ? [modeFlagIdx,    modeFlagIdx    + 1] : []),
    ...fileIndices,
  ]);
  const task = args.filter((_, i) => !skipFlags.has(i)).join(' ');

  if (!task) {
    process.stderr.write('Error: no task provided\n');
    process.exit(1);
  }

  await cdp(['list']);  // ensure Chrome is reachable

  let result;

  if (engineArg === 'all') {
    const results = await Promise.allSettled(
      Object.keys(ENGINES).map(e => runEngine(e, task, context, mode, null))
    );
    result = {};
    for (const [i, r] of results.entries()) {
      const name = Object.keys(ENGINES)[i];
      result[name] = r.status === 'fulfilled' ? r.value : { engine: name, error: r.reason?.message };
    }
  } else {
    try {
      result = await runEngine(engineArg, task, context, mode, tabPrefix);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
  }

  const json = JSON.stringify(result, null, 2) + '\n';
  if (outFile) {
    writeFileSync(outFile, json, 'utf8');
    process.stderr.write(`Results written to ${outFile}\n`);
  } else {
    process.stdout.write(json);
  }
}

main();

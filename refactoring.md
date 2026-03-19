# GreedySearch-pi Refactoring Recommendations

A comprehensive guide to improving code quality, maintainability, and reliability based on a thorough codebase review.

---

## Table of Contents

1. [Critical Fixes](#critical-fixes)
2. [Code Deduplication](#code-deduplication)
3. [Dead Code Cleanup](#dead-code-cleanup)
4. [Extension Improvements](#extension-improvements)
5. [Extractor Architecture](#extractor-architecture)
6. [Reliability & Error Handling](#reliability--error-handling)
7. [Performance Optimizations](#performance-optimizations)
8. [Documentation](#documentation)
9. [Security & Robustness](#security--robustness)
10. [Future Enhancements](#future-enhancements)

---

## Critical Fixes

### 1.1 Hardcoded CDP Path — Use Local Implementation

**Problem:** Every extractor and `search.mjs` hardcodes the CDP path to `~/.claude/skills/chrome-cdp/scripts/cdp.mjs`:

```javascript
// extractors/perplexity.mjs (and all other extractors)
const CDP = join(homedir(), '.claude', 'skills', 'chrome-cdp', 'scripts', 'cdp.mjs');

// search.mjs
const CDP = join(homedir(), '.claude', 'skills', 'chrome-cdp', 'scripts', 'cdp.mjs');
```

**Why it's a problem:**
- The package ships its own `cdp.mjs` but doesn't use it
- Users who don't have the chrome-cdp skill installed will get errors
- Path is fragile — breaks if chrome-cdp skill moves or is uninstalled

**Solution:** Use relative path to the local `cdp.mjs`:

```javascript
// In extractors/ — go up one level to find cdp.mjs
const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, '..', 'cdp.mjs');

// In search.mjs
const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, 'cdp.mjs');
```

**Files affected:**
- `search.mjs`
- `extractors/perplexity.mjs`
- `extractors/bing-copilot.mjs`
- `extractors/google-ai.mjs`
- `extractors/gemini.mjs`
- `extractors/mistral.mjs`
- `extractors/stackoverflow-ai.mjs`

---

## Code Deduplication

### 2.1 Extract Shared CDP Wrapper

**Problem:** The `cdp()` function is copy-pasted identically in 7 files:

```javascript
// Identical in search.mjs and all extractors
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
```

**Solution:** Create a shared module `lib/cdp-client.mjs`:

```javascript
// lib/cdp-client.mjs
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const CDP = join(__dir, '..', 'cdp.mjs');

/**
 * Execute a CDP command by spawning the cdp.mjs CLI.
 * @param {string[]} args - CDP command arguments
 * @param {number} [timeoutMs=30000] - Timeout in milliseconds
 * @returns {Promise<string>} stdout output
 */
export function cdp(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CDP, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    const timer = setTimeout(() => { 
      proc.kill(); 
      reject(new Error(`cdp timeout: ${args[0]}`)); 
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(err.trim() || `cdp exit ${code}`));
      else resolve(out.trim());
    });
  });
}

export default cdp;
```

Then in each extractor:
```javascript
import { cdp } from '../lib/cdp-client.mjs';
```

---

### 2.2 Extract Shared Clipboard Interceptor

**Problem:** Clipboard interceptor code is duplicated in 4 extractors with only the variable name changed:

```javascript
// perplexity.mjs
window.__pplxClipboard = null;
// bing-copilot.mjs
window.__bingClipboard = null;
// gemini.mjs
window.__geminiClipboard = null;
// mistral.mjs
window.__mistralClipboard = null;
```

**Solution:** Create `lib/clipboard-interceptor.mjs`:

```javascript
// lib/clipboard-interceptor.mjs

/**
 * Returns JavaScript to inject that intercepts clipboard writes.
 * Call this via cdp(['eval', tab, getClipboardInterceptorJS('myVar')]).
 * 
 * @param {string} [varName='__greedySearchClipboard'] - Global variable name to store clipboard content
 * @returns {string} JavaScript code to inject
 */
export function getClipboardInterceptorJS(varName = '__greedySearchClipboard') {
  return `
    (function() {
      if (window.${varName} !== undefined) return 'already-injected';
      
      window.${varName} = null;
      
      const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function(text) {
        window.${varName} = text;
        return _origWriteText(text);
      };
      
      const _origWrite = navigator.clipboard.write.bind(navigator.clipboard);
      navigator.clipboard.write = async function(items) {
        try {
          for (const item of items) {
            if (item.types && item.types.includes('text/plain')) {
              const blob = await item.getType('text/plain');
              window.${varName} = await blob.text();
              break;
            }
          }
        } catch(e) {}
        return _origWrite(items);
      };
      
      return 'injected';
    })()
  `;
}

/**
 * Read intercepted clipboard content.
 * @param {string} [varName='__greedySearchClipboard']
 * @returns {string} JavaScript expression to read clipboard
 */
export function getClipboardReadJS(varName = '__greedySearchClipboard') {
  return `window.${varName} || ''`;
}

/**
 * Full injection + extraction helper.
 * @param {Object} params
 * @param {string} params.tab - Target tab ID
 * @param {Function} params.cdp - CDP function
 * @param {string} [params.varName] - Custom variable name
 * @returns {Promise<void>}
 */
export async function injectClipboardInterceptor({ tab, cdp, varName = '__greedySearchClipboard' }) {
  await cdp(['eval', tab, getClipboardInterceptorJS(varName)]);
}

/**
 * Read intercepted clipboard content from page.
 * @param {Object} params
 * @param {string} params.tab - Target tab ID
 * @param {Function} params.cdp - CDP function
 * @param {string} [params.varName] - Custom variable name
 * @returns {Promise<string>}
 */
export async function readClipboard({ tab, cdp, varName = '__greedySearchClipboard' }) {
  return await cdp(['eval', tab, getClipboardReadJS(varName)]);
}
```

---

### 2.3 Extract Shared Argument Parser

**Problem:** Every extractor has identical arg parsing logic:

```javascript
const short = args.includes('--short');
const rest = args.filter(a => a !== '--short');
const tabFlagIdx = rest.indexOf('--tab');
const tabPrefix = tabFlagIdx !== -1 ? rest[tabFlagIdx + 1] : null;
const query = tabFlagIdx !== -1
  ? rest.filter((_, i) => i !== tabFlagIdx && i !== tabFlagIdx + 1).join(' ')
  : rest.join(' ');
```

**Solution:** Create `lib/extractor-args.mjs`:

```javascript
// lib/extractor-args.mjs

/**
 * Parse common extractor CLI arguments.
 * @param {string[]} args - process.argv.slice(2)
 * @returns {{ query: string, short: boolean, tabPrefix: string | null }}
 */
export function parseExtractorArgs(args) {
  if (!args.length || args[0] === '--help') {
    return null; // Signal to show usage
  }

  const short = args.includes('--short');
  const rest = args.filter(a => a !== '--short');
  const tabFlagIdx = rest.indexOf('--tab');
  const tabPrefix = tabFlagIdx !== -1 ? rest[tabFlagIdx + 1] : null;
  const query = tabFlagIdx !== -1
    ? rest.filter((_, i) => i !== tabFlagIdx && i !== tabFlagIdx + 1).join(' ')
    : rest.join(' ');

  return { query, short, tabPrefix };
}

/**
 * Truncate answer for short mode.
 * @param {string} answer
 * @param {number} [maxLen=300]
 * @returns {string}
 */
export function truncateAnswer(answer, maxLen = 300) {
  return answer.slice(0, maxLen).replace(/\s+\S*$/, '') + '…';
}
```

---

### 2.4 Extract Tab Management Logic

**Problem:** `getOrOpenTab()` is duplicated in every extractor with slight variations:

```javascript
// All extractors have this pattern
async function getOrOpenTab(tabPrefix) {
  if (tabPrefix) return tabPrefix;
  if (existsSync(PAGES_CACHE)) {
    const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
    const existing = pages.find(p => p.url.includes('perplexity.ai')); // varies
    if (existing) return existing.targetId.slice(0, 8);
  }
  const list = await cdp(['list']);
  const firstLine = list.split('\n')[0];
  if (!firstLine) throw new Error('No Chrome tabs found...');
  return firstLine.slice(0, 8);
}
```

**Solution:** Create `lib/tab-manager.mjs`:

```javascript
// lib/tab-manager.mjs
import { readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { cdp } from './cdp-client.mjs';

const PAGES_CACHE = `${tmpdir().replace(/\\/g, '/')}/cdp-pages.json`;

/**
 * Find an existing tab by URL pattern, or fall back to first available tab.
 * @param {Object} params
 * @param {string} [params.tabPrefix] - Explicit tab prefix to use
 * @param {string} params.urlPattern - URL pattern to match (e.g., 'perplexity.ai')
 * @param {string} params.engineName - Name for error messages
 * @returns {Promise<string>} Tab target ID prefix
 */
export async function getOrOpenTab({ tabPrefix, urlPattern, engineName }) {
  if (tabPrefix) return tabPrefix;

  if (existsSync(PAGES_CACHE)) {
    try {
      const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      const existing = pages.find(p => p.url.includes(urlPattern));
      if (existing) return existing.targetId.slice(0, 8);
    } catch { /* cache corrupted, continue */ }
  }

  await cdp(['list']);
  
  // Re-read after refresh
  if (existsSync(PAGES_CACHE)) {
    try {
      const pages = JSON.parse(readFileSync(PAGES_CACHE, 'utf8'));
      const existing = pages.find(p => p.url.includes(urlPattern));
      if (existing) return existing.targetId.slice(0, 8);
    } catch { /* continue */ }
  }

  const list = await cdp(['list']);
  const firstLine = list.split('\n')[0];
  if (!firstLine) {
    throw new Error(`No Chrome tabs found. Is Chrome running with --remote-debugging-port=9222?`);
  }
  return firstLine.slice(0, 8);
}
```

---

### 2.5 Create Base Extractor Class (Optional, Higher Effort)

For maximum deduplication, consider a base extractor:

```javascript
// lib/base-extractor.mjs
import { cdp } from './cdp-client.mjs';
import { injectClipboardInterceptor, readClipboard } from './clipboard-interceptor.mjs';
import { parseExtractorArgs, truncateAnswer } from './extractor-args.mjs';
import { getOrOpenTab } from './tab-manager.mjs';

export class BaseExtractor {
  /** @type {string} URL pattern to match for tab reuse */
  static urlPattern = '';
  /** @type {string} Engine name for error messages */
  static engineName = '';
  /** @type {string} Homepage URL to navigate to */
  static homepageUrl = '';
  /** @type {string} CSS selector for the input element */
  static inputSelector = '';
  /** @type {string} CSS selector for the copy button */
  static copySelector = 'button[aria-label="Copy"]';
  /** @type {number} Timeout for copy button to appear (ms) */
  static copyTimeout = 60000;

  /**
   * Main entry point — call this from main()
   */
  static async run(args) {
    const parsed = parseExtractorArgs(args);
    if (!parsed) {
      this.showUsage();
      process.exit(1);
    }

    const { query, short, tabPrefix } = parsed;

    try {
      await cdp(['list']);
      const tab = await getOrOpenTab({ 
        tabPrefix, 
        urlPattern: this.urlPattern, 
        engineName: this.engineName 
      });

      await this.navigateAndPrepare(tab, query);
      await injectClipboardInterceptor({ tab, cdp });
      await this.submitQuery(tab, query);
      await this.waitForCompletion(tab);

      const answer = await this.extractAnswer(tab);
      if (!answer) throw new Error(`No answer extracted from ${this.engineName}`);
      
      const out = short ? truncateAnswer(answer) : answer;
      const finalUrl = await cdp(['eval', tab, 'document.location.href']).catch(() => this.homepageUrl);

      process.stdout.write(JSON.stringify({ 
        query, 
        url: finalUrl, 
        answer: out, 
        sources: await this.extractSources(tab) 
      }, null, 2) + '\n');
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
      process.exit(1);
    }
  }

  static showUsage() {
    process.stderr.write(`Usage: node ${this.name}.mjs "<query>" [--tab <prefix>] [--short]\n`);
  }

  // Override these in subclasses:
  static async navigateAndPrepare(tab, query) { /* default: navigate to homepage */ }
  static async submitQuery(tab, query) { /* default: click input, type, press Enter */ }
  static async waitForCompletion(tab) { /* default: wait for copy button */ }
  static async extractAnswer(tab) { return readClipboard({ tab, cdp }); }
  static async extractSources(tab) { return []; }
}
```

Then each extractor becomes ~50 lines instead of ~150:

```javascript
// extractors/perplexity.mjs
import { BaseExtractor } from '../lib/base-extractor.mjs';

class PerplexityExtractor extends BaseExtractor {
  static urlPattern = 'perplexity.ai';
  static engineName = 'Perplexity';
  static homepageUrl = 'https://www.perplexity.ai/';
  static inputSelector = '#ask-input';

  static async navigateAndPrepare(tab, query) {
    await cdp(['nav', tab, this.homepageUrl], 35000);
    await new Promise(r => setTimeout(r, 2000));
    await dismissConsent(tab, cdp);
    
    // Wait for React app to mount input
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const found = await cdp(['eval', tab, `!!document.querySelector('${this.inputSelector}')`]).catch(() => 'false');
      if (found === 'true') break;
      await new Promise(r => setTimeout(r, 400));
    }
    await new Promise(r => setTimeout(r, 300));
  }

  static async submitQuery(tab, query) {
    await cdp(['click', tab, this.inputSelector]);
    await new Promise(r => setTimeout(r, 400));
    await cdp(['type', tab, query]);
    await new Promise(r => setTimeout(r, 400));
    await cdp(['eval', tab, `
      document.querySelector('${this.inputSelector}')?.dispatchEvent(
        new KeyboardEvent('keydown', {key:'Enter', bubbles:true, keyCode:13})
      ), 'ok'
    `]);
  }

  static async waitForCompletion(tab) {
    const deadline = Date.now() + this.copyTimeout;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 600));
      const found = await cdp(['eval', tab, 
        `!!document.querySelector('button[aria-label="Copy"]')`
      ]).catch(() => 'false');
      if (found === 'true') return;
    }
    throw new Error(`Perplexity copy button did not appear within ${this.copyTimeout}ms`);
  }

  static async extractSources(tab) {
    const raw = await cdp(['eval', tab, `
      (function() {
        return JSON.stringify(Array.from(document.querySelectorAll('[data-pplx-citation-url]'))
          .map(el => ({ url: el.getAttribute('data-pplx-citation-url'), title: el.querySelector('a')?.innerText?.trim() || '' }))
          .filter(s => s.url)
          .filter((v, i, arr) => arr.findIndex(x => x.url === v.url) === i)
          .slice(0, 10));
      })()
    `]).catch(() => '[]');
    return JSON.parse(raw);
  }
}

PerplexityExtractor.run(process.argv.slice(2));
```

---

## Dead Code Cleanup

### 3.1 Wire Up or Remove Mistral

**Problem:** `extractors/mistral.mjs` exists but is not connected:

```javascript
// search.mjs
const ENGINES = {
  perplexity: 'perplexity.mjs',
  bing: 'bing-copilot.mjs',
  google: 'google-ai.mjs',
  stackoverflow: 'stackoverflow-ai.mjs',
  // NO MISTRAL
};

const ALL_ENGINES = ['perplexity', 'bing', 'google']; // NO MISTRAL
```

**Options:**

**Option A — Wire it up:**
```javascript
const ENGINES = {
  perplexity: 'perplexity.mjs',
  pplx: 'perplexity.mjs',
  p: 'perplexity.mjs',
  bing: 'bing-copilot.mjs',
  copilot: 'bing-copilot.mjs',
  b: 'bing-copilot.mjs',
  google: 'google-ai.mjs',
  g: 'google-ai.mjs',
  mistral: 'mistral.mjs',
  m: 'mistral.mjs',
  // stackoverflow: 'stackoverflow-ai.mjs', // still disabled
};
```

Update `index.ts` tool parameters:
```javascript
engine: Type.Union([
  Type.Literal("all"),
  Type.Literal("perplexity"),
  Type.Literal("bing"),
  Type.Literal("google"),
  Type.Literal("mistral"),
])
```

Update README and SKILL.md.

**Option B — Remove it:**
```bash
rm extractors/mistral.mjs
```

---

### 3.2 Clean Up StackOverflow References

**Problem:** StackOverflow is in `ENGINES` but commented out in `ALL_ENGINES`:

```javascript
// search.mjs
const ALL_ENGINES = ['perplexity', 'bing', 'google']; // stackoverflow: disabled until polling fix
```

**Solution:** Either fix the polling issue or remove it entirely:

```javascript
// If keeping:
const ALL_ENGINES = ['perplexity', 'bing', 'google', 'stackoverflow'];

// If removing:
// 1. Remove from ENGINES map
// 2. Delete extractors/stackoverflow-ai.mjs
// 3. Update README
```

---

### 3.3 Remove Redundant Engine Aliases

**Problem:** The README documents:
- `perplexity` / `pplx` / `p`
- `bing` / `copilot` / `b`
- `google` / `g`
- `gemini` / `gem`

But the extension only exposes 6 literals, and the README only mentions `perplexity`, `bing`, `google`, and `all`.

**Solution:** Align the extension schema with what's actually documented:

```javascript
// Either add all aliases to the schema:
engine: Type.Union([
  Type.Literal("all"),
  Type.Literal("perplexity"), Type.Literal("p"),
  Type.Literal("bing"), Type.Literal("b"),
  Type.Literal("google"), Type.Literal("g"),
  Type.Literal("gemini"), Type.Literal("gem"),
  Type.Literal("mistral"), Type.Literal("m"),  // if wired up
]),

// Or remove unused aliases from search.mjs ENGINES map
```

---

## Extension Improvements

### 4.1 Fix TypeScript Type Assertions

**Problem:** Hacky `as` casts in `index.ts`:

```typescript
return {
  content: [{ type: "text", text: text || "No results returned." }],
  details: { raw: data } as { raw?: Record<string, unknown> },
};
```

**Solution:** Define proper types:

```typescript
interface GreedySearchResult {
  raw?: Record<string, unknown>;
}

// Or just use the SDK's expected type directly:
return {
  content: [{ type: "text", text: text || "No results returned." }],
  details: { raw: data } as GreedySearchResult,
};

// Or if the SDK doesn't care about the shape:
return {
  content: [{ type: "text", text: text || "No results returned." }],
  details: { raw: data },
};
```

---

### 4.2 Add Streaming Support

**Problem:** The tool waits for the entire search to complete before returning any output. The SDK provides `onUpdate` for streaming.

**Solution:** Stream results as each engine completes:

```typescript
execute: async (_toolCallId, params, onUpdate) => {
  const { query, engine = "all", synthesize = false } = params as { ... };

  if (!cdpAvailable()) {
    return {
      content: [{ type: "text", text: "cdp.mjs missing..." }],
      details: {},
    };
  }

  // For single engine, just run it
  if (engine !== "all") {
    const data = await runSearch(engine, query);
    const text = formatResults(engine, data);
    return {
      content: [{ type: "text", text }],
      details: { raw: data },
    };
  }

  // For "all", stream partial results as engines complete
  const engines = ['perplexity', 'bing', 'google'];
  const results: Record<string, unknown> = {};
  let completedCount = 0;

  const promises = engines.map(async (eng) => {
    try {
      results[eng] = await runSearch(eng, query);
    } catch (e) {
      results[eng] = { error: e instanceof Error ? e.message : String(e) };
    }
    completedCount++;
    
    // Stream update after each engine completes
    onUpdate?.({
      type: "partial_result",
      content: `\n✅ ${eng} completed (${completedCount}/${engines.length})`,
    });
  });

  await Promise.allSettled(promises);

  // Optionally synthesize
  let finalData = results;
  if (synthesize) {
    onUpdate?.({ type: "partial_result", content: "\n🔄 Synthesizing results with Gemini..." });
    finalData = await synthesizeWithGemini(results);
  }

  const text = formatResults("all", finalData);
  return {
    content: [{ type: "text", text }],
    details: { raw: finalData },
  };
}
```

---

### 4.3 Add Input Validation

**Problem:** No validation on query length or engine values.

**Solution:**

```typescript
execute: async (_toolCallId, params) => {
  const { query, engine = "all", synthesize = false } = params as { query: string; engine: string; synthesize?: boolean };

  // Validate query
  if (!query || typeof query !== "string" || query.trim().length === 0) {
    return {
      content: [{ type: "text", text: "Error: query parameter is required and must be a non-empty string." }],
      details: {},
    };
  }

  if (query.length > 1000) {
    return {
      content: [{ type: "text", text: "Error: query too long (max 1000 characters)." }],
      details: {},
    };
  }

  // Validate engine
  const validEngines = ["all", "perplexity", "bing", "google", "gemini", "gem", "mistral", "m"];
  if (!validEngines.includes(engine)) {
    return {
      content: [{ type: "text", text: `Error: invalid engine "${engine}". Valid: ${validEngines.join(", ")}` }],
      details: {},
    };
  }

  // ... rest of execution
}
```

---

### 4.4 Add `numResults` Parameter

**Problem:** The `web_search` built-in tool has `numResults` but your extension doesn't.

**Solution:**

```typescript
parameters: Type.Object({
  query: Type.String({ description: "The search query" }),
  engine: Type.Union([...]),
  synthesize: Type.Optional(Type.Boolean({ ... })),
  numResults: Type.Optional(Type.Number({ 
    description: "Maximum number of sources to return per engine (default: 5)",
    minimum: 1,
    maximum: 20,
    default: 5,
  })),
}),
```

Pass through to extractors:
```javascript
// search.mjs
const numResults = parseInt(process.argv[5]) || 5;
```

Update extractor source extraction to use `numResults` instead of hardcoded `.slice(0, 10)`.

---

## Extractor Architecture

### 5.1 Add Health Check / Connectivity Test

**Problem:** Users don't know if Chrome is properly set up until a search fails.

**Solution:** Add a health check command:

```javascript
// lib/health-check.mjs
import { cdp } from './cdp-client.mjs';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

const CHROME_PORTS = [9222, 9223];

export async function checkChromeHealth() {
  const results = {
    chromeRunning: false,
    port: null,
    cdpResponsive: false,
    errors: [],
  };

  for (const port of CHROME_PORTS) {
    try {
      const response = await fetch(`http://localhost:${port}/json/version`, { 
        signal: AbortSignal.timeout(2000) 
      });
      if (response.ok) {
        results.chromeRunning = true;
        results.port = port;
        results.cdpResponsive = true;
        break;
      }
    } catch {
      results.errors.push(`Port ${port}: not responding`);
    }
  }

  if (!results.chromeRunning) {
    results.errors.push('No Chrome instance found on ports 9222 or 9223');
  }

  // Test list command
  if (results.cdpResponsive) {
    try {
      await cdp(['list'], 5000);
      results.errors.push(null); // Success
    } catch (e) {
      results.errors.push(`CDP list failed: ${e.message}`);
    }
  }

  return results;
}

// CLI usage: node lib/health-check.mjs
if (process.argv[1]?.endsWith('health-check.mjs')) {
  checkChromeHealth().then(result => {
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.cdpResponsive ? 0 : 1);
  });
}
```

---

### 5.2 Add Retry Logic to Extractors

**Problem:** Transient failures (slow page loads, network blips) cause permanent failures.

**Solution:**

```javascript
// lib/retry.mjs

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {Object} [options]
 * @param {number} [options.maxRetries=3]
 * @param {number} [options.baseDelay=1000]
 * @param {number} [options.maxDelay=10000]
 * @param {Function} [options.onRetry] - Called with (attempt, error) before each retry
 * @returns {Promise<*>}
 */
export async function retry(fn, { maxRetries = 3, baseDelay = 1000, maxDelay = 10000, onRetry } = {}) {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
        onRetry?.(attempt + 1, error, delay);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  
  throw lastError;
}

/**
 * Retry with predicate — only retry if error matches condition.
 */
export async function retryIf(fn, shouldRetry, options) {
  return retry(async () => {
    try {
      return await fn();
    } catch (error) {
      if (!shouldRetry(error)) throw error; // Don't retry, rethrow immediately
      throw error;
    }
  }, options);
}
```

Usage in extractors:
```javascript
import { retry } from '../lib/retry.mjs';

await retry(
  () => waitForCopyButton(tab),
  { 
    maxRetries: 2, 
    baseDelay: 2000,
    onRetry: (attempt, err) => {
      console.error(`Copy button not found, retrying (${attempt})...`);
    }
  }
);
```

---

### 5.3 Make Selector Updates Easier

**Problem:** When Perplexity/Bing/Google update their UI, selectors break. Currently scattered across files.

**Solution:** Centralize selectors in a config:

```javascript
// lib/selectors.mjs
export const SELECTORS = {
  perplexity: {
    input: '#ask-input',
    copyButton: 'button[aria-label="Copy"]',
    sources: '[data-pplx-citation-url]',
    sourceLink: 'a',
    consent: '#onetrust-accept-btn-handler',
  },
  bing: {
    input: '#userInput',
    copyButton: 'button[data-testid="copy-ai-message-button"]',
    sources: 'a[href^="http"][target="_blank"]',
    sourceExclude: 'copilot.microsoft.com',
    consent: '#onetrust-accept-btn-handler',
  },
  google: {
    answerContainer: '.pWvJNd',
    sources: 'a[href^="http"]',
    sourceExclude: ['google.', 'gstatic', 'googleapis'],
    consent: '#L2AGLb, button[jsname="b3VHJd"], .tHlp8d',
  },
  gemini: {
    input: 'rich-textarea .ql-editor',
    copyButton: 'button[aria-label="Copy"]',
    sendButton: 'button[aria-label*="Send"]',
    sources: 'a[href^="http"]',
    sourceExclude: ['gemini.google', 'gstatic', 'google.com/search'],
  },
  mistral: {
    input: 'textarea',
    copyButton: 'button[aria-label="Copy to clipboard"]',
    completionSignal: 'button[aria-label="Like"]',
    sendButton: 'button[aria-label="Send question"]',
  },
};
```

---

## Reliability & Error Handling

### 6.1 Add Overall Timeout to search.mjs

**Problem:** If all engines hang, the tool hangs indefinitely until Pi kills it.

**Solution:**

```javascript
// search.mjs — add at top
const OVERALL_TIMEOUT = parseInt(process.env.GREEDYSEARCH_TIMEOUT) || 120000; // 2 minutes default

// In main():
const overallTimeout = new Promise((_, reject) => 
  setTimeout(() => reject(new Error('GreedySearch overall timeout exceeded')), OVERALL_TIMEOUT)
);

try {
  const results = await Promise.race([
    runAllEngines(engines, query),
    overallTimeout,
  ]);
  // ...
} catch (e) {
  if (e.message.includes('timeout')) {
    process.stderr.write(`Error: Search timed out after ${OVERALL_TIMEOUT / 1000}s. Set GREEDYSEARCH_TIMEOUT env var to increase.\n`);
  }
  process.exit(1);
}
```

---

### 6.2 Better Error Messages

**Problem:** Error messages are cryptic:

```javascript
// Current
throw new Error(`cdp timeout: ${args[0]}`);
// Output: "Error: cdp timeout: nav"

// Better
throw new Error(`CDP command "nav" timed out after 30s. Is Chrome responsive? Try: node launch.mjs --status`);
```

---

### 6.3 Graceful Degradation in Synthesis

**Problem:** If Gemini synthesis fails, the whole "all" search fails even though individual results are fine.

**Solution:**

```javascript
if (synthesize && engine === "all") {
  try {
    data = await runSearch('gemini', `Synthesize these search results into one answer:\n\n${JSON.stringify(results)}`);
    data._synthesis = { answer: data.answer, synthesized: true };
    data._sources = deduplicateSources(results);
  } catch (synthError) {
    console.error(`Synthesis failed, returning raw results: ${synthError.message}`);
    // Fall through to standard output formatting
  }
}
```

---

### 6.4 Detect Stale Chrome Session

**Problem:** If Chrome crashes mid-search, errors are confusing.

**Solution:**

```javascript
// lib/cdp-client.mjs — enhance error handling
export function cdp(args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CDP, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    
    proc.stdout.on('data', d => out += d);
    proc.stderr.on('data', d => err += d);
    
    const timer = setTimeout(() => { 
      proc.kill(); 
      reject(new Error(`CDP command "${args[0]}" timed out after ${timeoutMs}ms`)); 
    }, timeoutMs);
    
    proc.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        const errorMsg = err.trim() || `cdp exit ${code}`;
        
        // Detect common Chrome issues
        if (errorMsg.includes('ECONNREFUSED') || errorMsg.includes('WebSocket')) {
          reject(new Error(`${errorMsg}\n\nChrome may have crashed. Try:\n  node launch.mjs --kill\n  node launch.mjs`));
        } else if (errorMsg.includes('Target closed')) {
          reject(new Error(`${errorMsg}\n\nThe Chrome tab was closed. Run "cdp list" to see available tabs.`));
        } else {
          reject(new Error(errorMsg));
        }
      } else {
        resolve(out.trim());
      }
    });
  });
}
```

---

## Performance Optimizations

### 7.1 Cache Chrome Process Check

**Problem:** `launch.mjs` spawns a new process just to check if Chrome is running.

**Solution:** Add fast-path check before spawning:

```javascript
// launch.mjs — add at top of main()
async function isChromeResponsive(port = 9222) {
  try {
    const response = await fetch(`http://localhost:${port}/json/version`, { 
      signal: AbortSignal.timeout(1000) 
    });
    return response.ok;
  } catch {
    return false;
  }
}

// In main(), before spawning:
if (await isChromeResponsive(PORT)) {
  console.log('Chrome already running and responsive.');
  redirectCdpToGreedySearch();
  return;
}
```

---

### 7.2 Reuse CDP Connection in Extractors

**Problem:** Each extractor spawns a new `cdp list` process, then spawns more processes for each command.

**Solution:** For extractors that need multiple CDP calls, consider keeping a CDP connection alive:

```javascript
// This is more relevant if refactoring to use the CDP WebSocket directly
// instead of spawning cdp.mjs for each command
```

Note: This is a larger refactor. The current process-spawning approach is simpler and the overhead is acceptable for the use case.

---

### 7.3 Parallel Tab Warming

**Problem:** First search is slow because tabs need to navigate to homepages.

**Solution:** Pre-warm tabs on extension load:

```javascript
// index.ts
let warmed = false;

export default function greedySearchExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!cdpAvailable()) {
      ctx.ui.notify("GreedySearch: cdp.mjs missing...", "warning");
      return;
    }
    
    // Warm tabs in background (non-blocking)
    if (!warmed) {
      warmed = true;
      spawn("node", [join(__dir, "search.mjs"), "_warm"], { 
        stdio: "ignore",
        detached: true 
      }).unref();
    }
  });
  
  // ...
}

// search.mjs — add warm command
if (process.argv[2] === '_warm') {
  // Pre-navigate tabs to homepages
  const engines = ['perplexity', 'bing', 'google'];
  await Promise.allSettled(
    engines.map(eng => spawnExtractor(eng, '--warmup'))
  );
  process.exit(0);
}
```

---

## Documentation

### 8.1 Update README with Current Feature Set

**Current README gaps:**
- Doesn't mention Mistral (if wired up)
- Doesn't explain `synthesize` well
- Doesn't document the Chrome auto-launch behavior
- Missing troubleshooting section

**Suggested additions:**

```markdown
## Supported Engines

| Engine | Alias | Best For |
|--------|-------|----------|
| `all` | — | Highest confidence (all 3 in parallel) |
| `perplexity` | `p` | Technical Q&A, code explanations |
| `bing` | `b` | Recent news, Microsoft ecosystem |
| `google` | `g` | Broad coverage, multiple perspectives |
| `gemini` | `gem` | Google's AI with latest info |

## Synthesis Mode

When `synthesize: true` is set (with `engine: "all"`):

1. Results from all 3 engines are deduplicated by URL consensus
2. Deduplicated sources are fed to Gemini
3. Gemini produces a single grounded answer

**Trade-offs:**
- ✅ Higher quality, deduplicated answer
- ✅ Fewer tokens to pass to downstream LLMs  
- ❌ ~30s additional latency

## Troubleshooting

### "Chrome not found"
GreedySearch needs Chrome to access AI search interfaces. Install Chrome or set:
```bash
export CHROME_PATH="/path/to/chrome"
```

### "CDP timeout"
Chrome may be unresponsive. Restart GreedySearch Chrome:
```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs --kill
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs
```

### Google "verify you're human"
GreedySearch auto-clicks simple verification buttons. For CAPTCHAs, solve manually in the browser window — GreedySearch waits up to 60s.

### Search hangs
Set a custom timeout:
```bash
export GREEDYSEARCH_TIMEOUT=180000  # 3 minutes
```
```

---

### 8.2 Add JSDoc to All Public Functions

```javascript
/**
 * Run a search on a specific engine.
 * 
 * @param {string} engine - Engine name: 'perplexity', 'bing', 'google', 'gemini', 'mistral', or 'all'
 * @param {string} query - Search query string
 * @param {string[]} [flags=[]] - Additional flags (e.g., '--synthesize', '--short')
 * @returns {Promise<SearchResult>} Search results with answer and sources
 * @throws {Error} If engine is unknown or search fails
 * 
 * @example
 * const result = await runSearch('perplexity', 'how to use async await');
 * console.log(result.answer);
 * console.log(result.sources);
 */
function runSearch(engine, query, flags = []) {
  // ...
}
```

---

### 8.3 Add CHANGELOG

```markdown
# Changelog

## [1.1.0] - Unreleased

### Added
- Mistral engine support (wired up from existing extractor)
- Streaming partial results as engines complete
- Health check command (`search.mjs health`)
- Overall timeout configuration via `GREEDYSEARCH_TIMEOUT`
- `numResults` parameter for controlling source count

### Fixed
- CDP path now uses local implementation instead of hardcoded Claude skill path
- Graceful degradation when Gemini synthesis fails
- Better error messages with actionable suggestions

### Changed
- Extracted shared code into `lib/` modules (reduced code duplication by ~40%)

## [1.0.20] - 2026-03-18

### Added
- Initial GreedySearch Pi extension
- Perplexity, Bing, Google, Gemini, Mistral extractors
- CDP daemon architecture for persistent browser sessions
- Synthesis mode with Gemini
```

---

## Security & Robustness

### 9.1 Sanitize Query in Shell Commands

**Problem:** Query is passed through `spawn()` which is safe, but if any extractor uses shell mode, it could be vulnerable.

**Current code is safe** because all `spawn()` calls use array args (no shell). Keep this pattern.

### 9.2 Validate PAGES_CACHE Integrity

**Problem:** Corrupted cache file causes crashes.

**Solution:**

```javascript
function readPagesCache() {
  try {
    if (!existsSync(PAGES_CACHE)) return null;
    const content = readFileSync(PAGES_CACHE, 'utf8');
    const pages = JSON.parse(content);
    
    // Validate structure
    if (!Array.isArray(pages)) return null;
    for (const page of pages) {
      if (typeof page.url !== 'string' || typeof page.targetId !== 'string') {
        return null;
      }
    }
    
    return pages;
  } catch {
    // Cache corrupted — try to remove it
    try { unlinkSync(PAGES_CACHE); } catch {}
    return null;
  }
}
```

---

## Future Enhancements

### 10.1 Add DuckDuckGo AI Engine
DuckDuckGo now has AI-assisted search. Could be added as another engine option.

### 10.2 Add Caching Layer
Cache search results by query hash to avoid re-searching the same question.

```javascript
// lib/cache.mjs
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const CACHE_DIR = join(tmpdir(), 'greedysearch-cache');
const CACHE_TTL = 3600000; // 1 hour

export function getCachedResult(query, engine) {
  const key = createHash('md5').update(`${engine}:${query}`).digest('hex');
  const path = join(CACHE_DIR, `${key}.json`);
  
  if (!existsSync(path)) return null;
  
  const { timestamp, data } = JSON.parse(readFileSync(path, 'utf8'));
  if (Date.now() - timestamp > CACHE_TTL) return null;
  
  return data;
}

export function setCachedResult(query, engine, data) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const key = createHash('md5').update(`${engine}:${query}`).digest('hex');
  const path = join(CACHE_DIR, `${key}.json`);
  writeFileSync(path, JSON.stringify({ timestamp: Date.now(), data }));
}
```

### 10.3 Add Metrics/Telemetry
Track which engines succeed/fail, response times, etc.

### 10.4 WebSocket API for Real-time Updates
Instead of CLI spawn, expose a WebSocket server that the extension connects to directly.

---

## Implementation Priority

### Phase 1 — Quick Wins (< 1 hour)
1. Fix hardcoded CDP path
2. Add overall timeout
3. Wire up or remove Mistral
4. Add input validation

### Phase 2 — Code Quality (2-4 hours)
1. Extract `lib/cdp-client.mjs`
2. Extract `lib/clipboard-interceptor.mjs`
3. Extract `lib/extractor-args.mjs`
4. Extract `lib/tab-manager.mjs`
5. Update all extractors to use shared modules

### Phase 3 — Features (4-8 hours)
1. Add streaming support to extension
2. Add `numResults` parameter
3. Add health check command
4. Add retry logic

### Phase 4 — Polish (ongoing)
1. Base extractor class (optional)
2. Add caching layer
3. Update documentation
4. Add CHANGELOG

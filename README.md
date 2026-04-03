# GreedySearch for Pi

Pi extension that adds `greedy_search`, `deep_research`, and `coding_task` tools -- multi-engine AI search via browser automation. **NO API KEYS needed.**

Fans out queries to Perplexity, Bing Copilot, and Google AI simultaneously. Returns AI-synthesized answers with fetched source content. Streams progress as each engine completes.

**New in v2.0:** HTTP-first source fetching with Mozilla Readability extraction (~3x faster), smart query-aware source ranking.

Forked from [GreedySearch-claude](https://github.com/apmantza/GreedySearch-claude).

## Quick Note

**No API keys required** -- this tool uses Chrome DevTools Protocol (CDP) to interact with search engines directly through a browser. It launches its own isolated Chrome instance, so it won't interfere with your main browser session.

## Install

```bash
pi install npm:@apmantza/greedysearch-pi
```

Or directly from git:

```bash
pi install git:github.com/apmantza/GreedySearch-pi
```

## Quick Start

Once installed, Pi gains a `greedy_search` tool with two modes.

```javascript
// Default: multi-engine + source fetch + synthesis
 Greedy_search({ query: "What's new in React 19?" })

// Fast: single engine, no synthesis
 greedy_search({ query: "What's new in React 19?", depth: "fast", engine: "perplexity" })
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The search question |
| `engine` | string | `"all"` | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `depth` | string | `"standard"` | `fast` (1 engine, no fetch), `standard` (3 engines + fetch + synthesis) |
| `fullAnswer` | boolean | `false` | Return complete answer (~3000+ chars) vs truncated preview (~300 chars) |

## Depth Levels

| Depth | Engines | Synthesis | Source Fetch | Time | Best For |
|-------|---------|-----------|--------------|------|----------|
| `fast` | 1 | no | no | 10-30s | Quick lookup, single perspective |
| `standard` | 3 | yes | yes (top 5) | 15-30s | **Default** -- balanced, grounded answers |

**Standard mode** (default for `engine: "all"`): Queries 3 engines, fetches content from top 5 sources via HTTP (with Readability extraction), synthesizes grounded answer with citations.

**Fast mode**: Single engine, no source fetching or synthesis. Good for quick checks.

## Engines

| Engine | Alias | Best for |
|--------|-------|----------|
| `all` | - | **Default** -- all 3 engines with synthesis + source fetch |
| `perplexity` | `p` | Technical Q&A, code explanations, documentation |
| `bing` | `b` | Recent news, Microsoft ecosystem |
| `google` | `g` | Broad coverage, multiple perspectives |
| `gemini` | `gem` | Google's AI with different training data |

## Streaming Progress

When using `engine: "all"`, the tool streams progress as each engine completes:

```
**Searching...** pending: perplexity, bing, google
**Searching...** done: perplexity, pending: bing, google
**Searching...** done: perplexity, done: bing, pending: google
**Searching...** done: perplexity, done: bing, done: google
**Synthesizing...** with Gemini
```

## Source Fetching (HTTP-First)

GreedySearch now uses **HTTP-first source fetching** with Mozilla Readability for content extraction:

- **HTTP**: Fast (~200-800ms), parallel, structured markdown output
- **Browser fallback**: Only when HTTP fails (bot protection, JS-heavy sites)
- **Typical success rate**: 90%+ of documentation sites work via HTTP
- **Speed improvement**: ~3x faster than browser-only fetching (15-30s vs 60-180s)

The old regex-based HTML stripping has been replaced with professional-grade content extraction that preserves document structure, code blocks, and headings.

## Smart Source Ranking

Sources are now ranked using query-aware domain boosting:

- **Query keywords** boost official docs (e.g., "react" → react.dev +10 points)
- **Consensus**: Sources found by multiple engines rank higher
- **Source type**: Official docs > repos > blogs > community
- **URL patterns**: `/docs/`, `/api/`, `/reference/` get extra boost

40+ tech stacks have preferred domain mappings including React, Node.js, Python, Rust, Go, Prisma, Supabase, and more.

## Examples

**Default research (multi-engine + sources + synthesis):**

```javascript
greedy_search({ query: "Best practices for monorepo structure" })
```

**Quick lookup (fast):**

```javascript
greedy_search({ query: "How to use async await in Python", depth: "fast", engine: "perplexity" })
```

**Compare tools:**

```javascript
greedy_search({ query: "Prisma vs Drizzle in 2026" })
```

**Debug an error:**

```javascript
greedy_search({ query: "Error: Cannot find module 'react-dom/client' Next.js 15" })
```

## Full vs Short Answers

Default mode returns ~300 char summaries to save tokens. Use `fullAnswer: true` for complete responses:

```javascript
greedy_search({ query: "explain the React compiler", engine: "perplexity", fullAnswer: true })
```

## Legacy Tools

- `deep_research` tool still works -- now aliases to default `greedy_search` (behavior is the same)
- `--deep-research` CLI flag still works -- now default behavior

## Requirements

- **Chrome** -- must be installed. The extension auto-launches a dedicated Chrome instance on port 9222 with its own isolated profile and DevTools port file, separate from your main browser session.
- **Node.js 22+** -- for built-in `fetch` and WebSocket support.

## Setup (first time)

To pre-launch the dedicated GreedySearch Chrome instance:

```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs
```

Stop it when done:

```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs --kill
```

Check status:

```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs --status
```

## Testing

Run the comprehensive test suite:

```bash
npm test              # full suite (~8-12 min)
npm run test:quick    # skip slow tests (~3 min)
npm run test:smoke    # basic health check (~60s)

# Or run directly:
./test.sh              # all tests (~8-12 min)
./test.sh quick        # skip slow tests (~3 min)
./test.sh smoke        # basic health check (~60s)
./test.sh parallel     # race condition tests only
./test.sh flags        # flag/option tests only
./test.sh edge         # edge case tests only
```

### Test Coverage

| Test Category | What It Tests |
|---------------|---------------|
| **Pre-flight** | Chrome, CDP, Node.js version |
| **Flags** | `--full`, `--short`, `--inline`, engine aliases |
| **Single Engine** | Each engine (Perplexity, Bing, Google) independently |
| **Multi-Engine** | Sequential "all" mode, query routing |
| **Parallel** | 5+ concurrent searches, race condition detection |
| **Synthesis** | Gemini synthesis with agreement/caveats/cited claims |
| **Deep Research** | Source fetching, confidence scores, deduplication |
| **Edge Cases** | Special chars, long/short queries, unicode |
| **Coding Task** | Code generation, debug, review modes |

### Test Results

Tests generate a detailed report in `results/test_*/REPORT.md` with:
- Pass/fail/warning counts
- Specific failure details
- Troubleshooting guidance

## Troubleshooting

### "Chrome not found"

Set the path explicitly:

```bash
export CHROME_PATH="/path/to/chrome"
```

### "CDP timeout" or "Chrome may have crashed"

Restart GreedySearch Chrome:

```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs --kill
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs
```

### Google / Bing "verify you're human"

The extension auto-clicks verification buttons and Cloudflare Turnstile challenges using broad keyword matching -- resilient to variations like "Verify you are human" or localised button text. For hard CAPTCHAs (image puzzles), solve manually in the Chrome window that opens.

### Parallel searches failing

Each search creates a fresh isolated browser tab that is closed after completion, allowing safe parallel execution without tab state conflicts.

### Search hangs

Chrome may be unresponsive. Restart it with `launch.mjs --kill` then `launch.mjs`.

### Sources are empty or junk links

Sources are now extracted by regex-parsing Markdown links (`[title](url)`) from the clipboard text captured after each engine responds -- not from DOM selectors that break when the engine's UI updates. If sources are empty, the engine's clipboard copy didn't include formatted links (Bing Copilot currently falls into this category).

## How It Works

- `index.ts` -- Pi extension, registers `greedy_search` tool with streaming progress
- `search.mjs` -- CLI runner, spawns extractors in parallel, emits `PROGRESS:` events to stderr
- `launch.mjs` -- launches dedicated Chrome on port 9222 with isolated profile
- `extractors/` -- per-engine CDP scrapers (Perplexity, Bing Copilot, Google AI, Gemini)
- `cdp.mjs` -- Chrome DevTools Protocol CLI for browser automation
- `skills/greedy-search/SKILL.md` -- skill file that guides the model on when/how to use greedy_search

## Changelog

### v1.6.1 (2026-03-31)
- **Single-engine full answers by default** -- `engine: "google"` (or any single engine) now returns complete answers instead of truncated previews. Multi-engine (`all`) still truncates to save tokens during synthesis.
- **Codebase refactored** -- extracted 438 lines from `index.ts` into modular formatters (`src/formatters/`) reducing cognitive complexity from 360 to ~60 and maintainability index from 11.2 to ~40+
- **Removed codebase search confusion** -- clarified that `greedy_search` is WEB SEARCH ONLY (not for searching local code)

### v1.6.0 (2026-03-29)
- **Merged deep_research into greedy_search** -- new `depth` parameter: `fast` (1 engine), `standard` (3 engines + synthesis), `deep` (3 engines + fetch + synthesis + confidence)
- **Simpler API** -- one tool with clear speed/quality tradeoffs instead of separate tools with overlapping flags
- **Backward compatible** -- `deep_research` still works as alias, `--synthesize` and `--deep-research` flags still function
- **Updated documentation** -- README and skill docs now use `depth` parameter throughout

### v1.5.1 (2026-03-29)
- Fixed npm package -- added `.pi-lens/` and test files to `.npmignore`

### v1.5.0 (2026-03-29)

- **Code extraction fixed** -- `coding_task` now uses clipboard interception to preserve markdown code blocks (was losing them via DOM scraping)
- **Chrome targeting hardened** -- all tools now consistently target the dedicated GreedySearch Chrome via `CDP_PROFILE_DIR`, preventing fallback to user's main Chrome session
- **Shared utilities** -- extracted ~220 lines of duplicate code from extractors into `common.mjs` (cdp wrapper, tab management, clipboard interception)
- **Documentation leaner** -- skill documentation reduced 61% (180 -> 70 lines) while preserving all decision-making info
- **NO API KEYS** -- updated messaging to emphasize this works via browser automation, no API keys needed

### v1.4.2 (2026-03-25)

- **Fresh isolated tabs** -- each search now always creates a new `about:blank` tab via `Target.createTarget` and refreshes the CDP page cache immediately after, preventing SPA navigation failures and stale DOM state from prior queries
- **Regex-based citation extraction** -- all extractors (Perplexity, Bing, Gemini) now parse sources from clipboard Markdown links (`[title](url)`) instead of DOM selectors that break on UI updates
- **Relaxed verification detection** -- `consent.mjs` now uses broad keyword matching (`includes('verify')`, `includes('human')`) instead of anchored regexes, correctly catching button text variants like "Verify you are human" across Cloudflare, Microsoft, and generic modals

---

### v1.4.1

- **Fixed parallel synthesis** -- multiple `greedy_search` calls with `synthesize: true` now run safely in parallel. Each search creates a fresh Gemini tab that gets cleaned up after synthesis, preventing tab conflicts and "Uncaught" errors.

### v1.4.0

- **Grounded synthesis** -- Gemini now receives a normalized source registry with stable source IDs, agreement summaries, caveats, and cited claims
- **Real deep research** -- top sources are fetched before synthesis so deep research answers are grounded in fetched evidence, not just engine summaries
- **Richer source metadata** -- source output now includes canonical URLs, domains, source types, per-engine attribution, and confidence metadata
- **Cleaner tab lifecycle** -- temporary Perplexity, Bing, and Google tabs are closed after each fan-out search, and synthesis finishes on the Gemini tab
- **Isolated Chrome targeting** -- GreedySearch now refuses to fall back to your normal Chrome session, preventing stray remote-debugging prompts

## License

MIT

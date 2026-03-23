# GreedySearch for Pi

Pi extension that adds a `greedy_search` tool — fans out queries to Perplexity, Bing Copilot, and Google AI simultaneously and returns AI-synthesized answers with deduped sources. Streams progress as each engine completes.

Forked from [GreedySearch-claude](https://github.com/apmantza/GreedySearch-claude).

## What's New (v1.4.1)

- **Fixed parallel synthesis** — multiple `greedy_search` calls with `synthesize: true` now run safely in parallel. Each search creates a fresh Gemini tab that gets cleaned up after synthesis, preventing tab conflicts and "Uncaught" errors.

## What's New (v1.4.0)

- **Grounded synthesis** — Gemini now receives a normalized source registry with stable source IDs, agreement summaries, caveats, and cited claims
- **Real deep research** — top sources are fetched before synthesis so deep research answers are grounded in fetched evidence, not just engine summaries
- **Richer source metadata** — source output now includes canonical URLs, domains, source types, per-engine attribution, and confidence metadata
- **Cleaner tab lifecycle** — temporary Perplexity, Bing, and Google tabs are closed after each fan-out search, and synthesis finishes on the Gemini tab
- **Isolated Chrome targeting** — GreedySearch now refuses to fall back to your normal Chrome session, preventing stray remote-debugging prompts

## Install

```bash
pi install npm:@apmantza/greedysearch-pi
```

Or directly from git:

```bash
pi install git:github.com/apmantza/GreedySearch-pi
```

## Quick Start

Once installed, Pi gains a `greedy_search` tool. The model will use it automatically for questions about current libraries, error messages, version-specific docs, etc.

```
greedy_search({ query: "What's new in React 19?", engine: "all" })
```

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The search question |
| `engine` | string | `"all"` | Engine to use (see below) |
| `synthesize` | boolean | `false` | Synthesize results into one answer via Gemini |
| `fullAnswer` | boolean | `false` | Return complete answer (~3000+ chars) vs truncated preview (~300 chars) |

## Engines

| Engine | Alias | Latency | Best for |
|--------|-------|---------|----------|
| `all` | — | 30-90s | Highest confidence — all 3 engines in parallel (default) |
| `perplexity` | `p` | 15-30s | Technical Q&A, code explanations, documentation |
| `bing` | `b` | 15-30s | Recent news, Microsoft ecosystem |
| `google` | `g` | 15-30s | Broad coverage, multiple perspectives |
| `gemini` | `gem` | 15-30s | Google's AI with different training data |

## Streaming Progress

When using `engine: "all"`, the tool streams progress as each engine completes:

```
**Searching...** ⏳ perplexity · ⏳ bing · ⏳ google
**Searching...** ✅ perplexity done · ⏳ bing · ⏳ google
**Searching...** ✅ perplexity done · ✅ bing done · ⏳ google
**Searching...** ✅ perplexity done · ✅ bing done · ✅ google done
```

## Synthesis Mode

For complex research questions, use `synthesize: true` with `engine: "all"`:

```
greedy_search({ query: "best auth patterns for SaaS in 2026", engine: "all", synthesize: true })
```

This deduplicates sources across engines, builds a normalized source registry, and feeds that context to Gemini for one clean synthesized answer. Adds ~30s but now returns agreement summaries, caveats, key claims, and better-labeled top sources.

For the most grounded mode, use deep research from the CLI:

```bash
node search.mjs all "best auth patterns for SaaS in 2026" --deep-research
```

Deep research fetches top source pages before synthesis and reports source confidence metadata such as agreement level, fetched-source success rate, and source mix.

**Use synthesis when:**
- You need one definitive answer, not multiple perspectives
- You're researching a topic to write about or make a decision
- Token efficiency matters (one answer vs three)

**Skip synthesis when:**
- You want to see where engines disagree
- Speed matters

## Full vs Short Answers

Default mode returns ~300 char summaries to save tokens. Use `fullAnswer: true` for complete responses:

```
greedy_search({ query: "explain the React compiler", engine: "perplexity", fullAnswer: true })
```

## Examples

**Quick technical lookup:**
```
greedy_search({ query: "How to use async await in Python", engine: "perplexity" })
```

**Compare tools (see where engines agree/disagree):**
```
greedy_search({ query: "Prisma vs Drizzle in 2026", engine: "all" })
```

**Research with synthesis:**
```
greedy_search({ query: "Best practices for monorepo structure", engine: "all", synthesize: true })
```

**Debug an error:**
```
greedy_search({ query: "Error: Cannot find module 'react-dom/client' Next.js 15", engine: "all" })
```

## Requirements

- **Chrome** — must be installed. The extension auto-launches a dedicated Chrome instance on port 9222 with its own isolated profile and DevTools port file, separate from your main browser session.
- **Node.js 22+** — for built-in `fetch` and WebSocket support.

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

Run the test suite to verify everything works:

```bash
./test.sh           # full suite (~3-4 min)
./test.sh quick     # skip parallel tests (~1 min)
./test.sh parallel  # parallel race condition tests only
```

Tests verify:
- Single engine mode (perplexity, bing, google)
- Sequential "all" mode searches
- Parallel "all" mode (5 concurrent searches) — detects tab race conditions
- Synthesis mode with Gemini

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
The extension auto-clicks verification buttons and Cloudflare Turnstile challenges. For hard CAPTCHAs (image puzzles), solve manually in the Chrome window that opens.

### Parallel searches failing
Earlier versions shared Chrome tabs between concurrent searches, causing `ERR_ABORTED` errors. Version 1.2.0+ creates fresh tabs for each search, allowing safe parallel execution.

### Search hangs
Chrome may be unresponsive. Restart it with `launch.mjs --kill` then `launch.mjs`.

### Sources are junk links
This was a known issue with Gemini sources. If you're on an older version, update:
```bash
pi install npm:@apmantza/greedysearch-pi
```

## How It Works

- `index.ts` — Pi extension, registers `greedy_search` tool with streaming progress
- `search.mjs` — CLI runner, spawns extractors in parallel, emits `PROGRESS:` events to stderr
- `launch.mjs` — launches dedicated Chrome on port 9222 with isolated profile
- `extractors/` — per-engine CDP scrapers (Perplexity, Bing Copilot, Google AI, Gemini)
- `cdp.mjs` — Chrome DevTools Protocol CLI for browser automation
- `skills/greedy-search/SKILL.md` — skill file that guides the model on when/how to use greedy_search

## License

MIT

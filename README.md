# GreedySearch for Pi

Pi extension that adds a `greedy_search` tool — fans out queries to Perplexity, Bing Copilot, and Google AI simultaneously and returns synthesized AI answers. Gemini can act as an optional synthesizer via `synthesize: true`, deduplicating sources across engines and returning a single grounded answer.

Forked from [GreedySearch-claude](https://github.com/apmantza/GreedySearch-claude).

## Install

```bash
pi install npm:@apmantza/greedysearch-pi
```

Or directly from git:

```bash
pi install git:github.com/apmantza/GreedySearch-pi
```

## Usage

Once installed, Pi gains a `greedy_search` tool. The model will use it automatically for questions about current libraries, error messages, version-specific docs, etc.

You can also invoke it directly:

```
greedy_search({ query: "best way to handle auth in Next.js 15", engine: "all" })
```

With Gemini synthesis:

```
greedy_search({ query: "best way to handle auth in Next.js 15", engine: "all", synthesize: true })
```

**Engines:**
- `all` — fan-out to all three in parallel (default, highest confidence)
- `perplexity` / `p` — best for technical Q&A
- `bing` / `b` — best for recent news and Microsoft ecosystem
- `google` / `g` — best for broad coverage
- `gemini` / `gem` — Gemini standalone query

**`synthesize: true`**

Deduplicates sources across engines by consensus, feeds them to Gemini, and returns a single grounded answer instead of three separate responses. Adds ~30s to the request but reduces downstream token usage when passing results to a model.

## Requirements

- Chrome must be running (or it auto-launches a dedicated instance via `launch.mjs`)
- The `chrome-cdp` skill must be accessible (same CDP infrastructure as GreedySearch-claude)

## Setup (first time)

To pre-launch the dedicated GreedySearch Chrome instance:

```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs
```

Stop it when done:

```bash
node ~/.pi/agent/git/GreedySearch-pi/launch.mjs --kill
```

## How It Works

- `index.ts` — Pi extension, registers `greedy_search` tool
- `search.mjs` — CLI runner, spawns extractors in parallel
- `launch.mjs` — launches dedicated Chrome on port 9223
- `extractors/` — per-engine CDP scrapers (Perplexity, Bing Copilot, Google AI, Gemini)

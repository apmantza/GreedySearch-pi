# GreedySearch — Claude Code Plugin

Multi-engine AI web search for Claude Code. Runs Perplexity, Bing Copilot, and Google AI in parallel via browser automation — synthesized answers, not just links. No API keys needed.

## Install

```bash
claude plugin install github:apmantza/GreedySearch-claude
```

Then restart Claude Code.

## What it does

Adds a `greedy_search` skill that Claude invokes automatically when questions touch post-training topics:

- Library/framework APIs and recent changes
- Error messages and stack traces
- Dependency selection
- Architecture research

## Tools

### `greedy_search`

```
greedy_search({ query: "React 19 changes", depth: "standard" })
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search question |
| `engine` | string | `"all"` | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `depth` | string | `"standard"` | `fast`, `standard`, `deep` |
| `fullAnswer` | boolean | `false` | Full answer vs ~300 char summary |

| Depth | Engines | Synthesis | Source Fetch | Time |
|-------|---------|-----------|--------------|------|
| `fast` | 1 | — | — | 15-30s |
| `standard` | 3 | Gemini | — | 30-90s |
| `deep` | 3 | Gemini | top 5 sources | 60-180s |

### `coding_task`

Second opinion from Gemini or Copilot on hard coding problems.

```
coding_task({ task: "debug this race condition", mode: "debug", engine: "gemini" })
```

Modes: `debug`, `plan`, `review`, `test`, `code`

## Prerequisites

- Node.js 18+
- Google Chrome (detected automatically — launches on first use)

## How it works

Browser automation via Chrome DevTools Protocol. Each search opens a fresh tab per engine, submits the query, waits for the AI answer to stream, extracts it via clipboard interception, then closes the tab. No fragile DOM scraping.

## Source repo

The Pi extension lives at [GreedySearch-pi](https://github.com/apmantza/GreedySearch-pi). This repo is mirrored automatically on every release.

## License

MIT

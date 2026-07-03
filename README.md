<p align="center">
  <img src="docs/banner.svg" alt="GreedySearch for Pi" width="1100">
</p>

# GreedySearch for Pi

GreedySearch registers the `greedy_search` tool for Pi: headless-first,
no-API-key AI/web search through a dedicated Chrome profile.

## What It Does

- Multi-engine search across Perplexity, Google AI, ChatGPT, and Gemini
- Source-grounded `engine: "all"` results with fetched source content
- Optional synthesis over engine answers and fetched sources
- Iterative `depth: "research"` runs with citation audit and research bundles
- Visible Chrome fallback for login/captcha/cookie setup when needed

## Install

```bash
pi install npm:@apmantza/greedysearch-pi
```

Or from git:

```bash
pi install git:github.com/apmantza/GreedySearch-pi
```

## Quick Usage

```js
greedy_search({ query: "React 19 changes" });
greedy_search({ query: "React 19 changes", synthesize: true });
greedy_search({ query: "Prisma vs Drizzle", engine: "perplexity" });
greedy_search({
  query: "Evaluate browser automation options for AI agents",
  depth: "research",
  breadth: 3,
  iterations: 2,
  maxSources: 8,
});
```

Headless is the default. Use `visible: true` only when you need to establish a
session, solve a challenge, or inspect the browser:

```js
greedy_search({ query: "Visible setup", engine: "perplexity", visible: true });
```

## Documentation

- [Usage guide](docs/usage.md) — tool parameters, search modes, and config
- [Research mode](docs/research.md) — iterative workflow and bundle layout
- [Runtime and Chrome](docs/runtime.md) — slash commands, env vars, CDP safety
- [Source fetching](docs/source-fetching.md) — supported source types and metadata
- [Development](docs/development.md) — project layout, tests, and smoke checks
- [Release workflow](docs/releases.md) — changelog scripts and GitHub releases

## Requirements

- Chrome or Chromium
- Node.js 20.11.0+

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) for the
extractor, recovery, and release checklists.

GreedySearch is released under the [MIT License](LICENSE).

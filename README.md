# GreedySearch for Pi

Multi-engine AI web search for Pi via browser automation.

- No API keys
- Real browser results (Perplexity, Bing Copilot, Google AI)
- Optional Gemini synthesis with source grounding

## Install

```bash
pi install npm:@apmantza/greedysearch-pi
```

Or from git:

```bash
pi install git:github.com/apmantza/GreedySearch-pi
```

## Tools

- `greedy_search` - fast or grounded multi-engine search
- `coding_task` - browser-routed Gemini/Copilot coding assistance

## Quick usage

```js
greedy_search({ query: "React 19 changes" })
greedy_search({ query: "Prisma vs Drizzle", engine: "all", depth: "fast" })
greedy_search({ query: "Best auth architecture 2026", engine: "all", depth: "deep" })
```

## Parameters (`greedy_search`)

- `query` (required)
- `engine`: `all` (default), `perplexity`, `bing`, `google`, `gemini`
- `depth`: `standard` (default), `fast`, `deep`
- `fullAnswer`: return full single-engine output instead of preview

## Depth modes

- `fast` - quickest, no synthesis/source fetching
- `standard` - balanced default for `engine: "all"` (synthesis + fetched sources)
- `deep` - strongest grounding and confidence metadata

## Runtime commands

```bash
node ~/.pi/agent/git/GreedySearch-pi/bin/launch.mjs
node ~/.pi/agent/git/GreedySearch-pi/bin/launch.mjs --status
node ~/.pi/agent/git/GreedySearch-pi/bin/launch.mjs --kill
```

## Requirements

- Chrome
- Node.js 20.11.0+ (22+ recommended)

## Source fetching

When using `depth: "standard"` or `depth: "deep"`, source content is fetched and synthesized:

- **Reddit** — Uses Reddit's public `.json` API for posts and comments (no scraping)
- **GitHub** — Uses GitHub REST API for repos, READMEs, and file trees
- **General web** — Mozilla Readability extraction with browser fallback for bot-blocked pages
- **Metadata** — title, author/byline, site name, publish date, language, excerpt

## Project layout

- `bin/` - runtime CLIs (`search.mjs`, `launch.mjs`, `cdp.mjs`, `coding-task.mjs`)
- `extractors/` - engine-specific automation
- `src/` - ranking/fetching/formatting internals (includes `reddit.mjs`, `github.mjs`, `fetcher.mjs`)
- `skills/` - Pi skill metadata

## Testing

Cross-platform test runner (Windows + Unix):
```bash
npm test              # run all tests
npm run test:quick    # skip slow tests
npm run test:smoke    # basic health check
```

Full bash test suite (Unix only):
```bash
npm run test:bash           # comprehensive tests
./test.sh parallel          # race condition tests
./test.sh flags             # flag/option tests
```

## Changelog

See `CHANGELOG.md`.

## License

MIT

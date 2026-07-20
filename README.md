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

## MCP server

GreedySearch also ships a dependency-free MCP stdio server (`bin/mcp.mjs`)
so Claude Code — or any MCP client — can call it directly, outside of Pi.
It exposes two tools:

- `greedy_search` — same parameters as the Pi `greedy_search` tool
  (`query`, `engine`, `synthesize`, `synthesizer`, `depth`, `breadth`,
  `iterations`, `maxSources`, `researchOutDir`, `writeResearchBundle`,
  `fullAnswer`, `locale`, `visible`). Spawns `bin/search.mjs` under the
  hood; searches take roughly 1-5 minutes.
- `greedy_fetch` — fetch a single URL and return its extracted
  title/byline/content (`url`, `maxChars`).

### Register with Claude Code

This repo includes a project-scope `.mcp.json` at the repo root, so running
Claude Code from inside a checkout picks up the `greedysearch` server
automatically (you'll be prompted to approve project-scoped servers on
first use).

To register it manually (e.g. from outside the repo, or in user scope):

```bash
claude mcp add greedysearch -- node /absolute/path/to/greedysearch-pi/bin/mcp.mjs
```

Or run the server directly for testing:

```bash
npm run mcp
```

### Sample `tools/call`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "greedy_search",
    "arguments": { "query": "React 19 changes", "engine": "perplexity" }
  }
}
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

## Contributors

Thanks goes to these wonderful people:

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
<tbody>
<tr>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/wastedC"><img src="https://avatars.githubusercontent.com/u/917574?v=4" width="100px;" alt=""/><br /><sub><b>wastedC</b></sub></a><br /><a href="#code-wastedC" title="Code">💻</a> <a href="#ideas-wastedC" title="Ideas & Planning">🤔</a> <a href="#maintenance-wastedC" title="Maintenance">🚧</a> <a href="#review-wastedC" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apmantza"><img src="https://avatars.githubusercontent.com/u/247365598?v=4" width="100px;" alt=""/><br /><sub><b>Apostolos Mantzaris</b></sub></a><br /><a href="#code-apmantza" title="Code">💻</a> <a href="#doc-apmantza" title="Documentation">📖</a> <a href="#ideas-apmantza" title="Ideas & Planning">🤔</a> <a href="#maintenance-apmantza" title="Maintenance">🚧</a> <a href="#review-apmantza" title="Reviewed Pull Requests">👀</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/apps/dependabot"><img src="https://avatars.githubusercontent.com/in/29110?v=4" width="100px;" alt=""/><br /><sub><b>Dependabot</b></sub></a><br /><a href="#maintenance-dependabot[bot]" title="Maintenance">🚧</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/peyloride"><img src="https://avatars.githubusercontent.com/u/10589068?v=4" width="100px;" alt=""/><br /><sub><b>peyloride</b></sub></a><br /><a href="#bug-peyloride" title="Bug reports">🐛</a></td>
      <td align="center" valign="top" width="14.28%"><a href="https://github.com/hypnoglow"><img src="https://avatars.githubusercontent.com/u/4853075?v=4" width="100px;" alt=""/><br /><sub><b>hypnoglow</b></sub></a><br /><a href="#bug-hypnoglow" title="Bug reports">🐛</a></td>
    </tr>
</tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

If you land a pull request or report an issue that gets fixed, we'll add you here.

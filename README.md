# GreedySearch for Pi

![GreedySearch](docs/banner.svg)

Multi-engine AI web search for Pi via browser automation.

- No API keys
- Real browser results (Perplexity, Bing Copilot, Google AI)
- Optional Gemini synthesis with source grounding
- Chrome runs headless by default — no window, purely background

## Install

```bash
pi install npm:@apmantza/greedysearch-pi
```

Or from git:

```bash
pi install git:github.com/apmantza/GreedySearch-pi
```

## Tools

- `greedy_search` — multi-engine AI web search
- `websearch` — lightweight DuckDuckGo/Brave search (via pi-webaio)
- `webfetch` / `webpull` — page fetching and site crawling (via pi-webaio)

## Quick usage

```js
greedy_search({ query: "React 19 changes" });
greedy_search({ query: "Prisma vs Drizzle", engine: "all", depth: "fast" });
greedy_search({
  query: "Best auth architecture 2026",
  engine: "all",
  depth: "deep",
});
// Headless is the default — no window. To force visible Chrome:
greedy_search({ query: "Bing captcha setup", engine: "bing", visible: true });
```

## Parameters (`greedy_search`)

- `query` (required)
- `engine`: `all` (default), `perplexity`, `bing`, `google`, `gemini`
- `depth`: `standard` (default), `fast`, `deep`
- `fullAnswer`: return full single-engine output instead of preview
- `headless`: set to `false` to show Chrome window (default: `true`)
- `visible` / `alwaysVisible`: set to `true` to always use visible Chrome for this search

## Environment variables

| Variable                             | Default       | Description                                                   |
| ------------------------------------ | ------------- | ------------------------------------------------------------- |
| `GREEDY_SEARCH_VISIBLE`              | (unset)       | Set to `1` to show Chrome window instead of headless          |
| `GREEDY_SEARCH_ALWAYS_VISIBLE`       | (unset)       | Set to `1` to force visible Chrome for all GreedySearch runs  |
| `GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES` | `5`           | Minutes of inactivity before auto-killing GreedySearch Chrome |
| `GREEDY_SEARCH_LOCALE`               | `en`          | Default result language (en, de, fr, es, ja, etc.)            |
| `CHROME_PATH`                        | auto-detected | Path to Chrome/Chromium executable                            |

## Depth modes

- `fast` - quickest, no synthesis/source fetching
- `standard` - balanced default for `engine: "all"` (synthesis + fetched sources)
- `deep` - strongest grounding and confidence metadata

## Runtime commands

Inside Pi, prefer the extension commands (no package path needed):

```text
/greedy-visible      # launch visible Chrome for captcha/login/cookie setup
/greedy-status       # show GreedySearch Chrome status
/greedy-kill         # stop GreedySearch Chrome
/set-greedy-locale   # set default result language (de, fr, es, ja, etc.)
```

Git install path:

```bash
GS=~/.pi/agent/git/github.com/apmantza/GreedySearch-pi
node "$GS/bin/launch.mjs" --status
node "$GS/bin/visible.mjs"          # visible mode
node "$GS/bin/visible.mjs" --kill   # strong visible/port cleanup
node "$GS/bin/kill-visible.mjs"     # same as visible.mjs --kill
node "$GS/bin/cdp-visible.mjs" list # safe CDP: GreedySearch visible Chrome only
node "$GS/bin/cdp-headless.mjs" list # safe CDP: GreedySearch headless Chrome only
node "$GS/bin/cdp-greedy.mjs" list  # safe CDP: any GreedySearch Chrome mode
```

npm global install path:

```bash
GS="$(npm root -g)/@apmantza/greedysearch-pi"
node "$GS/bin/launch.mjs" --status
node "$GS/bin/visible.mjs"
node "$GS/bin/visible.mjs" --kill
node "$GS/bin/kill-visible.mjs"
node "$GS/bin/cdp-visible.mjs" list
node "$GS/bin/cdp-headless.mjs" list
node "$GS/bin/cdp-greedy.mjs" list
```

Chrome is auto-cleaned after 5 min idle. Override with `GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES=10` or disable with `0`.

**CDP safety:** use `cdp-visible.mjs`, `cdp-headless.mjs`, or `cdp-greedy.mjs` for debugging. They always set `CDP_PROFILE_DIR` to the dedicated GreedySearch Chrome profile and never fall back to your main Chrome session. Avoid calling raw `bin/cdp.mjs` manually unless you explicitly set `CDP_PROFILE_DIR`.

## Requirements

- Chrome
- Node.js 20.11.0+

## Known engine quirks

### Bing Copilot

Bing Copilot detects headless Chrome and sandboxes all AI responses inside nested iframes (`copilot.microsoft.com` → `copilot.fun` → `blob:`). In this mode the copy button is hidden and the Cloudflare Turnstile challenge blocks content delivery. The clipboard-based extraction cannot work.

**Auto-recovery:** When Bing or Perplexity fails with a headless-only extraction error (clipboard, verification, timeout, Cloudflare), GreedySearch automatically switches to **visible Chrome** and retries, even in `fast` mode. If manual verification is required, the visible browser is left open and the tool returns instructions to solve the challenge and rerun the same search.

If you prefer to skip the auto-recovery delay, launch visible Chrome ahead of time with `/greedy-visible`, set `GREEDY_SEARCH_ALWAYS_VISIBLE=1`, or pass `visible: true` to `greedy_search`.

## Anti-detection

Headless Chrome auto-injects stealth patches before any page JavaScript runs:

- `navigator.webdriver` hidden, plugins/languages faked, `window.chrome` shimmed
- WebGL vendor spoofed (Intel Iris), realistic hardware concurrency / memory
- CDP automation markers deleted, `requestAnimationFrame` kept alive
- Human-like click simulation with coordinate jitter and variable delays

This bypasses casual bot detection (basic `navigator.webdriver` checks) but does not defeat commercial anti-bot services (DataDome, PerimeterX, Kasada). **Bing Copilot specifically detects headless and sandboxes responses behind Cloudflare Turnstile** — see [Known engine quirks](#known-engine-quirks) for the auto-recovery mechanism.

When using `depth: "standard"` or `depth: "deep"`, source content is fetched and synthesized:

- **Reddit** — Uses Reddit's public `.json` API for posts and comments (no scraping)
- **GitHub** — Uses GitHub REST API for repos, READMEs, and file trees
- **General web** — Mozilla Readability extraction with browser fallback for bot-blocked pages
- **Metadata** — title, author/byline, site name, publish date, language, excerpt

## Project layout

- `bin/` — runtime CLIs (`search.mjs`, `launch.mjs`, `launch-visible.mjs`, `visible.mjs`, `kill-visible.mjs`, safe CDP wrappers, `cdp.mjs`)
- `extractors/` — engine-specific automation + stealth/consent handling
- `src/` — search pipeline, chrome management, source fetching, formatting
- `skills/` — Pi skill metadata

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

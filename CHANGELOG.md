# Changelog

## v1.8.3 (2026-04-24)

### Features
- **Reddit JSON API support** — Reddit post URLs now use Reddit's public `.json` API instead of HTML scraping. Gets structured post data + top comments with nesting. Falls back to HTTP fetch if API fails.

## v1.8.2 (2026-04-20)

### Cross-Platform Testing
- **Node.js test runner (`test.mjs`)** — Added cross-platform test runner that works on Windows, macOS, and Linux without requiring bash. Runs smoke tests, quick tests, and edge case tests.
- **Updated npm scripts** — `npm test` now runs the Node.js test runner (was bash-only). Original bash tests available via `npm run test:bash`.

### Project Metadata
- **Added `engines` field** — Package now specifies `node: ">=20.11.0"` requirement for `import.meta.dirname` support.
- **Updated README** — Added Testing section documenting both Node.js and bash test runners, clarified Node.js 20.11.0+ requirement.

## v1.8.0 (2026-04-16)

### Fixes
- **`cdpAvailable()` missing `baseDir` argument** — two callsites in `index.ts` (session_start handler and coding_task handler) were calling `cdpAvailable()` without the required `baseDir` parameter, producing an incorrect path (`join(undefined, "bin", "cdp.mjs")`). Both now pass `__dir` so the CDP check resolves against the correct package directory.
- **Duplicated `ENGINES` map removed** — `ENGINES` was defined identically in both `src/search/constants.mjs` and `src/search/engines.mjs`. Now `engines.mjs` imports and re-exports from `constants.mjs`, keeping a single canonical source and eliminating sync drift risk.
- **`ALL_ENGINES` sync comment** — added a `// Keep in sync with src/search/constants.mjs` comment on the `ALL_ENGINES` tuple in `shared.ts` so future maintainers know where the canonical definition lives.

## v1.7.7 (2026-04-14)

### Fixes
- **`--deep` flag leaking into queries** — `depth: "deep"` was passing `--deep` as a bare flag to `search.mjs`, which didn't recognize it and appended it to the query string. Fixed by passing `--depth deep` instead; also added `--deep` as a recognized flag in `search.mjs` for backward compatibility with the legacy `deep_research` tool.
- **GitHub fetch always failing** — `git clone` was being `await`-ed on a non-Promise `ChildProcess` object (Node `execFile` is callback-based), so the clone never actually completed and content was always empty. Replaced git clone entirely with GitHub REST API calls: repo info + README + file tree fetched via parallel HTTP requests (~2-5s vs 30-60s, no git dependency). Non-existent repos now correctly return `ok: false`.
- **`--inline` test false negative** — smoke test was interpolating multiline JSON stdout into a `node -e` string, always producing `PARSE_ERROR`. Fixed to write stdout to a temp file and parse from file.

### Features
- **Rich source metadata** — HTTP-fetched sources now include `publishedTime`, `lastModified`, `byline`, `siteName`, and `lang`. `publishedTime` is extracted from Readability's parser plus a fallback chain of 8 `<meta>` selectors (Open Graph, schema.org, Dublin Core). All fields flow through to the Gemini synthesis prompt. Gemini is instructed to flag sources older than 2 years as potentially stale in caveats.
- **GitHub Fetch Tests** — smoke/edge/quick test modes now include 4 GitHub-specific tests: root repo API fetch (README + tree), blob file via raw URL, blob via HTTP fetcher pipeline, and graceful failure on non-existent repo.

## v1.7.6 (2026-04-11)

### Fixes
- **Close Gemini synthesis tab** — after synthesis completes, the Gemini tab is now closed instead of merely activated, preventing stale tabs from accumulating across searches.

## v1.7.5 (2026-04-10)

### Plugin
- **Claude Code plugin** — added `.claude-plugin/plugin.json` and `marketplace.json` so GreedySearch can be installed directly as a Claude Code plugin via `claude plugin install`.
- **Auto-mirror GH Action** — every push to `GreedySearch-pi/master` automatically syncs to `GreedySearch-claude/main`, keeping the Claude plugin up to date.
- **Tightened `skill.md`** — removed verbose guidance sections; kept parameters, depth table, and coding_task reference. -72 lines.

## v1.7.4 (2026-04-10)

### Refactor
- **Shared `waitForCopyButton()`** — consolidated duplicate copy-button polling loops from `bing-copilot`, `gemini`, and `coding-task` into a single `waitForCopyButton(tab, selector, { timeout, onPoll })` in `common.mjs`. Gemini's scroll-to-bottom logic passed as `onPoll` callback.
- **Shared `TIMING` constants** — replaced 30+ scattered `setTimeout` magic numbers with named constants (`postNav`, `postNavSlow`, `postClick`, `postType`, `inputPoll`, `copyPoll`, `afterVerify`) in `common.mjs`.
- **`waitForStreamComplete` improvements** — added `minLength` option and graceful last-value fallback; `google-ai` now uses the shared implementation instead of its own copy.
- **Removed dead code** — deleted unused `_getOrReuseBlankTab` and `_getOrOpenEngineTab` from `bin/search.mjs`; removed unused `STREAM_POLL_INTERVAL` and `STREAM_STABLE_ROUNDS` from `coding-task`.

### Fixes
- **Synthesis tab regression** — `getOrOpenEngineTab("gemini")` call during synthesis was broken by the dead-code removal; replaced with `openNewTab()`.

## v1.7.3 (2026-04-10)

### Fixes
- **Force English in Google AI results** — Added `hl=en` query parameter to Google AI Mode search URL so responses are always returned in English, regardless of the user's IP-based region (fixes #1).

## v1.7.2 (2026-04-08)

### Release
- **Patch release** — version bump and npm package verification for the `bin/` runtime layout (`bin/search.mjs`, `bin/launch.mjs`, `bin/cdp.mjs`, `bin/coding-task.mjs`).

## v1.7.1 (2026-04-08)

### Performance
- **Bounded source-fetch concurrency** — source fetching now uses a small worker pool (default `2`, configurable via `GREEDY_FETCH_CONCURRENCY`) to reduce burstiness while keeping deep-research fast.

### Project structure
- **Runtime scripts moved to `bin/`** — `search.mjs`, `launch.mjs`, `cdp.mjs`, and `coding-task.mjs` now live under `bin/` for a cleaner repository root.
- **Path references updated** — extension runtime, tests, extractor shared utilities, and docs now point to `bin/*` paths.

### Packaging & docs
- **Package file list updated** — npm package now includes `bin/` directly instead of root script entries.
- **README simplified** — rewritten into a shorter, concise format with quick install, usage, and layout guidance.

## v1.6.5 (2026-04-04)

### Security
- **Private URL blocking** — Added validation to block requests to localhost, RFC1918 private addresses (10.x, 192.168.x), and .local/.internal domains. Prevents accidental exposure of internal services.

### Features
- **GitHub URL rewriting** — GitHub blob URLs (`github.com/owner/repo/blob/...`) are automatically rewritten to `raw.githubusercontent.com` for faster, cleaner raw file access.
- **GitHub repo cloning** — Root and tree URLs now trigger `git clone --depth 1` for complete repo access. Agent can explore files locally instead of parsing rendered HTML. Includes README preview and directory tree listing.
- **Head+tail content trimming** — Large documents now use smart truncation: keeps 75% from the beginning (introduction) + 25% from the end (conclusions/examples) with `[...content trimmed...]` marker, instead of simple truncation.
- **Anubis bot detection** — Added detection for the new Anubis proof-of-work anti-bot system (`protected by anubis`, `anubis uses a proof-of-work`).

### Fixes
- **Perplexity clipboard retry** — Added single retry with 2s delay when clipboard extraction fails, improving reliability.

## v1.6.4 (2026-04-02)

### Fixes
- **Gemini scroll-to-bottom** — Changed from small random jitter scrolls to actual bottom-of-page scrolls every ~6 seconds while waiting for the copy button. This ensures lazy-loaded content is triggered and the full answer is captured.
- **Restored missing files** — `.mjs` source files (extractors, search.mjs, launch.mjs, etc.) were incorrectly removed in v1.6.2 cleanup; now properly tracked again.

## v1.6.3 (2026-04-02)

### Fixes
- **Debug output removed** — Cleaned up stderr passthrough that was causing CDP connection issues in some environments.

## v1.6.2 (2026-04-01)

### Fixes
- **Anti-bot detection evasion** — Gemini synthesis now performs gentle scroll every ~6 seconds while waiting for the copy button. This prevents the button from hanging due to anti-bot "human activity" checks.

## v1.6.1 (2026-03-31)

### Features
- **Single-engine full answers by default** — when using `engine: "perplexity"`, `engine: "bing"`, `engine: "google"`, or `engine: "gemini"`, the full answer is now returned by default instead of truncated previews. Multi-engine (`engine: "all"`) still uses truncated previews (~300 chars) to save tokens during synthesis. Explicit `fullAnswer: true/false` always overrides.

### Code Quality
- **Major refactoring** — extracted 438 lines from `index.ts` (856 → 418 lines) into modular formatters:
  - `src/formatters/coding.ts` — coding task formatting
  - `src/formatters/results.ts` — search and deep research formatting  
  - `src/formatters/sources.ts` — source utilities (URL, label, consensus, formatting)
  - `src/formatters/synthesis.ts` — synthesis rendering
  - `src/utils/helpers.ts` — shared formatting utilities
- **Complexity reduced** — cognitive complexity dropped from 360 to ~60, maintainability index improved from 11.2 to ~40+
- **Eliminated code duplication** — removed 6 duplicate blocks, consolidated 4+ single-use helper functions

### Documentation
- Clarified `greedy_search` is WEB SEARCH ONLY — removed "NOT for codebase search" from tool description (still in skill documentation)

## v1.6.0 (2026-03-29)

### Breaking Changes (Backward Compatible)
- **Merged deep_research into greedy_search** — new `depth` parameter with three levels:
  - `fast`: single engine (~15-30s)
  - `standard`: 3 engines + synthesis (~30-90s, default for `engine: "all"`)
  - `deep`: 3 engines + source fetching + synthesis + confidence (~60-180s)
- **Simpler mental model** — one tool with clear speed/quality tradeoffs instead of separate tools with overlapping flags
- **Deprecated flags still work** — `--synthesize` maps to `depth: "standard"`, `--deep-research` maps to `depth: "deep"`
- **deep_research tool aliased** — still works, calls `greedy_search` with `depth: "deep"`

### Documentation
- Updated README with new `depth` parameter and examples
- Updated skill documentation (SKILL.md) to reflect simplified API

## v1.5.1 (2026-03-29)

- **Fixed npm package** — added `.pi-lens/` and test files to `.npmignore` to reduce package size

## v1.5.0 (2026-03-29)

### Features
- **Code extraction fixed** — `coding_task` now uses clipboard interception to preserve markdown code blocks (was losing them via DOM scraping)
- **Chrome targeting hardened** — all tools now consistently target the dedicated GreedySearch Chrome via `CDP_PROFILE_DIR`, preventing fallback to user's main Chrome session
- **Shared utilities** — extracted ~220 lines of duplicate code from extractors into `common.mjs` (cdp wrapper, tab management, clipboard interception)
- **Documentation leaner** — skill documentation reduced 61% (180 → 70 lines) while preserving all decision-making info

### Notable
- **NO API KEYS** — updated messaging to emphasize this works via browser automation, no API keys needed

## v1.4.2 (2026-03-25)

- **Fresh isolated tabs** — each search now always creates a new `about:blank` tab via `Target.createTarget` and refreshes the CDP page cache immediately after, preventing SPA navigation failures and stale DOM state from prior queries
- **Regex-based citation extraction** — all extractors (Perplexity, Bing, Gemini) now parse sources from clipboard Markdown links (`[title](url)`) instead of DOM selectors that break on UI updates
- **Relaxed verification detection** — `consent.mjs` now uses broad keyword matching (`includes('verify')`, `includes('human')`) instead of anchored regexes, correctly catching button text variants like "Verify you are human" across Cloudflare, Microsoft, and generic modals

## v1.4.1

- **Fixed parallel synthesis** — multiple `greedy_search` calls with `synthesize: true` now run safely in parallel. Each search creates a fresh Gemini tab that gets cleaned up after synthesis, preventing tab conflicts and "Uncaught" errors.

## v1.4.0

- **Grounded synthesis** — Gemini now receives a normalized source registry with stable source IDs, agreement summaries, caveats, and cited claims
- **Real deep research** — top sources are fetched before synthesis so deep research answers are grounded in fetched evidence, not just engine summaries
- **Richer source metadata** — source output now includes canonical URLs, domains, source types, per-engine attribution, and confidence metadata
- **Cleaner tab lifecycle** — temporary Perplexity, Bing, and Google tabs are closed after each fan-out search, and synthesis finishes on the Gemini tab
- **Isolated Chrome targeting** — GreedySearch now refuses to fall back to your normal Chrome session, preventing stray remote-debugging prompts

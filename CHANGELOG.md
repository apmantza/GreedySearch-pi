# Changelog

## Unreleased

### Added

- **`google-search` engine** — plain Google search extractor (locale-agnostic, `textarea[name="q"]`). Returns title/URL/snippet for traditional 10-blue-link results. Aliases: `gs`, `googlesearch`.

### Headless Mode (default)

- **Chrome now runs headless by default** — no window, no GUI, purely background. Set `GREEDY_SEARCH_VISIBLE=1` to show the browser window.
- **Anti-detection stealth** — Patches injected via `Page.addScriptToEvaluateOnNewDocument` (runs before any page JS):
  - `Runtime.enable` / CDP marker deletion (`__REBROWSER_*`, `__nightmare`, `__phantom`, etc.)
  - `navigator.webdriver` → `false`, `navigator.plugins` → realistic list, `navigator.languages` → `['en-US', 'en']`
  - `window.chrome` shim, WebGL vendor → Intel Iris, `hardwareConcurrency` → 8, `deviceMemory` → 8
  - `TrustedTypes` policy, `requestAnimationFrame` keep-alive (prevents headless stall detection)
  - `--disable-blink-features=AutomationControlled`, realistic `--user-agent`, `--window-size=1920,1080`
- **Human click simulation** — All verification/clicks now use CDP `Input.dispatchMouseEvent` with multi-event `mouseMoved→pressed→released`, ±3px coordinate jitter, and random delays (80–180ms hover, 30–90ms hold). Detection scripts return element selectors instead of clicking in-page; `handleVerification` performs human clicks via `humanClickElement()`/`humanClickXY()`. Applies to Turnstile iframes, reCAPTCHA, Cloudflare challenges, Microsoft auth, Copilot modals, and all generic verify/continue buttons.
- **Idle auto-cleanup** — Headless Chrome auto-killed after `GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES` (default 5 min) of inactivity. Kills only the PID-tracked instance on port 9222 — never touches the main Chrome session. Activity timestamp written at search start and end.

### Performance

- **Timeouts cut ~40–50%** across all extractors — typical search ~60–90s → ~30–45s:
  - `TIMING`: postNav 1500→800ms, postNavSlow 2000→1000ms, postClick 400→250ms, postType 400→250ms, inputPoll 400→300ms, copyPoll 600→400ms, afterVerify 3000→2000ms
  - Defaults: waitForCopyButton 60s→30s, waitForStreamComplete 30s→20s, handleVerification 60s→30s
  - Per-extractor: Google stream 45s→30s, Gemini copyButton 120s→60s + inputDeadline 10s→8s, Perplexity inputDeadline 8s→5s + stream 30s→20s, Bing verification 90s→30s + copyButton 60s→30s
  - Engine process timeout: 90s→60s (180s→120s Gemini)

### Security

- **SonarCloud security hotspots fixed** — Two open hotspots resolved:
  - _Weak cryptography (S2245)_ in `extractors/consent.mjs`: replaced `Math.random()` with `crypto.randomInt()` for the mouse-jitter RNG. Not actually security-sensitive (used only for ±3px jitter and timing delays), but compliant now.
  - _PATH injection (S4036)_ in `src/search/chrome.mjs`: `spawn("node", ...)` replaced with `spawn(process.execPath, ...)` so the launcher doesn't rely on the `PATH` environment variable.
- **Query/prompt leakage prevention** — Queries and synthesis prompts no longer appear in OS process tables. All `spawn()` calls now pipe query/prompt through stdin via `--stdin` flag instead of command-line arguments. Affects `runSearch`, `runExtractor`, `synthesizeWithGemini`, and all 5 extractors (`perplexity`, `bing-copilot`, `google-ai`, `google-search`, `gemini`).

### Visual

- **Redesigned banner** — Cleaner SVG layout with pi logo icon, no text, no lens graphic. Gemini Synthesizer pill badge integrated. Three design iterations landed on a minimal icon-only look (`docs/banner.svg`).

### Fixed

- **Gemini & Bing copy button race condition** — Both extractors were capturing the user's query instead of the AI's answer. Root cause: `document.querySelector()` returns the first copy button in DOM order, which is the user's echoed message (above the assistant's response). For short queries this triggers instantly. Fixed by: (1) replacing `waitForCopyButton` with `waitForStreamComplete` to ensure the response finishes streaming before copying, and (2) clicking the **last** copy button (`querySelectorAll` + `[length-1]`) instead of the first — matching Perplexity's proven pattern. Also added periodic scroll-to-bottom alongside stream wait for Gemini to trigger lazy-loaded content.
- **Progress tracker shows false ✅ for errors** — `makeProgressTracker` in `shared.ts` completely ignored the `status` parameter, always showing `✅ done` for every engine. Now correctly tracks per-engine status and shows `❌ failed` when an engine errors.
- **Synthesis echoes engine JSON when engines fail** — When Perplexity/Bing fail, Gemini was echoing the engine summary JSON back as its "answer". `synthesis-runner.mjs` now detects this pattern (engine keys without synthesis fields) and treats it as a parse failure, falling back to individual engine results.
- **`headless=false` parameter ignored** — The `--headless` flag was never checked by `search.mjs` or `launch.mjs`; they only read `GREEDY_SEARCH_VISIBLE`. `shared.ts` now propagates the visibility preference via the env var when `headless=false` is passed.

### Cloudflare / Verification Recovery

- **Auto-recovery from Cloudflare blocks** — When Perplexity (`#ask-input` not found) or Bing (`input not found` / `verification required`) fail in headless mode, `search.mjs` now:
  1. Detects the Cloudflare/verification error pattern
  2. Kills headless Chrome, relaunches in visible mode
  3. Retries the blocked engines — Cloudflare bypasses, cookies stored in Chrome profile
  4. Kills visible Chrome, relaunches headless
  5. Continues remaining pipeline (source fetch, synthesis)
  6. Cookies persist — subsequent headless searches pass transparently

### Removed

- **`coding_task` tool removed** — `bin/coding-task.mjs`, `src/formatters/coding.ts`, registration deleted (644 lines).
- **`deep_research` tool removed** — handler, test, and `formatDeepResearch` + helpers deleted (521 lines). Use `greedy_search` with `depth: "deep"`.
- **Minimize debug logs** — Removed 9 verbose `[minimize]` console.log statements from launch.mjs.

### Fixes

- **Code scanning alerts resolved (5 alerts)** — (1) Added `permissions: contents: read` to `sync-to-webaio.yml` workflow (#14). (2) Fixed backslash escaping in `consent.mjs`'s `humanClickElement` selector injection (#10) — selectors containing backslashes (e.g., `\"`) weren't properly escaped before DOM injection. (3) Fixed same backslash escaping in `google-search.mjs`'s `SEARCH_BOX` selector in 3 locations (#11-13).
- **`cdp.mjs` `getPages()` filter** — Allows `chrome://newtab/` (headless Chrome default initial tab). Prevents "No Chrome tabs found" on cold start.

### Security

- **SonarCloud: Log injection vulnerability (1 alert)** — `bin/launch.mjs` no longer logs the raw WebSocket debugger URL (user-controlled data). Replaced with a static "WebSocket URL received" message to prevent query/URL content from leaking into logs.

### Code Quality

- **SonarCloud batch fixes (~52 issues resolved)** across 16 source files:
  - `S7781` — Replaced 18 `String#replace()` calls with `String#replaceAll()` for global replacements (regex → literal where applicable).
  - `S1128` — Removed 15 unused imports (`dirname`, `join`, `relative`, `spawn`, `tmpdir`, `existsSync`, `shouldUseBrowser`, `closeTabs`, `cdp`, `openNewTab`, `closeTab`, `activateTab`, `trimText`).
  - `S7773` — Migrated 11 `parseInt`/`parseFloat` calls to `Number.parseInt`/`Number.parseFloat`.
  - `S7780` — Wrapped 8 CDP eval templates containing backslash sequences in `String.raw()` to eliminate double-escaping.
  - `S7735` — Eliminated 13 negated-condition ternaries by inverting the conditional logic (`!== -1 ? ... : null` → `=== -1 ? null : ...`).

### Security Hotspot Review

- **SonarCloud: 20 security hotspots reviewed and marked Safe** — All outstanding hotspots were assessed and resolved in SonarCloud:
  - `S4721` OS Command Injection (×2) — Inputs are hardcoded (`port=9222`) or parsed from system output and validated via `Number.parseInt`. Not user-controlled.
  - `S5852` Regex ReDoS (×10) — Regexes operate on bounded input with negated char classes or short fixed patterns. No practical denial-of-service risk.
  - `S4036` PATH environment variable (×8) — Local CLI extension spawning package-internal Node scripts. PATH is host-controlled; no untrusted input reaches the command.

### Tooling

- **SonarCloud configuration** — Added `sonar-project.properties` with exclusions for `test/**`, `test.mjs`, `test.sh`, `test_unit.mjs`, and `scripts/**` so test-only code does not skew source quality metrics.

## v1.8.5 (2026-04-29)

### Security

- **CodeQL: Incomplete URL substring sanitization (6 alerts)** — Replaced loose `includes()` / `endsWith()` checks on raw URL strings with proper hostname parsing in `src/github.mjs`, `src/reddit.mjs`, `src/fetcher.mjs`, and `extractors/bing-copilot.mjs`. Prevents bypasses where arbitrary subdomains could spoof trusted domains (e.g. `evilgithub.com`, `reddit.com.evil.com`).
- **CodeQL: Resource exhaustion (1 alert)** — `cdp loadall` now bounds `intervalMs` to 100–30,000ms to prevent unbounded `setTimeout` durations from untrusted CLI input.
- **CodeQL: Missing workflow permissions (2 alerts)** — Added explicit `permissions: contents: read` blocks to `.github/workflows/ci.yml` and `.github/workflows/mirror-to-claude.yml`, limiting `GITHUB_TOKEN` scope to the minimum required.

### Dependencies

- **Dependabot security updates** — Bumped `basic-ftp`, `yaml`, `brace-expansion`, `protobufjs`, `fast-xml-parser`, and `@mozilla/readability` to latest patched versions.

### Tests

- **GitHub fetch test fixes** — Corrected ES module import paths and added `'all'` mode to test block conditions so cross-platform test runs pass cleanly.

## v1.8.4 (2026-04-27)

### Fixes

- **Double-escaped enum params (issue #2)** — `pi-coding-agent` v0.70.2 wraps string enum values in extra quotes (e.g. `"all"` → `"\"all\""`) before validation, causing `greedy_search`, `deep_research`, and `coding_task` to reject every call with a validation error. Fixed by switching `engine`, `depth`, and `mode` parameters from strict `Type.Union([Type.Literal(...)])` to `Type.String()` (so the call passes validation), then stripping the extra quotes in each handler via a shared `stripQuotes()` utility.

### Tests

- **Unit tests added** — `node test.mjs unit` runs 13 fast, Chrome-free tests covering `stripQuotes` and param normalization for all affected tools. Included in `quick` and `smoke` modes.
- **CI now runs unit tests** — GitHub Actions workflow runs `node test.mjs unit` after install on all three OS targets (ubuntu, windows, macos).

## v1.8.3 (2026-04-24)

### Fixes

- **Perplexity extraction fixed** — The copy button selector was returning the first matching button ("Copy question") instead of the answer copy button. Changed `.find()` to `.filter().pop()` to get the last matching button, which correctly copies the answer text. Fixes `--full` flag returning only the query text instead of the full answer.

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

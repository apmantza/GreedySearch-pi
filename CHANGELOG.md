# Changelog

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

# Changelog

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

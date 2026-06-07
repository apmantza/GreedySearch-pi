---
name: greedy-search
description: Web/search plus opt-in research via Perplexity, Google AI, ChatGPT, Gemini, Semantic Scholar, and Logically. Grounded all-engine search fetches sources by default; optional configurable synthesis; deep research as separate workflow. Configurable via ~/.pi/greedyconfig. Bing Copilot available for signed-in users. Current docs, recent changes, dependency choices. NOT codebase search.
---

`greedy_search({ query, engine: "all"|"perplexity"|"google"|"chatgpt"|"gemini"|"semantic-scholar"|"logically"|"bing", synthesize?: bool, synthesizer?: "gemini"|"chatgpt", depth?: "research", breadth: 1-5, iterations: 1-3, maxSources: 3-12, researchOutDir?: string, writeResearchBundle?: bool, visible: bool })`

**Modes:** individual engine search · grounded `engine:"all"` search with fetched sources · optional `synthesize:true` using the configured synthesizer over all-engine results · `depth:"research"` for the iterative deep-research workflow.

**Config:** `~/.pi/greedyconfig` supports `{ "engines": ["perplexity", "google", "chatgpt", "gemini", "semantic-scholar", "logically"], "synthesizer": "gemini" }`. Gemini is a normal search engine; Semantic Scholar and Logically are opt-in research engines. Any configured engine can participate in `engine:"all"`; deep research child searches reuse the same configured `engines` list and stdin-safe query passing. Normal all-search synthesis remains controlled separately by `synthesizer`; research planning/final synthesis uses Gemini.

**Compatibility:** legacy `depth:"fast"|"standard"|"deep"` is still accepted. `fast` skips source fetching; `standard`/`deep` alias `synthesize:true`. Prefer `synthesize:true`, optional `synthesizer`, and `depth:"research"` going forward.

**Research output:** `depth:"research"` writes a dataroom-style bundle by default under `.pi/greedysearch-research/<timestamp>_<query>/` with `STATUS.md`, `OUTLINE.md`, `reports/SUMMARY.md`, `reports/CLAIMS.md`, `reports/GAPS.md`, `sources/`, and `data/manifest.json`. Pass `researchOutDir` to choose the directory or `writeResearchBundle:false` to disable disk output.

**Auto-recovery:** Headless default. Bing/Perplexity auto-retry visible on CF block. Manual CAPTCHA → visible stays open; solve then rerun.

**CDP safety:** Use `bin/cdp-greedy.mjs` only. Never raw `bin/cdp.mjs`.

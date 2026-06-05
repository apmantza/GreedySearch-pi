---
name: greedy-search
description: Web search via Perplexity, Google AI & Gemini. Bing Copilot available for signed-in users. Current docs, recent changes, dependency choices. NOT codebase search.
---

`greedy_search({ query, engine: "all"|"perplexity"|"google"|"gemini"|"bing", depth: "fast"|"standard"|"deep"|"research", breadth: 1-5, iterations: 1-3, maxSources: 3-12, researchOutDir?: string, writeResearchBundle?: bool, visible: bool })`

**Depth:** `fast`(15-30s, no synthesis) · `standard`(30-90s, all+synthesis+sources) · `deep`(60-180s, stronger grounding) · `research`(centerpiece; iterative planning + direct URL fetches + follow-ups + deterministic floor checks + citation audit + structured bundle)

**Research output:** `depth:"research"` writes a dataroom-style bundle by default under `.pi/greedysearch-research/<timestamp>_<query>/` with `STATUS.md`, `OUTLINE.md`, `reports/SUMMARY.md`, `reports/CLAIMS.md`, `reports/GAPS.md`, `sources/`, and `data/manifest.json`. Pass `researchOutDir` to choose the directory or `writeResearchBundle:false` to disable disk output.

**Auto-recovery:** Headless default. Bing/Perplexity auto-retry visible on CF block. Manual CAPTCHA → visible stays open; solve then rerun.

**CDP safety:** Use `bin/cdp-greedy.mjs` only. Never raw `bin/cdp.mjs`.

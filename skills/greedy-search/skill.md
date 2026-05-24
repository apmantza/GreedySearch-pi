---
name: greedy-search
description: Live web search via Perplexity, Bing, Google AI, and Gemini. Use for current docs, recent errors/framework changes, dependency choices, or stale-knowledge questions. NOT for codebase search.
---

Use `greedy_search` for live web answers.

```js
greedy_search({ query: "React 19 changes", depth: "standard" });
```

**Params:** `query` (required), `engine`: `all`|`perplexity`|`bing`|`google`|`gemini`, `depth`: `fast`|`standard`|`deep`|`research`

**Depths:**
- `fast`: ~15-30s, single engine, no synthesis
- `standard`: ~30-90s, all engines + Gemini synthesis + sources
- `deep`: ~60-180s, stronger grounding + confidence metadata
- `research`: slowest, iterative query planning + follow-up searches + learning extraction; optional `breadth` 1-5, `iterations` 1-3, `maxSources` 3-12

**Blocks:** Headless by default; auto-retries in visible mode. If human verification is needed, visible Chrome stays open — tell the user to solve it and rerun.

**CDP safety:** Never call raw `bin/cdp.mjs`. Use `bin/cdp-greedy.mjs`, `bin/cdp-visible.mjs`, or `bin/cdp-headless.mjs`.

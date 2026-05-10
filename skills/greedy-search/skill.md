---
name: greedy-search
description: Live web search via Perplexity, Bing, Google AI, and Gemini. Use for current docs, recent errors/framework changes, dependency choices, or stale-knowledge questions. NOT for codebase search.
---

Use `greedy_search` for live web answers.

```js
greedy_search({ query: "React 19 changes", depth: "standard" });
```

**Params:** `query` (required), `engine`: `all`|`perplexity`|`bing`|`google`|`gemini`, `depth`: `fast`|`standard`|`deep`, `fullAnswer`, `visible`/`alwaysVisible`/`headless: false`

**Depths:**

- `fast`: ~15-30s, single engine, no synthesis
- `standard`: ~30-90s, all engines + Gemini synthesis + sources
- `deep`: ~60-180s, stronger grounding + confidence metadata

**Captcha/blocks:** Headless by default. Bing/Perplexity auto-retry in visible mode when blocked. If human verification is needed, visible Chrome stays open — tell the user to solve it and rerun. Use `visible: true` proactively for repeated issues.

**Pi commands:** `/greedy-visible`, `/greedy-status`, `/greedy-kill`, `/set-greedy-locale`

**CDP safety:** Never call raw `bin/cdp.mjs`. Use `bin/cdp-greedy.mjs`, `bin/cdp-visible.mjs`, or `bin/cdp-headless.mjs`.

Old `coding_task`/`deep_research` folded into `greedy_search`. Use `engine: "gemini"` for one-off opinion, `depth: "deep"` for research.

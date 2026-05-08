---
name: greedy-search
description: Live web search via Perplexity, Bing, Google AI, and Gemini. Use for current docs, recent errors/framework changes, dependency choices, or stale-knowledge questions. NOT for codebase search.
---

# GreedySearch

Use `greedy_search` for live web answers.

```js
greedy_search({ query: "React 19 changes", depth: "standard" });
```

Params:

- `query` required
- `engine`: `all` default, `perplexity`, `bing`, `google`, `gemini`
- `depth`: `fast`, `standard` default, `deep`
- `fullAnswer`: true for untruncated output
- `visible` / `alwaysVisible`: true to force visible Chrome
- `headless`: false is equivalent to visible mode

Depths:

- `fast`: quick, no synthesis/source fetch
- `standard`: all engines + Gemini synthesis + top sources
- `deep`: stronger grounded synthesis/confidence

Captcha/verification:

- Headless is default.
- Bing and Perplexity auto-retry in visible Chrome when blocked, including fast mode.
- If human verification is needed, visible Chrome stays open; tell the user to solve it and rerun.
- Use visible mode proactively for repeated captcha/login/cookie issues:

```js
greedy_search({ query: "test Bing", engine: "bing", visible: true });
```

Pi commands:

- `/greedy-visible`
- `/greedy-status`
- `/greedy-kill`
- `/set-greedy-locale`

CDP safety: never call raw `bin/cdp.mjs`; it can attach to main Chrome. Use:

- `node bin/cdp-greedy.mjs list`
- `node bin/cdp-visible.mjs list`
- `node bin/cdp-headless.mjs list`

Old `coding_task` / `deep_research` were folded into `greedy_search`. Use `engine: "gemini"` for one second opinion or `depth: "deep"` for grounded research.

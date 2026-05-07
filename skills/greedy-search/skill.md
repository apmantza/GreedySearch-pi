---
name: greedy-search
description: Live web search via Perplexity, Bing, and Google AI in parallel. Use for library docs, recent framework changes, error messages, dependency selection, or anything where training data may be stale. NOT for codebase search.
---

# GreedySearch — Live Web Search

Runs Perplexity, Bing Copilot, and Google AI in parallel. Gemini synthesizes results.

## greedy_search

```
greedy_search({ query: "React 19 changes", depth: "standard" })
```

| Parameter                   | Type    | Default      | Description                                     |
| --------------------------- | ------- | ------------ | ----------------------------------------------- |
| `query`                     | string  | required     | Search question                                 |
| `engine`                    | string  | `"all"`      | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `depth`                     | string  | `"standard"` | `fast`, `standard`, `deep`                      |
| `fullAnswer`                | boolean | `false`      | Full answer vs ~300 char summary                |
| `headless`                  | boolean | `true`       | Set `false` to use visible Chrome               |
| `visible` / `alwaysVisible` | boolean | `false`      | Force visible Chrome for this search            |

| Depth      | Engines | Synthesis       | Source Fetch | Time    |
| ---------- | ------- | --------------- | ------------ | ------- |
| `fast`     | 1       | —               | —            | 15-30s  |
| `standard` | 3       | Gemini          | top 5        | 30-90s  |
| `deep`     | 3       | grounded Gemini | top 5        | 60-180s |

**When engines agree** → high confidence. **When they diverge** → note both perspectives.

## Visibility / captcha guidance

Headless is the default. If Bing or Perplexity hits verification, GreedySearch retries in visible Chrome automatically, including `fast` mode. If the challenge needs a human, the browser is left open; solve it and rerun the same search.

Use visible mode proactively when an engine repeatedly asks for captcha/login/cookies:

```
greedy_search({ query: "test Bing", engine: "bing", visible: true })
```

Inside Pi, users can also run:

- `/greedy-visible` — launch visible GreedySearch Chrome
- `/greedy-status` — show Chrome status
- `/greedy-kill` — stop GreedySearch Chrome

CDP safety for agents: do **not** run raw `bin/cdp.mjs` manually because it can fall back to the user's main Chrome. Use GreedySearch-safe wrappers instead:

- `node bin/cdp-visible.mjs list` — attach only if GreedySearch Chrome is visible
- `node bin/cdp-headless.mjs list` — attach only if GreedySearch Chrome is headless
- `node bin/cdp-greedy.mjs list` — attach to either GreedySearch mode
- `node bin/kill-visible.mjs` — force-stop visible GreedySearch Chrome

## Deep / second-opinion usage

The old `coding_task` and `deep_research` tools were folded into `greedy_search`.
Use `engine: "gemini"` for a single second opinion, or `depth: "deep"` for grounded multi-engine research.

```
greedy_search({ query: "debug race condition in Node streams", engine: "gemini", fullAnswer: true })
greedy_search({ query: "best current fix for React hydration mismatch", depth: "deep" })
```

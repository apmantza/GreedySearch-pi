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

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search question |
| `engine` | string | `"all"` | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `depth` | string | `"standard"` | `fast`, `standard`, `deep` |
| `fullAnswer` | boolean | `false` | Full answer vs ~300 char summary |

| Depth | Engines | Synthesis | Source Fetch | Time |
|-------|---------|-----------|--------------|------|
| `fast` | 1 | — | — | 15-30s |
| `standard` | 3 | Gemini | — | 30-90s |
| `deep` | 3 | Gemini | top 5 | 60-180s |

**When engines agree** → high confidence. **When they diverge** → note both perspectives.

## coding_task

Second opinion from Gemini/Copilot on hard problems.

```
coding_task({ task: "debug race condition", mode: "debug", engine: "gemini" })
```

| Parameter | Type | Default | Options |
|-----------|------|---------|---------|
| `task` | string | required | — |
| `engine` | string | `"gemini"` | `gemini`, `copilot`, `all` |
| `mode` | string | `"code"` | `debug`, `plan`, `review`, `test`, `code` |
| `context` | string | — | Code snippet |

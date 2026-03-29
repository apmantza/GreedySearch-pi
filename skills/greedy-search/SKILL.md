---
name: greedy-search
description: Multi-engine AI web search — greedy_search, deep_research, and coding_task. Use for high-quality research where training data may be stale or single-engine results are insufficient.
---

# GreedySearch Tools

| Tool | Speed | Use For |
|------|-------|---------|
| `greedy_search` | 15-90s | Quick lookups, current info |
| `deep_research` | 60-120s | Architecture decisions, source-backed research |
| `coding_task` | 60-180s | Debug, review, plan modes for hard problems |

## greedy_search

Multi-engine AI search (Perplexity, Bing, Google).

```greedy_search({ query: "React 19 changes", engine: "all" })```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search question |
| `engine` | string | `"all"` | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `synthesize` | boolean | `false` | Gemini synthesis (+30s, higher quality) |
| `fullAnswer` | boolean | `false` | Complete vs ~300 char summary |

**When to use:** Current info, version changes, comparisons, debugging errors.  
**vs web_search:** Slower but higher quality — 3 engines cross-verify.

**Engine Selection:**
- `all` (default): 30-90s, highest confidence
- `perplexity`: 15-30s, technical Q&A
- `bing`: 15-30s, recent news
- `google`: 15-30s, broad coverage
- `gemini`: 15-30s, different training data

## deep_research

Comprehensive research with source fetching and synthesis.

```deep_research({ query: "RAG vs fine-tuning tradeoffs" })```

Returns: Full answers + Gemini synthesis + deduplicated sources (ranked by consensus [3/3, 2/3, 1/3]) + fetched content from top sources.

**When to use:** Research that matters — library comparisons, architecture decisions, source-backed confidence.

## coding_task

Browser-based coding assistant via Gemini/Copilot.

```coding_task({ task: "debug race condition", mode: "debug", engine: "gemini" })```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | Coding task/question |
| `engine` | string | `"gemini"` | `gemini`, `copilot`, `all` |
| `mode` | string | `"code"` | `debug`, `plan`, `review`, `test`, `code` |
| `context` | string | — | Code snippet to include |

**Modes:**
- `debug`: Stuck on tricky bug — fresh eyes catch different failure modes
- `plan`: Big refactor coming — Gemini plays devil's advocate
- `review`: High-stakes code review before merge
- `test`: Edge cases the author missed
- `code`: Simple generation (but you're probably faster)

**When to use:** Second opinions on hard problems. Skip for simple code.

## Interpreting Results

- **All 3 agree** → High confidence, present as fact
- **2 agree, 1 differs** → Likely correct, note the dissent
- **All differ** → Present different perspectives
- **Sources [3/3] or [2/3]** → Cited by multiple engines, higher confidence

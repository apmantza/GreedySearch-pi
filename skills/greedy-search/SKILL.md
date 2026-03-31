---
name: greedy-search
description: Multi-engine AI **WEB SEARCH** tool — NOT for codebase search. Use greedy_search for high-quality web research where training data may be stale or single-engine results are insufficient. Searches Perplexity, Bing, Google via browser automation. NO API KEYS needed.
---

# ⚠️ WEB SEARCH ONLY — NOT CODEBASE SEARCH

**`greedy_search` searches the live web**, not your local codebase.

| Tool | Searches |
|------|----------|
| `greedy_search` | **Live web** (Perplexity, Bing, Google) |
| `ast_grep_search` | **Local codebase** — use this for code patterns |
| `bash` with `grep/rg` | **Local codebase** — use this for text search |

**DO NOT use `greedy_search` for:**
- Finding functions in your codebase
- Searching local files
- Code review of your project
- Understanding project structure

**DO use `greedy_search` for:**
- Library documentation
- Recent framework changes
- Error message explanations
- Best practices research
- Current events/news

# GreedySearch Tools

| Tool | Speed | Use For |
|------|-------|---------|
| `greedy_search` | 15-180s | Multi-engine search with depth levels |
| `coding_task` | 60-180s | Debug, review, plan modes for hard problems |

## greedy_search

Multi-engine AI search (Perplexity, Bing, Google) with three depth levels.

```greedy_search({ query: "React 19 changes", depth: "standard" })```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | Search question |
| `engine` | string | `"all"` | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `depth` | string | `"standard"` | `fast`, `standard`, `deep` — see below |
| `fullAnswer` | boolean | `false` | Complete vs ~300 char summary |

### Depth Levels

| Depth | Engines | Synthesis | Source Fetch | Time | Use When |
|-------|---------|-----------|--------------|------|----------|
| `fast` | 1 | ❌ | ❌ | 15-30s | Quick lookup, single perspective |
| `standard` | 3 | ✅ | ❌ | 30-90s | Default — balanced speed/quality |
| `deep` | 3 | ✅ | ✅ (top 5) | 60-180s | Research that matters — architecture decisions |

**Standard** (default): Runs 3 engines, deduplicates sources, synthesizes via Gemini.  
**Deep**: Same + fetches content from top sources for grounded synthesis + confidence scores.

### Engine Selection (for fast mode)

```greedy_search({ query: "...", engine: "perplexity", depth: "fast" })```

- `perplexity`: Technical Q&A, citations
- `bing`: Recent news, Microsoft ecosystem
- `google`: Broad coverage
- `gemini`: Different training data

### Examples — Web Research Only

**✅ GOOD — Web research:**
```greedy_search({ query: "what changed in React 19", depth: "fast" })```
```greedy_search({ query: "best auth patterns for SaaS", depth: "deep" })```
```greedy_search({ query: "Prisma vs Drizzle 2026", depth: "standard", fullAnswer: true })```

**❌ WRONG — Don't use for codebase search:**
```javascript
// DON'T: Searching your own codebase
// greedy_search({ query: "find UserService class" })  // ❌ Won't find it!

// DO: Use these instead for codebase search:
// ast_grep_search({ pattern: "class UserService", lang: "typescript" })
// bash({ command: "rg 'class UserService' --type ts" })
```

### Legacy

`deep_research` tool still works — aliases to `greedy_search` with `depth: "deep"`.

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
- `debug`: Tricky bugs — fresh eyes catch different failure modes
- `plan`: Big refactor — plays devil's advocate on risks
- `review`: High-stakes code review before merge
- `test`: Edge cases the author missed
- `code`: Simple generation (but you're probably faster)

**When to use:** Second opinions on hard problems. Skip for simple code.

## Result Interpretation

- **All 3 engines agree** → High confidence, present as fact
- **2 agree, 1 differs** → Likely correct, note dissent
- **Sources [3/3] or [2/3]** → Multiple engines cite, higher confidence
- **Deep research confidence scores** → Structured confidence metadata

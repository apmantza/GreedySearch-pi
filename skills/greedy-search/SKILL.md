---
name: greedy-search
description: Multi-engine AI web search — greedy_search, deep_research, and coding_task. Use for high-quality research where training data may be stale or single-engine results are insufficient.
---

# GreedySearch Tools

## Tool Overview

| Tool | Speed | Use for |
|------|-------|---------|
| `greedy_search` | 15-90s | Quick lookups, comparisons, debugging errors |
| `deep_research` | 60-120s | Architecture decisions, thorough research, source-backed answers |
| `coding_task` | 60-180s | Second opinions on code, reviews, debugging tricky issues |

## When to Use Which

- **`greedy_search`** — Default. Fast enough for most things. Use when you need current info.
- **`deep_research`** — When the answer *matters*. Gives you a structured document with confidence scores, deduplicated sources ranked by consensus, Gemini synthesis, AND actual content from top sources.
- **`coding_task`** — When you need a "second opinion" on hard problems. Best for `debug` and `plan` modes on tricky issues.

---

# greedy_search

Multi-engine AI web search with streaming progress.

```greedy_search({ query: "what changed in React 19", engine: "all" })```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | string | required | The search question |
| `engine` | string | `"all"` | `all`, `perplexity`, `bing`, `google`, `gemini` |
| `synthesize` | boolean | `false` | Synthesize via Gemini |
| `fullAnswer` | boolean | `false` | Complete answer vs ~300 char summary |

**When to use:** Quick lookups, error messages, comparing tools, "what's new in X".

---

# deep_research

Comprehensive research with source fetching and synthesis. Returns a structured document.

```deep_research({ query: "RAG vs fine-tuning for production" })```

Returns:
- Full answers from all 3 engines (Perplexity, Bing, Google)
- Gemini synthesis combining all perspectives
- Deduplicated sources ranked by consensus (3/3 > 2/3 > 1/3)
- Fetched content from top 5 sources (no CDP — uses native fetch)
- Confidence metadata (which engines responded, consensus score)

**When to use:** Architecture decisions, "which library should I use", research for a writeup, anything where you need source-backed confidence.

---

# coding_task

Browser-based coding assistant using Gemini and/or Copilot.

```coding_task({ task: "debug this race condition", mode: "debug", engine: "all" })```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `task` | string | required | The coding task/question |
| `engine` | string | `"gemini"` | `gemini`, `copilot`, or `all` |
| `mode` | string | `"code"` | See modes below |
| `context` | string | — | Code snippet to include |

**Modes:**

| Mode | Use when |
|------|----------|
| `debug` | Stuck on a tricky bug. Fresh eyes catch different failure modes. |
| `plan` | About to refactor something big. Gemini plays devil's advocate. |
| `review` | Code review before merge. High-stakes code benefits from second opinion. |
| `test` | Need edge cases the author missed. |
| `code` | Just need the code written (but you can probably do this yourself faster). |

**When to use:** Debugging tricky issues, planning major refactors, security-critical reviews. **Skip for** simple code generation — you're faster.

## Greedy Search vs Built-in Web Search

| | `web_search` | `greedy_search` |
|---|---|---|
| Speed | Instant (~2s) | 15-60s (one engine) / 30-90s (all engines) |
| Quality | Good for simple lookups | Higher — 3 AI engines cross-verify |
| Synthesis | Single engine answer | Optional Gemini synthesis (cleanest answer) |
| Use for | Quick facts, simple questions | Research, decisions, complex topics |

**Rule of thumb:** Use `web_search` for quick facts. Use `greedy_search` when the answer matters — architecture decisions, comparing libraries, understanding new releases, debugging tricky errors.

## When to Use

- **Version-specific changes** — "What changed in React 19?" / "Breaking changes in FastAPI 0.100"
- **Choosing between tools** — "Prisma vs Drizzle in 2026" / "Best auth library for Next.js 15"
- **Debugging** — User pastes an error message or stack trace
- **Research tasks** — When you need to synthesize information from multiple sources
- **Best practices** — "How to structure a monorepo" / "Auth patterns for SaaS"
- **Anything where training data might be stale** — 2025+, 2026+, "latest", "current", "still maintained"

## Engine Selection

```greedy_search({ query: "what changed in React 19", engine: "all" })```

| Engine | Latency | Best for |
|---|---|---|
| `all` (default) | 30-90s | Highest confidence — all 3 engines in parallel |
| `perplexity` | 15-30s | Technical Q&A, code explanations, documentation |
| `bing` | 15-30s | Recent news, Microsoft ecosystem |
| `google` | 15-30s | Broad coverage, multiple perspectives |
| `gemini` | 15-30s | Google's perspective, different training data |

Use a single engine when speed matters and the question isn't contentious.

## Synthesis Mode

For complex research questions, use `synthesize: true` with `engine: "all"`:

```greedy_search({ query: "best auth patterns for SaaS in 2026", engine: "all", synthesize: true })```

This deduplicates sources across engines and feeds them to Gemini for one clean, synthesized answer. Adds ~30s but produces the highest quality output — ideal for research tasks where you'd otherwise need to parse 3 separate answers.

Use synthesis when:
- You need one definitive answer, not multiple perspectives
- You're researching a topic to write about or make a decision
- The question has a lot of noise and you want the signal

Skip synthesis when:
- You want to see where engines disagree (useful for controversial topics)
- Speed matters

## Full vs Short Answers

Default mode returns ~300 char summaries to save tokens. Use `fullAnswer: true` when you need the complete response:

```greedy_search({ query: "explain the React compiler", engine: "perplexity", fullAnswer: true })```

## Interpreting Results

- **All 3 agree** → High confidence, present as fact
- **2 agree, 1 differs** → Likely correct but note the dissent
- **All differ** → Present the different perspectives to the user
- **Sources with `[3/3]` or `[2/3]`** → Cited by multiple engines, higher confidence

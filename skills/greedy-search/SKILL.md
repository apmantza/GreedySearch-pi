---
name: greedy-search
description: Multi-engine AI web search — Perplexity, Bing Copilot, Google AI in parallel with optional Gemini synthesis. Use for high-quality research where training data may be stale or single-engine results are insufficient.
---

# Greedy Search

Use `greedy_search` when you need high-quality, multi-perspective answers from the web.

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

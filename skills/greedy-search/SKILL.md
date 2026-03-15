---
name: greedy-search
description: Multi-engine AI web search — Perplexity, Bing Copilot, Google AI in parallel. Use for current library docs, error messages, version diffs, and any research where training data may be stale.
---

# Greedy Search Skill

Use the `greedy_search` tool when you need current information from the web.

## When to Use

- Questions about libraries, APIs, or frameworks — especially version-specific
- User pastes an error message or stack trace
- Question contains "latest", "current", "2025", "2026", "deprecated", "still recommended"
- Choosing between dependencies or tools
- Architecture validation or best-practice confirmation
- Any research question where training data may be stale

## How to Use

Call `greedy_search` with the user's question as `query`. Use `engine: "all"` (default) to fan out to all three engines in parallel for the highest-confidence answer.

```
greedy_search({ query: "how to use X in Y version", engine: "all" })
```

For quick lookups where one source is sufficient:
- `engine: "perplexity"` — best for technical Q&A
- `engine: "bing"` — best for recent news and Microsoft ecosystem
- `engine: "google"` — best for broad coverage

## Interpreting Results

Each engine returns an AI-synthesized answer plus sources. Where all three agree, confidence is high. Where they diverge, present both perspectives to the user.

## Requirements

Chrome must be running. The extension auto-launches a dedicated GreedySearch Chrome instance if needed (via `launch.mjs`).

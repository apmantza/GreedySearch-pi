# Usage Guide

GreedySearch registers one Pi tool: `greedy_search`.

## Common Calls

```js
greedy_search({ query: "React 19 changes" });
greedy_search({ query: "React 19 changes", synthesize: true });
greedy_search({ query: "Prisma vs Drizzle", engine: "perplexity" });
greedy_search({ query: "What is Redis?", depth: "research", maxSources: 5 });
```

## Parameters

### Common

- `query` — required search/research question.
- `fullAnswer` — return complete engine output instead of a preview.
- `headless` — defaults to `true`; set to `false` to show Chrome.
- `visible` / `alwaysVisible` — force visible Chrome for this run.

### Normal Search

- `engine` — `all` by default. Supported individual engines:
  `perplexity`, `google`, `chatgpt`, `gemini`, `semantic-scholar`,
  `logically`, and `bing`.
- `synthesize` — for `engine: "all"`, synthesize fetched sources with the
  configured synthesizer.
- `synthesizer` — `gemini` or `chatgpt`.
- `depth` — legacy `fast` / `standard` / `deep` aliases are still accepted;
  prefer `synthesize` for normal search.

### Research

- `depth: "research"` — run the iterative research workflow.
- `breadth` — actions per round, 1-5.
- `iterations` — rounds, 1-3.
- `maxSources` — fetched source cap, 3-12.
- `researchOutDir` — custom bundle directory.
- `writeResearchBundle` — write the bundle to disk; default `true`.

## Search Modes

- **Individual engine** — calls one engine and returns its answer/sources.
- **Grounded all-engine search** — fans out to configured engines, ranks
  sources, fetches top source content, and returns confidence metadata.
- **All + synthesis** — adds a synthesis pass over engine answers and fetched
  source evidence.
- **Research** — runs planning, searches, source fetching, learning extraction,
  citation audit, and bundle writing.

## Configuration

Configure all-engine fan-out and synthesis in `~/.pi/greedyconfig`:

```json
{
  "engines": ["perplexity", "google", "chatgpt", "gemini"],
  "synthesizer": "gemini"
}
```

`semantic-scholar` and `logically` are opt-in research engines. They remain
available as individual engines and can be added to `engines` when you want them
in normal `engine: "all"` fan-out.

Deep research child searches reuse the configured `engines` list and pass query
text through stdin to avoid leaking prompts in process arguments.

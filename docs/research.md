# Research Mode

Set `depth: "research"` to run GreedySearch's iterative research workflow.

```js
greedy_search({
  query: "Evaluate browser automation options for AI agents",
  depth: "research",
  breadth: 3,
  iterations: 2,
  maxSources: 8,
});
```

## Workflow

Research mode performs:

1. Query complexity classification when breadth/iterations are not explicit.
2. Action planning with Gemini.
3. Fast all-engine child searches using the configured engine list.
4. Direct URL fetches when useful.
5. Source ranking, dedupe, and source-content fetching.
6. Evidence and learning extraction.
7. Final cited synthesis.
8. Citation audit, URL reachability checks, and deterministic floor checks.

Simple questions may take a single-pass path. Explicit `breadth` or
`iterations` values always override classifier suggestions.

## Bundle Layout

Research bundles are written by default under
`.pi/greedysearch-research/<timestamp>_<query>/`.

```text
STATUS.md              # floor status, question ledger, and gaps
OUTLINE.md             # bundle table of contents
provenance.md          # run metadata and verification summary
reports/SUMMARY.md     # final cited report
reports/CLAIMS.md      # claims mapped to source IDs
reports/EVIDENCE.md    # extracted source evidence
reports/GAPS.md        # caveats and remaining uncertainties
sources/               # fetched source markdown files
data/manifest.json     # metadata, stop reason, floor checks, citation audit
data/rounds.json       # per-round actions/learnings/gaps
data/sources.json      # ranked source registry
data/questions.json    # open/closed question ledger
data/evidence.json     # structured evidence per useful source
```

## CLI

```bash
node bin/search.mjs all --inline --stdin --depth research \
  --breadth 3 --iterations 2 --max-sources 8 <<'EOF'
Evaluate browser automation options for AI agents
EOF

node bin/search.mjs all --inline --stdin --depth research \
  --research-out-dir ./research-topic <<'EOF'
Topic
EOF

node bin/search.mjs all --inline --stdin --depth research \
  --no-research-bundle <<'EOF'
Topic
EOF
```

## Verification

The provenance sidecar records:

- sources consulted, fetched, and cited;
- primary/official source counts;
- citation audit status;
- citation URL reachability;
- floor checks and overall status.

Bot-protected or HEAD-disallowing hosts are skipped in URL reachability rather
than marked dead when they return common anti-bot statuses such as 403.

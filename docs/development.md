# Development

## Project Layout

- `index.ts` — Pi extension entrypoint.
- `src/tools/greedy-search-handler.ts` — Pi tool registration/handler.
- `bin/search.mjs` — CLI orchestration.
- `extractors/` — engine-specific browser automation.
- `src/search/` — search pipeline, Chrome lifecycle, recovery, synthesis,
  source ranking, and research orchestration.
- `test.mjs`, `test-suite/`, `test/` — unit and smoke tests.

Pi loads this extension through `jiti`; TypeScript does not need to be
precompiled for Pi runtime.

## Checks

```bash
npm run check:lockfile
npm run lint
node test.mjs unit
npm pack --dry-run --json
```

Jiti load check:

```bash
node - <<'NODE'
import { createJiti } from 'file:///C:/Users/R3LiC/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs';
const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import('./index.ts');
console.log('jiti ok', typeof mod.default);
NODE
```

## Useful Headless Smoke Checks

```bash
node bin/launch.mjs --kill || node bin/kill-visible.mjs
node bin/search.mjs all --inline --stdin --full <<'EOF'
TypeScript 5.8 5.9 Node.js ESM module-resolution changes
EOF

node bin/search.mjs all --inline --stdin --depth research \
  --breadth 1 --iterations 1 --max-sources 3 <<'EOF'
Node.js native TypeScript type stripping for CLI authors
EOF
```

## Extractor Notes

When adding or changing an extractor:

1. Reuse `extractors/common.mjs` utilities.
2. Prefer single in-browser polling evals over Node-side CDP polling loops.
3. Use language-agnostic selectors and data attributes where possible.
4. Avoid matching English UI strings except as a last resort.
5. Register new engines in both `src/search/constants.mjs` and `bin/search.mjs`
   when they need all-mode pre-seeding.
6. Update `README.md`, `docs/`, `src/tools/greedy-search-handler.ts`, and
   `CHANGELOG.md`.

See [`AGENTS.md`](../AGENTS.md) for the full extractor and recovery guide.

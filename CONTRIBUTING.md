# Contributing to GreedySearch

Thanks for your interest in GreedySearch. Most contributions are small,
focused changes. Read [AGENTS.md](./AGENTS.md) first for project context,
design goals, and runtime conventions.

## Quick links

- [AGENTS.md](./AGENTS.md) — architecture, stealth/recovery policy, testing
- [README.md](./README.md) — concise project overview and install instructions
- [docs/usage.md](./docs/usage.md) — user-facing tool parameters and modes
- [docs/runtime.md](./docs/runtime.md) — runtime commands and Chrome/CDP safety
- [CHANGELOG.md](./CHANGELOG.md) — release history (add an `[Unreleased]` entry)

## Setup

```bash
git clone https://github.com/apmantza/GreedySearch-pi
cd GreedySearch-pi
npm install
npm test unit
```

Node.js 20.11.0+ and a working Chrome install are required for the full
test suite. `npm test unit` runs without Chrome.

## Code style

- Tab-indented JavaScript (matching existing files). TypeScript files in
  `src/tools/` and `index.ts` are pre-transpiled via jiti by Pi — no
  build step is needed.
- All extractors are plain Node ESM scripts (`.mjs`) and import from
  `./common.mjs` and `./consent.mjs`.
- Prefer language-agnostic DOM signals (`data-testid`, `data-*`,
  `aria-*`, OAuth endpoint URLs) over matching English text.
- Never leak query text in process arguments — read it from stdin with
  the `--stdin` flag (`prepareArgs`/`parseArgs` already do this).
- SonarCloud hotspots: avoid ReDoS-prone regex (`[^\]]*` patterns);
  reuse the linear `indexOf` scan style in `parseSourcesFromMarkdown*`.

## Adding a new extractor

The fastest path is to copy `extractors/semantic-scholar.mjs` (smallest
example) and adapt the search URL, result-row selector, and answer
formatter. Engines are wired in three places:

1. **The extractor script** — `extractors/<engine>.mjs`.
   - Import shared helpers from `./common.mjs`:
     `cdp`, `getOrOpenTab`, `waitForSelector`, `waitForStreamComplete`,
     `injectClipboardInterceptor`, `parseArgs`, `prepareArgs`,
     `validateQuery`, `formatAnswer`, `outputJson`, `logStage`,
     `buildEnvelope`, `handleError`.
   - Import from `./consent.mjs` if your engine shows a cookie banner
     or Cloudflare/Copilot verification: `dismissConsent`,
     `handleVerification`.
   - Always emit a result envelope via `buildEnvelope({ engine, mode, ... })`
     on both success and error paths. The orchestrator parses
     `_envelope.lastStage`, `_envelope.mode`, and `_envelope.durationMs`
     for timeouts and recovery decisions.
   - Use `logStage(env, "stage-name", startTime)` at every meaningful
     transition. The wrapper's `60–80s` budget assumes stages like
     `nav`, `consent`, `verification`, `input-wait`, `type-and-submit`,
     `stream-wait`, `extract`.
   - Prefer **single-eval stream/selector waits** (see
     `waitForStreamComplete`/`waitForSelector`) over Node-side polling.
     Under 3+ parallel extractors, CDP contention makes Node polling
     time out.
   - If your engine uses a copy-to-clipboard answer, inject
     `injectClipboardInterceptor(tab, "__myClipboard")` before clicking
     the copy button, then read `window.__myClipboard` via `cdp(["eval", …])`.

2. **Engine registration** in `src/search/constants.mjs`:
   - Add a `ENGINES["<name>"] = "<name>.mjs"` entry (and any aliases).
   - Add a `ENGINE_DOMAINS["<name>"] = "host.tld"` entry.
   - Research/academic engines are opt-in: leave them out of
     `DEFAULT_ENGINES` unless they should participate in normal casual
     `engine: "all"` searches, and document adding them to
     `~/.pi/greedyconfig.engines` in `docs/usage.md`.

3. **Pre-seeded homepage** in `bin/search.mjs` (`ENGINE_START_URLS`):
   - If the engine has a useful starting page (so extractors can
     skip the initial navigation), add an entry to
     `ENGINE_START_URLS`. Skip for engines that always navigate
     fresh from a query URL.

4. **Headless → visible recovery** (optional) in
   `src/search/recovery.mjs`:
   - Add the engine name to `HEADLESS_RECOVERY_ENGINES` if it benefits
     from automatic visible-mode retry on Cloudflare/captcha blocks
     (Perplexity, Bing, ChatGPT, Logically all do).
   - The wrapper picks up the new engine name automatically because
     `bin/search.mjs` maps extractor scripts to engine names via the
     same `ENGINES` map.

5. **Tests**:
   - Add a unit test in `test.mjs` (search for `research config` /
     `synthesizer` for the current pattern).
   - Add a live smoke check in the AGENTS.md “Useful live smoke
     checks” section so future agents can re-verify the extractor
     after selector breakage.

6. **Docs**:
   - Add an `[Unreleased]` entry to `CHANGELOG.md`.
   - Update the engine list in `README.md`, `docs/usage.md`, and the Pi
     tool description/schema in `src/tools/greedy-search-handler.ts`.

## PR checklist

- [ ] `npm test unit` passes (80+ tests).
- [ ] At least one live smoke run (visible or headless) per
      `AGENTS.md` → “Useful live smoke checks”.
- [ ] `lens_diagnostics` on changed files: no new warnings beyond
      the pre-existing cyclomatic-complexity advisories on
      `greedy-search-handler.ts`.
- [ ] `CHANGELOG.md` updated under `[Unreleased]`.
- [ ] Tool description/schema and docs mention the new engine.

## Reporting issues

Open an issue on GitHub. For headless-vs-visible behavior, attach
the most recent `greedysearch-visible-recovery.jsonl` entry from
`<tmp>/greedysearch-visible-recovery.jsonl` (queries are never
written to this log).

## License

By contributing, you agree that your contributions will be licensed
under the MIT License.

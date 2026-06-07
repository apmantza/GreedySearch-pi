# GreedySearch-pi Agent Guide

GreedySearch-pi is a Pi package/extension that registers the `greedy_search` tool. It automates a dedicated Chrome instance on port `9222` and queries AI/search engines through browser automation (Perplexity, Bing Copilot, Google AI, Gemini).

## Design goals

- **Headless-first with visible fallback** — Headless is the default for speed and resource efficiency. When Cloudflare/Turnstile blocks an engine in headless, automatic visible recovery establishes cookies in the shared Chrome profile, then switches back to headless. Subsequent searches benefit from the cached session. Recovery applies to Bing, Perplexity, and ChatGPT (Google intentionally excluded).
- **Speed optimizations** — All extractors use tight timeouts: 20s navigation, 10s verification retry (Turnstile never clears in headless, so longer retries are waste), 600ms post-nav settle. Engine budgets are 30s (fast) / 55s (standard) to account for CDP contention from parallel extractors. Solo times: Google 9s, ChatGPT 8s, Perplexity 13s, Gemini 14s, Bing 16s.
- **Resilient synthesis** — When one engine fails (even with manual verification), synthesis continues with the engines that succeeded. Source-fetch workers catch individual errors — a single bad URL won't crash the batch.
- **Iterative research mode** — `depth: "research"` / `--depth research` performs a deep-research loop: plan focused queries, run fast multi-engine searches, fetch/dedupe sources, extract compact learnings/gaps/follow-ups with Gemini, and synthesize a final cited report. It should remain no-API-key and reuse GreedySearch engines/fetchers; do not reintroduce Firecrawl/OpenAI dependencies from the reference implementation.
- **Stealth where it matters** — `Page.addScriptToEvaluateOnNewDocument` patches are awaited for Bing tabs (Copilot's Cloudflare blocks headless without them), but fire-and-forget for Perplexity/Google (Perplexity's anti-bot detects the aggressive canvas/console patches). Tabs are created blank → stealth injected → extractor navigates, ensuring stealth is active before page load. Keep Bing-oriented patches Chrome-like: `navigator.webdriver` should be `undefined`, patched functions should stringify as native code, canvas noise should be stable per page (not random per call), and navigator plugins/mimeTypes/mediaDevices/userAgentData should stay internally consistent with the launch UA.

## Read the skill first

Before changing behavior or using the tool, read:

- `skills/greedy-search/skill.md`

That skill documents how agents should call `greedy_search`, including `visible: true` / `alwaysVisible: true` for captcha/login/cookie situations.

## Pi extension/runtime context

- Pi loads extension TypeScript through jiti. Do **not** assume `.ts` files need precompiled `.js` output for Pi runtime.
- `package.json` exposes this package via:
  - `pi.extensions: ["./index.ts"]`
  - `pi.skills: ["./skills"]`
- The main extension entrypoint is `index.ts`.
- Tool registration lives in `src/tools/greedy-search-handler.ts`.
- CLI orchestration lives in `bin/search.mjs`.
- Engine extractors live in `extractors/`.

## Dedicated Chrome only — never pollute main Chrome

GreedySearch uses its own Chrome profile under the OS temp directory:

- profile: `<tmp>/greedysearch-chrome-profile`
- port: `9222`
- mode marker: `<tmp>/greedysearch-chrome-mode`

Agents must not call raw `bin/cdp.mjs` manually unless `CDP_PROFILE_DIR` is explicitly set to the GreedySearch profile. Prefer the safe wrappers:

```bash
node bin/cdp-greedy.mjs list      # any GreedySearch mode
node bin/cdp-visible.mjs list     # refuses unless GreedySearch Chrome is visible
node bin/cdp-headless.mjs list    # refuses unless GreedySearch Chrome is headless
```

Chrome lifecycle helpers:

```bash
node bin/visible.mjs              # launch visible GreedySearch Chrome
node bin/visible.mjs --status
node bin/visible.mjs --kill       # strong visible/port cleanup
node bin/kill-visible.mjs         # same strong cleanup path
node bin/launch.mjs --headless
node bin/launch.mjs --kill
```

Inside Pi, user-facing commands are registered:

- `/greedy-visible`
- `/greedy-status`
- `/greedy-kill`
- `/set-greedy-locale`

## Headless vs visible behavior

Headless is the default. Visible mode can be forced per call:

```js
greedy_search({ query: "test", engine: "bing", visible: true });
greedy_search({ query: "test", engine: "bing", alwaysVisible: true });
greedy_search({ query: "test", engine: "bing", headless: false });
```

CLI equivalents:

```bash
node bin/search.mjs bing "test" --fast --visible
node bin/search.mjs bing "test" --fast --always-visible
```

Global env:

```bash
GREEDY_SEARCH_ALWAYS_VISIBLE=1
GREEDY_SEARCH_VISIBLE=1
```

## Research mode

Research mode lives in `src/search/research.mjs` and is orchestrated from `bin/search.mjs` before the normal `engine === "all"` path.

Usage:

```js
greedy_search({ query: "topic", depth: "research", breadth: 3, iterations: 2, maxSources: 8 });
```

```bash
node bin/search.mjs all --inline --stdin --depth research --breadth 3 --iterations 2 --max-sources 8 <<'EOF'
topic
EOF
```

Important behavior:

- Research child searches must use `--stdin`; never leak query text in process args.
- Child-search stderr is intentionally filtered in `runFastAllSearch()` so page CSS/HTML cannot flood Pi output. Preserve `PROGRESS:*`, `[greedysearch]`, and extractor diagnostic lines only.
- Social/login-wall sources are low-quality citations. `src/search/sources.mjs` applies a −20 `smartScore` penalty to `SOCIAL_HOSTS` entries (facebook, linkedin, x.com, etc.) AND a hard post-sort guardrail that pins all social sources below non-social ones. The composite score formula is `smartScore*3 + engineCount*5 + priority*2 + max(0, 7-rank)`. With the −20 penalty plus the hard guardrail, a social source cannot land as S1 even if it scores highly on every other axis.
- Academic sources (arxiv.org, semanticscholar.org, doi.org) are first-class. `pickAcademicFetchTargets()` in `src/search/research.mjs` injects a `fetchUrl` action for the top academic source when `combinedSources` contains one and no round action is already a `fetchUrl`. This forces PDF/academic content to be fetched and synthesized.
- The open-question ledger is capped at `MAX_OPEN_FOLLOWUPS = 5` per round. Overflow "Discovered gap/follow-up" questions are auto-resolved with evidence rather than carried forward, keeping the floor check (`computeResearchFloor.requiredQuestions`) meaningful.
- If Gemini under-plans fewer queries than requested breadth, deterministic fallback angles fill the breadth (official docs/GitHub, benchmarks/limitations, alternatives/use-cases, anti-bot/rendering caveats). Keep this so `breadth` remains meaningful.
- Per-round learning failures should be captured in `_research.rounds[].learningError` instead of aborting the whole run.

## Recovery policy

Recovery helpers live in `src/search/recovery.mjs`.

Current automatic headless → visible recovery applies to **Bing** and **Perplexity** only. Google is intentionally not included unless requested.

Recovery triggers include timeout, verification/captcha/Cloudflare/Turnstile, missing input, ask-input, clipboard/copy failures.

Important behavior:

- `engine: "all"` retries blocked Bing/Perplexity in visible mode.
- Single-engine `engine: "bing"` and `engine: "perplexity"` also retry visible when blocked.
- Recovery can run even in `fast` mode because a blocked search otherwise returns no result.
- If manual verification is needed, leave visible Chrome open and return a clear rerun instruction instead of killing the browser.

## Engine notes

### Bing Copilot

Bing is the most fragile engine — Copilot's Cloudflare/Turnstile aggressively blocks headless Chrome.

Known behaviors:

- Headless may be Cloudflare/Turnstile blocked or sandboxed in nested iframes.
- The copy button exists in the DOM before React hydrates its click handler — a race that causes empty clipboard interception. Fixed with an 800ms hydration delay after `waitForCopyButton`.
- `Page.addScriptToEvaluateOnNewDocument` stealth must be **awaited** before the extractor navigates to Copilot. Fire-and-forget means Cloudflare sees headless fingerprints during the initial page load.
- Visible mode can render an answer even when clipboard interception is empty.
- `extractors/bing-copilot.mjs` therefore uses:
  1. copy button readiness wait + 800ms hydration delay,
  2. copy + clipboard polling,
  3. retry copy + polling,
  4. visible DOM text fallback,
  5. iframe/headless block detection fallback.

Do not “fix” Bing by only adding a larger fixed sleep; prefer readiness/polling/fallbacks. If Bing suddenly starts forcing visible recovery, first run a single headless smoke (`node bin/search.mjs bing --inline --stdin --fast`) and inspect `_envelope.blockedBy`, `_envelope.verificationResult`, and `_envelope.durationMs` before changing timeouts.

### Perplexity

Perplexity uses clipboard interception and a language-agnostic copy-button finder. It also participates in headless → visible recovery.

Important: Perplexity's anti-bot system **detects** the aggressive stealth patches (canvas noise, console monkey-patching, CDP Runtime guard). Use fire-and-forget stealth for Perplexity — the basic flags (`--disable-blink-features=AutomationControlled`, `navigator.webdriver` suppression) are sufficient. Tabs are pre-seeded via `Target.createTarget` rather than CDP `Page.navigate`, which is less detectable.

### Google

Google AI Mode is not currently in automatic visible recovery. Respect this unless explicitly asked to change it.

### ChatGPT

ChatGPT participates in headless → visible recovery because the typed query can succeed in headless while the assistant response never streams in (Cloudflare does not block, but the response just does not arrive under tab throttling). The visible-recovery path establishes a working session and caches cookies.

Two subtle bugs to know about when modifying the extractor:

1. **Static homepage greeting card** — chatgpt.com has a pre-rendered `[data-message-author-role="assistant"]` greeting ("Hello! How can I help you today?") with `data-turn-start-message="true"` that lives on the page before any conversation happens. All stream-wait and DOM-extract code must find the assistant message that comes AFTER the last user message in DOM order, not the absolute last assistant element. The old 50-char `_minLen` threshold was a safety margin for this card; after the greeting-card skip is in place, `waitForStreamComplete(..., { minLength: 1 })` is safe and short answers like "Hello! 👋" (8 chars) no longer burn the full timeout.

2. **Copy button on the wrong target** — `document.querySelectorAll('[data-testid="copy-turn-action-button"]')[buttons.length - 1]` picks the absolute last copy button on the page. When the assistant response is still empty (0 chars) it has no copy button of its own, so the last button is the USER message's copy button — clicking it copies the user's query into the clipboard interceptor and the extractor returns it as a "successful" answer. Find the copy button on the assistant message specifically, and if none exists, click nothing (the DOM fallback handles it).

`extractors/chatgpt.mjs` uses:
- `waitForStreamComplete(tab, { minLength: 1, timeout: 20000, ... })` from `common.mjs` — the same shared helper Perplexity and Gemini use.
- 15s node-side fallback (`pollForResponseNodeSide`) for throttled `all`-mode tabs where the in-browser poll is clamped to 1Hz.
- A DOM fallback that reads the assistant message's innerText (skipping the static greeting card by finding the message after the last user message).
- `extractAnswer` throws `blockedBy: "no-response"` when the assistant message never renders content.

### Gemini

Gemini uses a Material Design icon-based copy button (`button:has(mat-icon[data-mat-icon-name="copy"])`). The page has many copy icons (copy link, copy code, etc.), so the absolute last copy button is not always the assistant's response copy button.

`extractors/gemini.mjs` therefore:
1. Waits for the `model-response` custom element to have content > 20 chars (not just the locale-specific "Gemini said" / "Το Gemini είπε" label).
2. Clicks the copy button on the `model-response` element specifically.
3. Falls back to the `model-response` innerText if the clipboard contains the user's query (echoed-query detection) or is empty.

The same `[data-message-author-role]`-style "find the response after the last user message" pattern used by ChatGPT would not work on Gemini because Gemini does not use `data-message-author-role` attributes — it uses custom elements `<user-query-content>` and `<model-response>`.

## Tests and smoke checks

Fast automated checks:

```bash
npm test unit
node - <<'NODE'
import { createJiti } from 'file:///C:/Users/R3LiC/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs';
const jiti = createJiti(import.meta.url, { interopDefault: true });
const mod = await jiti.import('./index.ts');
console.log('jiti ok', typeof mod.default);
NODE
npm pack --dry-run --json
```

Useful live smoke checks:

```bash
node bin/search.mjs perplexity --inline --stdin --fast --visible <<'EOF'
hello world smoke test
EOF

node bin/search.mjs bing --inline --stdin --fast --visible <<'EOF'
hello world smoke test
EOF

node bin/launch.mjs --kill || node bin/kill-visible.mjs
node bin/search.mjs bing --inline --stdin --fast <<'EOF'
hello world headless smoke test
EOF

node bin/search.mjs all --inline --stdin --depth research --breadth 1 --iterations 1 --max-sources 3 <<'EOF'
What is Lightpanda browser and when should AI agents use it?
EOF
```

Safe CDP smoke:

```bash
node bin/visible.mjs
node bin/cdp-visible.mjs list
node bin/cdp-headless.mjs list  # should refuse while visible
node bin/visible.mjs --kill

node bin/launch.mjs --headless
node bin/cdp-headless.mjs list
node bin/cdp-visible.mjs list   # should refuse while headless
node bin/launch.mjs --kill
```

## Release workflow

Releases are fully automated via `.github/workflows/release.yml`. The flow mirrors pi-lens's release pattern and turns a `package.json` version bump into a git tag, GitHub release, and (optionally) an npm publish with no manual steps beyond the initial commit.

### Cutting a release

1. **Bump version** in `package.json` (e.g. `1.9.2` → `2.0.0`).
2. **Add a CHANGELOG entry** under `## [X.Y.Z] — YYYY-MM-DD` in `CHANGELOG.md`. Move content from the `[Unreleased]` section into the new version section (the `[Unreleased]` section should be empty after the bump). The release workflow's `prepare` job greps for `^## \[$VERSION\]` and fails the release if the entry is missing.
3. **Run local checks** before pushing:
   ```bash
   npm run check:lockfile  # package.json ↔ package-lock.json sync
   npm run lint            # node --check on all .mjs files
   node test.mjs unit      # 86+ unit tests
   ```
4. **Commit and push to master** with a clear conventional message (e.g. `release: 2.0.0`).

### What the CI does on push to master

- **`lint-and-lockfile` job** (Ubuntu, runs first): executes `check:lockfile` + `lint`. Must pass before `install-test` runs.
- **`install-test` job** (matrix: ubuntu/windows/macos, needs `lint-and-lockfile`): packs the tarball, verifies all `pi.extensions` / `pi.skills` / `files` entries exist in it, installs globally, runs unit tests, and runs `npx jiti ./index.ts` to catch missing dependencies. The `pi-coding-agent` peer-dep absence is expected and ignored.
- **`release` workflow** (runs in parallel with CI, triggered by every push to master):
  - **`prepare` job**: detects the new version by checking that the tag `vX.Y.Z` doesn't exist, verifies the CHANGELOG entry, runs `npm publish --dry-run` (if `NPM_TOKEN` is set). Outputs `should_release` and `has_npm_token` for the downstream jobs.
  - **`release` job** (needs `prepare`, runs only if `should_release == 'true'`): creates the git tag `vX.Y.Z`, pushes it, creates a GitHub release with auto-generated notes via `softprops/action-gh-release@v3`.
  - **`publish-npm` job** (needs `prepare` + `release`, runs only if `should_release && has_npm_token`): runs `npm publish` with `NODE_AUTH_TOKEN` from the `NPM_TOKEN` secret.

### Release gating

- The `release` workflow is triggered by every push to master, but only acts if the tag `vX.Y.Z` doesn't already exist. To re-run a failed release, delete the tag locally and remotely (`git tag -d vX.Y.Z && git push origin :refs/tags/vX.Y.Z`) and re-push.
- `NPM_TOKEN` is **optional**. Without it, the release creates a tag and GitHub release but skips `npm publish`. This is useful for testing the release flow without actually publishing, or for repos that don't publish to npm.
- The CI must pass (`lint-and-lockfile` + `install-test`) for the release to be considered healthy, but the `release` workflow itself doesn't gate on CI status — it runs on every master push. If you push a broken commit, the release will still try; rely on the local pre-push checks to catch issues first.

### Manual release

You can also trigger the release workflow manually via the GitHub Actions UI (`workflow_dispatch`). This is useful for re-running a failed release or cutting a release from a non-master branch.

### Versioning guidelines

- **Patch** (`X.Y.Z`): bug fixes, internal refactors, CI changes, dependency updates. The release workflow's auto-generated notes work best for these.
- **Minor** (`X.Y.0`): new features, new extractors, new research engines, new tool parameters. CHANGELOG entries should be detailed.
- **Major** (`X.0.0`): breaking changes to the `greedy_search` tool API, major extractor rewrites, or any change that requires user action to upgrade. CHANGELOG entries should call out migration steps explicitly.

The current version is in `package.json`. The release workflow prints it in the `prepare` job's logs.

## Common pitfalls

- Do not use raw `node bin/cdp.mjs list`; it can attach to the user's main Chrome.
- Do not remove `--stdin` query handling; it prevents query leakage in process lists.
- Do not assume normal `node import('./index.ts')` represents Pi runtime; Pi uses jiti.
- Do not add Google to visible recovery unless explicitly requested.
- Do not reintroduce stale `coding_task` / `deep_research` tool docs; those were folded into `greedy_search`.

## Creating a new extractor

When adding a new engine (e.g. `extractors/chatgpt.mjs`), follow these patterns proven across Perplexity, Bing, Gemini, and ChatGPT:

### 1. Reuse `common.mjs` utilities

Import `cdp`, `getOrOpenTab`, `injectClipboardInterceptor`, `waitForSelector`, `waitForStreamComplete`, `buildEnvelope`, `handleError`, `formatAnswer`, `outputJson`, `parseArgs`, `prepareArgs`, `validateQuery` from `./common.mjs`. Do **not** write raw CDP spawn logic.

### 2. Use clipboard interception for source extraction

Inject `navigator.clipboard.writeText` via `injectClipboardInterceptor(tab, GLOBAL_VAR)`, click the engine's copy button, then read `window.GLOBAL_VAR`. This captures the engine's native markdown output including source links. Add a reference-style link parser (`parseSourcesFromMarkdownRefStyle`) if the engine uses `[text][1]` + `[1]: url "title"` format.

### 3. Single-eval stream wait (critical for `all` mode)

**Never** poll the DOM from Node.js with `while (Date.now() < deadline) { await cdp(["eval", ...]); await sleep(800) }`. Under CDP contention from 3+ parallel extractors, your 800ms poll becomes 5-10s real-time and you timeout.

Instead, fire **one** `Runtime.evaluate` with `awaitPromise: true` that contains the entire polling loop inside the browser. Examples:

- `waitForStreamComplete(tab, { selector: "document.body" })` — monitors text length stability
- Custom single-eval promise that polls copy-button count and resolves when stable

This is the difference between ChatGPT timing out at 60s (Node polling) and finishing in 8s (single-eval + shared `waitForStreamComplete`).

### 4. Language-agnostic selectors

Never match on English text (`innerText.includes("Sign in")`). Use:
- Data attributes (`data-testid`, `data-mat-icon-name`)
- DOM structure (`div.ProseMirror`, `textarea[name="prompt-textarea"]`)
- OAuth endpoint URLs in `href` (`login.microsoftonline.com`)

### 5. Register in two places

1. `src/search/constants.mjs` — add to `ENGINES` (with aliases) and `ENGINE_DOMAINS`
2. `bin/search.mjs` — add to `ENGINE_START_URLS` if it should be pre-seeded in `all` mode

### 6. Headless fast-fail for anti-bot

If the engine is Cloudflare-protected, add a snap/accessibility-tree check at the top of `extractAnswer` when `GREEDY_SEARCH_HEADLESS === "1"`. Fast-fail immediately (return error) so `search.mjs` can trigger visible recovery instead of burning the full timeout.

### 7. Add to `HEADLESS_RECOVERY_ENGINES` if needed

If the engine blocks headless and benefits from visible cookie caching, add it to `HEADLESS_RECOVERY_ENGINES` in `src/search/recovery.mjs`.

### 8. Update docs

- `README.md` — engine list
- `skills/greedy-search/skill.md` — skill description
- `src/tools/greedy-search-handler.ts` — tool `description` and `engine` parameter schema
- `CHANGELOG.md` — under `[Unreleased]`

## Extractor timeout budgets

All extractors share these timeouts (kept tight — solo runs complete in 9-16s):

| Step                | Timeout                                    | Notes                                                          |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Navigation          | 20s                                        | CDP `Page.navigate` → `loadEventFired` → `readyState:complete` |
| Post-nav settle     | 600ms                                      | React hydration buffer                                         |
| Verification retry  | 10s                                        | Turnstile never clears in headless; longer = waste             |
| Input selector wait | 8-15s                                      | In-browser polling, no CDP traffic                             |
| Stream completion   | 20s (Perplexity/ChatGPT in-browser) + 15s (ChatGPT node-side fallback), 60s (Bing), 90s (Gemini) | Single `Runtime.evaluate` with in-browser poll loop. ChatGPT uses the shared `waitForStreamComplete` with `minLength: 1` (greeting-card skip lets us drop the old 50-char threshold). |
| Engine hard kill    | 30s fast / 55s standard                    | `runExtractor` spawn timeout; accounts for CDP contention      |

CDP daemon internal `TIMEOUT`: **90s** (must exceed longest `Runtime.evaluate` call).

# GreedySearch-pi Agent Guide

GreedySearch-pi is a Pi package/extension that registers the `greedy_search` tool. It automates a dedicated Chrome instance on port `9222` and queries AI/search engines through browser automation (Perplexity, Bing Copilot, Google AI, Gemini).

## Design goals

- **Headless-first with visible fallback** — Headless is the default for speed and resource efficiency. When Cloudflare/Turnstile blocks an engine in headless, automatic visible recovery establishes cookies in the shared Chrome profile, then switches back to headless. Subsequent searches benefit from the cached session. Recovery only applies to Bing and Perplexity (Google intentionally excluded).
- **Speed optimizations** — All extractors use tight timeouts: 20s navigation, 10s verification retry (Turnstile never clears in headless, so longer retries are waste), 600ms post-nav settle. Engine budgets are 30s (fast) / 55s (standard) to account for CDP contention from parallel extractors. Solo times: Google 9s, Perplexity 13s, Gemini 14s, Bing 16s.
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
- Social/login-wall sources are low-quality citations. `src/search/sources.mjs` penalizes `facebook.com`, `linkedin.com`, `x.com`/`twitter.com`, etc. unless the query explicitly targets that platform.
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

## Changelog and release workflow

- Update `CHANGELOG.md` under `[Unreleased]` for notable changes.
- Run at least `npm test unit` and Pi/jiti extension import before committing.
- If Chrome behavior changed, run at least one live visible/headless smoke.
- Commit with a concise conventional message.

## Common pitfalls

- Do not use raw `node bin/cdp.mjs list`; it can attach to the user's main Chrome.
- Do not remove `--stdin` query handling; it prevents query leakage in process lists.
- Do not assume normal `node import('./index.ts')` represents Pi runtime; Pi uses jiti.
- Do not add Google to visible recovery unless explicitly requested.
- Do not reintroduce stale `coding_task` / `deep_research` tool docs; those were folded into `greedy_search`.

## Extractor timeout budgets

All extractors share these timeouts (kept tight — solo runs complete in 9-16s):

| Step                | Timeout                                    | Notes                                                          |
| ------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Navigation          | 20s                                        | CDP `Page.navigate` → `loadEventFired` → `readyState:complete` |
| Post-nav settle     | 600ms                                      | React hydration buffer                                         |
| Verification retry  | 10s                                        | Turnstile never clears in headless; longer = waste             |
| Input selector wait | 8-15s                                      | In-browser polling, no CDP traffic                             |
| Stream completion   | 60s (Bing), 20s (Perplexity), 90s (Gemini) | Single `Runtime.evaluate` with in-browser poll loop            |
| Engine hard kill    | 30s fast / 55s standard                    | `runExtractor` spawn timeout; accounts for CDP contention      |

CDP daemon internal `TIMEOUT`: **90s** (must exceed longest `Runtime.evaluate` call).

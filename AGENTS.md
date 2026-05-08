# GreedySearch-pi Agent Guide

GreedySearch-pi is a Pi package/extension that registers the `greedy_search` tool. It automates a dedicated Chrome instance on port `9222` and queries AI/search engines through browser automation (Perplexity, Bing Copilot, Google AI, Gemini).

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

Bing is the most fragile engine.

Known behaviors:

- Headless may be Cloudflare/Turnstile blocked or sandboxed in nested iframes.
- Visible mode can render an answer even when clipboard interception is empty.
- `extractors/bing-copilot.mjs` therefore uses:
  1. copy button readiness wait,
  2. copy + clipboard polling,
  3. retry copy + polling,
  4. visible DOM text fallback,
  5. iframe/headless block detection fallback.

Do not “fix” Bing by only adding a larger fixed sleep; prefer readiness/polling/fallbacks.

### Perplexity

Perplexity uses clipboard interception and a language-agnostic copy-button finder. It also participates in headless → visible recovery.

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

# Runtime and Chrome

GreedySearch uses a dedicated Chrome profile and debug port. It must not attach
to your normal Chrome profile.

- Profile: OS temp directory `greedysearch-chrome-profile`
- Port: `9222`
- Default mode: headless

## Pi Commands

```text
/greedy-visible      # launch visible Chrome for captcha/login/cookie setup
/greedy-status       # show GreedySearch Chrome status
/greedy-kill         # stop GreedySearch Chrome
/set-greedy-locale   # set default result language
```

## Environment Variables

- `GREEDY_SEARCH_VISIBLE` — set `1` to show Chrome instead of headless.
- `GREEDY_SEARCH_ALWAYS_VISIBLE` — set `1` to force visible mode for all runs.
- `GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES` — headless idle cleanup timeout;
  default `5`.
- `GREEDY_SEARCH_LOCALE` — default result language; default `en`.
- `CHROME_PATH` — Chrome/Chromium executable path; auto-detected by default.

## Runtime Helpers

Git install path:

```bash
GS=~/.pi/agent/git/github.com/apmantza/GreedySearch-pi
node "$GS/bin/launch.mjs" --status
node "$GS/bin/visible.mjs"
node "$GS/bin/visible.mjs" --kill
node "$GS/bin/kill-visible.mjs"
node "$GS/bin/cdp-visible.mjs" list
node "$GS/bin/cdp-headless.mjs" list
node "$GS/bin/cdp-greedy.mjs" list
```

npm global install path:

```bash
GS="$(npm root -g)/@apmantza/greedysearch-pi"
node "$GS/bin/launch.mjs" --status
node "$GS/bin/visible.mjs"
node "$GS/bin/visible.mjs" --kill
node "$GS/bin/kill-visible.mjs"
node "$GS/bin/cdp-visible.mjs" list
node "$GS/bin/cdp-headless.mjs" list
node "$GS/bin/cdp-greedy.mjs" list
```

## CDP Safety

Use only the safe wrappers for manual debugging:

- `bin/cdp-visible.mjs` — refuses unless GreedySearch Chrome is visible.
- `bin/cdp-headless.mjs` — refuses unless GreedySearch Chrome is headless.
- `bin/cdp-greedy.mjs` — attaches only to the GreedySearch Chrome profile.

Avoid raw `bin/cdp.mjs` unless `CDP_PROFILE_DIR` explicitly points at the
GreedySearch profile.

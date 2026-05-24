# Changelog

## [Unreleased]

### Added

- **Iterative research mode** (`bin/search.mjs`, `src/search/research.mjs`) — Added `--research` / `--depth research` and `greedy_search({ depth: "research" })`. The new mode plans focused follow-up queries, runs fast multi-engine searches, fetches and deduplicates sources, extracts compact learnings/gaps with Gemini, and writes a final cited report. Optional knobs: `breadth` (1-5), `iterations` (1-3), and `maxSources` (3-12). Research mode now fills under-planned breadth with deterministic fallback query angles so `breadth: 3` actually fans out even when Gemini is conservative.

### Fixed

- **Pi TUI peer import no longer required at load time** (`src/tools/greedy-search-handler.ts`) — Replaced the direct `@earendil-works/pi-tui` runtime import with a tiny local `Text` component implementation so Pi/jiti extension import works even when optional TUI peer packages are not installed locally.

- **Research source quality cleanup** (`src/search/sources.mjs`, `src/search/research.mjs`) — Social/login-wall domains (`facebook.com`, `linkedin.com`, `x.com`, etc.) now receive a strong ranking penalty unless the query explicitly targets that platform. Research source dedupe now uses the same composite score as normal source ranking, per-round learning extraction errors are recorded in `_research.rounds[].learningError`, child-search stderr forwarding is filtered so noisy page CSS/HTML cannot flood research logs, and markdown links in Gemini-generated follow-up queries are sanitized before search.

- **Bing headless stealth hardening** (`extractors/common.mjs`, `bin/launch.mjs`) — Adopted low-risk ideas from Obscura's stealth model: `navigator.webdriver` now resolves to `undefined` instead of `false`, navigator plugins/mimeTypes/mediaDevices/connection/pdfViewer/platform/vendor are made more Chrome-like, patched functions stringify as `[native code]`, canvas noise is stable per page instead of random on each call, and Chrome launches with `--lang=en-US` plus `--force-color-profile=srgb`. Live Bing headless smoke passed after the change without visible recovery.

## [1.9.1] — 2026-05-23

### Fixed

- **Visible Chrome launches minimized** (`bin/launch-visible.mjs`) — After Chrome's CDP endpoint becomes ready, `minimizeViaCDP` sends `Browser.setWindowBounds { windowState: "minimized" }` via the browser-level WebSocket. Chrome lands in the taskbar immediately instead of stealing focus from the user's active window. Closes [#20](https://github.com/apmantza/GreedySearch-pi/issues/20).

- **Recovery path always returns to headless** (`bin/search.mjs`) — After a visible-mode retry (triggered by Cloudflare blocking headless), the pipeline now unconditionally kills visible Chrome and relaunches headless before running Gemini synthesis. Previously the switch-back only happened when zero engines were recovered (`recovered === 0`), so a partial recovery left visible Chrome alive and caused synthesis to open the Gemini tab in the visible window.

- **ReDoS hotspots fixed** (`bin/launch.mjs`, `extractors/selectors.mjs`, `src/fetcher.mjs`, `src/search/sources.mjs`) — Four SonarCloud `javasecurity:S5852` hotspots resolved: (1) Chrome version directory regex bounded (`\d+` → `\d{1,10}` ×4 groups); (2) Perplexity citation name regex bounded (`\s+` → `\s{1,20}`, `[^.]+` → `[^.]{1,200}`); (3) seven suspicious-content regex patterns in `checkContentQuality` replaced with `String.includes` checks (faster and immune to backtracking on adversarial input); (4) trailing-slash removal regex bounded (`\/+$` → `\/{1,10}$`). Follow-up: string checks lowercased via a single `markdown.toLowerCase()` call to restore the case-insensitive matching the original regexes provided.

- **Collapsed tool rendering: consensus label fixed** (`src/tools/greedy-search-handler.ts`) — The collapsed summary was reading `synthesis.consensus` which does not exist in the schema; the field is `synthesis.agreement.level`. Collapsed view now correctly shows e.g. `→ Synthesized · 5 sources · high`.

- **`minimizeViaCDP` guard inverted in `launch.mjs`** (`bin/launch.mjs`) — The early-return guard was `if (isVisible()) return` which caused the function to exit immediately in the only case it was ever called (visible Chrome launch via `GREEDY_SEARCH_VISIBLE=1`). Changed to `if (isHeadless()) return`. Also removed the unnecessary 1s sleep (Chrome is already confirmed ready via `writePortFile()` before this is called) and applied the SonarCloud S8480 fix (`wsPath` extracted from `webSocketDebuggerUrl`, WebSocket URL reconstructed as `ws://localhost:${PORT}${wsPath}`).

- **Gemini tab no longer steals focus during synthesis** (`bin/search.mjs`) — Removed the `activateTab` call on the pre-navigated Gemini tab. `Target.activateTarget` was restoring the minimized Chrome window mid-search; CDP synthesis operates on the target ID directly and has no need for the tab to be Chrome's active tab.

### Changed

- **Result file auto-purge** (`src/search/output.mjs`) — On each search run, files older than 7 days are deleted from the results directory. The 10 most recent files are always kept regardless of age. Runs inside `resultsDir()` so it's transparent and zero-overhead.

- **`greedy_search` tool: collapsed rendering** (`src/tools/greedy-search-handler.ts`) — Added `renderCall` and `renderResult` hooks. The call line shows the query (truncated to 60 chars) and engine. The result collapses to a one-line summary: synthesis path shows source count + consensus label; single-engine path shows source count; human-verification path shows a warning. Full output is available via expand (Ctrl+O). Also migrated peer deps from `@mariozechner/pi-coding-agent` to `@earendil-works/pi-coding-agent` and added `@earendil-works/pi-tui` for the `Text` primitive.

- **Headless stealth hardening** (`bin/launch.mjs`, `extractors/common.mjs`) — Four fingerprinting gaps closed:
  - **UA version auto-detected** — `getChromeVersion` reads the versioned sub-directory inside the Chrome Application folder (e.g. `148.0.7778.168/`) to extract the real major version, then injects it into the `--user-agent` flag. Eliminates the TLS/UA mismatch that was caused by the hardcoded `Chrome/131` string (actual binary was `Chrome/148`).
  - **`navigator.userAgentData`** — Spoofed to match the detected UA version and remove any `HeadlessChrome` brand entry. `getHighEntropyValues()` returns consistent architecture, platform, and full version list.
  - **`window.outerWidth/Height`** — Patched from `0` (headless default) to mirror `innerWidth/Height`. A zero outer dimension is a well-known one-signal bot detector.
  - **`screen.colorDepth/pixelDepth`** — Ensured to report `24` when unset.
  - **GPU rendering re-enabled in headless** — Removed `--disable-gpu` and `--disable-software-rasterizer`. With `--headless=new`, Chrome uses hardware GPU acceleration (ANGLE/Direct3D on Windows), producing canvas and WebGL output identical to visible mode. Cloudflare Turnstile passes automatically on Perplexity without triggering visible-mode retry.

## [1.9.0] — 2026-05-22

### Added

- **Query normalization** (`src/search/query.mjs`, new) — Two universal transforms applied before every search, zero latency overhead:
  - **Preamble stripping**: removes agent-generated openers ("can you explain", "I need to know about", "tell me", etc.) that add noise without search signal. "Can you explain how the Rust borrow checker works?" → "how the Rust borrow checker works?"
  - **Recency anchoring**: appends the current year when the query contains explicit temporal language (`latest`, `current`, `recent`, `up-to-date`) but no version number or year is already present. "latest FastAPI best practices" → "latest FastAPI best practices 2026". Skipped when a version number like `3.13` or a year like `2024` is already in the query. No Google-specific keyword conversion — all three engines use AI modes that handle natural-language questions natively.

### Changed

- **Source ranking: composite score replaces cascading tiebreakers** (`src/search/sources.mjs`) — All ranking signals (query-domain boost, engine consensus, source type, best rank) now contribute simultaneously via a weighted formula: `smartScore×3 + engineCount×5 + sourceTypePriority×2 + max(0,7−rank)`. Previously rank was only a quaternary tiebreaker and was ignored whenever engines disagreed on a source — a site ranked #1 by one engine could lose to a site ranked #8 by two engines. Now rank is always a real signal.

- **Community penalty refined** (`src/search/sources.mjs`) — Discussion forums (Reddit, HN, Lobsters) now get a stronger penalty (−3) when preferred official domains exist. Q&A sites (StackOverflow, StackExchange) are explicitly excluded from any penalty — a top SO answer is often the best practical reference. Community blogs (Medium, Dev.to) get a mild −1 instead of the flat −2 that treated them identically to Reddit.

- **Synthesis prompt: structured JSON output + source snippets** (`src/search/synthesis.mjs`) — Prompt now explicitly requests JSON output wrapped in `BEGIN_JSON`/`END_JSON` markers with a concrete schema (`answer`, `agreement`, `differences`, `caveats`, `recommendedSources`). Previously the prompt asked for "a brief answer and key points", so `parseStructuredJson` always returned null and `agreement`, `differences`, `caveats`, `recommendedSources` were dead code on every search. Now all structured fields are populated. Source snippets (300 chars in standard mode, 700 in grounded) are always included in the source registry — previously only grounded mode got them — so Gemini can make citation decisions based on actual content rather than just domain metadata.

- **Gemini tab pre-navigated in parallel with source fetch** (`bin/search.mjs`, `extractors/gemini.mjs`) — In `all` mode, a Gemini tab is now opened and navigated to `gemini.google.com/app` concurrently with source fetching instead of sequentially after it. `gemini.mjs` skips the navigation if the tab is already on the Gemini domain (same pattern as Bing/Perplexity). Saves ~4s off synthesis start on every standard-depth `all` search.

- **Source fetch concurrency 4→5** (`src/search/constants.mjs`) — Default `SOURCE_FETCH_CONCURRENCY` increased from 4 to 5. With 5 top sources fetched per search, this runs all fetches in a single parallel batch instead of 4+1 sequential batches. Saves ~1s when any source in the first batch is slow (browser-fetched sources can take 3-4s each). Still overridable via `GREEDY_FETCH_CONCURRENCY` env var.

- **Bing copy-button wait 5s→2s** (`extractors/bing-copilot.mjs`) — `waitForCopyButton` timeout reduced from 5s to 2s. The Cloudflare snap check at the top of `extractAnswer` guarantees we only reach this point on a clean response, where the copy button appears within ~1s of stream completion. Saves up to 3s per Bing call.

### Fixed

- **Gemini lands in wrong frame context** (`bin/cdp.mjs`) — `captureMainContext` picked the first `isDefault` execution context after `Runtime.enable`, which for Gemini was the empty `_/bscframe` child iframe rather than the `app` main frame. All evals were running against an empty document, so `rich-textarea .ql-editor` was never found. Fixed by fetching the root frame ID from `Page.getFrameTree` and preferring the context whose `auxData.frameId` matches. Falls back to the old behaviour for sites with a single context. Fixes Gemini extraction on first cold start.

- **Bing Copilot CF headless fast-fail** (`extractors/bing-copilot.mjs`) — Cloudflare blocks the Copilot response iframe *after* query submission, not during navigation, so the extractor wasted ~18s polling the clipboard before `extractFromIframes` finally detected the challenge. Added an accessibility-tree snap check at the top of `extractAnswer` in headless mode that fast-fails immediately when a CF challenge is present. Headless failure time: ~27s → ~6s.

- **Perplexity Cloudflare headless detection** (`extractors/perplexity.mjs`) — Perplexity is CF-protected in headless just like Bing. Added the same early snap check before the input selector wait. Also added the post-verification settle + re-navigation block (matching Bing's flow) so the page has time to redirect from the CF challenge page to the real homepage before the input is searched for. Input `waitForSelector` timeout increased 5s → 15s to cover CF redirect + React hydration time. Added an explicit `!inputReady` throw instead of falling through to a confusing `cdp click` failure.

- **False-positive verification clicks at (0, 0)** (`extractors/consent.mjs`) — On Cloudflare challenge pages (Perplexity, Copilot), `VERIFY_DETECT_JS` matched hidden/unmounted elements whose `getBoundingClientRect` returned a zero rect. `humanClickElement` now skips elements with zero dimensions or (0, 0) center. `tryHumanClick` skips `{t:'xy'}` payloads with both coordinates at zero. Prevents clicks that "succeeded" but hit the wrong place and left the challenge loop believing it had cleared.

- **CF cookie persistence across Chrome restarts** (`src/search/chrome.mjs`) — Chrome was killed with `taskkill /F` (force-kill) before it could flush its SQLite cookie database, so `cf_clearance` cookies earned during visible recovery were lost on the next headless run. `killChrome` now sends `Browser.close` via the browser-level CDP WebSocket first, waits up to 1.5s for Chrome to exit gracefully (flushing cookies), then falls back to force-kill if still running. After a single human-solved Turnstile, subsequent headless runs reuse the cached cookie and skip the challenge entirely.

- **Browser-level OOPIF click for Turnstile** (`extractors/consent.mjs`) — Cloudflare Turnstile renders in a cross-origin OOPIF (`challenges.cloudflare.com`). Page-session `Input.dispatchMouseEvent` doesn't route into OOPIFs. `humanClickXY` now additionally fires the same click sequence via the browser-level CDP WebSocket (`/json/version` → `webSocketDebuggerUrl`), which routes through the top-level compositor and reaches the OOPIF — without attaching to the target (which would poison it). The page-level click is kept for regular elements; the browser-level click is a best-effort addition that never throws.

### Removed

- **`googlesearch` / `gs` engine** — Removed the `google-search` extractor (`extractors/google-search.mjs`) and its `googlesearch`/`gs` engine aliases from `ENGINES` in `constants.mjs`. The classic Google Search extractor was broken in headless mode and not part of the `"all"` fan-out.
- **`pplx` and `copilot` aliases** — Removed redundant engine aliases from `ENGINES` in `constants.mjs`. `pplx` was a longer alias for `perplexity` (shorter `p` exists) and `copilot` was an alias for `bing` (shorter `b` exists). Neither was documented in the tool schema or skill.

## [1.8.10] — 2026-05-11

### Removed

- **Dead `bing-aria` extractor** (`extractors/bing-aria.mjs`) — Removed the unused ARIA-tree-based Bing Copilot extractor and its `bing2` engine alias. Nothing in the system referenced it (`bing2` was not in `ALL_ENGINES`, not documented in the tool schema, and had no callers).

### Fixed

- **Perplexity sign-in mis-click** (`extractors/consent.mjs`) — `handleVerification` matched any button containing "continue", including "Continue with Google" OAuth buttons on Perplexity sign-in modals. This caused the automation to accidentally open Google/Microsoft login flows. Added explicit exclusions for `sign.in`, `log.in`, `google`, `microsoft`, `apple`, `facebook`, `github`, and `auth` text patterns in both `VERIFY_DETECT_JS` and `VERIFY_RETRY_JS`.

- **Gemini synthesis typing failure** (`extractors/gemini.mjs`) — `document.execCommand('insertText')` silently failed for long synthesis prompts (~8-10k chars), causing the extractor to submit an empty input and wait forever (45s stream + 180s timeout). Replaced with CDP `Input.insertText` + explicit focus click + content-length verification. Now fails fast with a clear error if text doesn't land.

- **Gemini answer extraction — query echo** (`extractors/gemini.mjs`) — When the assistant response copy button hadn't hydrated yet, clicking `buttons[buttons.length - 1]` hit the user's message copy button instead of Gemini's response, returning the query text as the "answer". Added wait for the assistant copy button to appear (2+ buttons on page), plus retry logic that detects exact query-text echo and re-clicks after a settle delay.

- **Bing Copilot Cloudflare auto-bypass** (`extractors/consent.mjs`) — Copilot's Turnstile challenge lives inside a **closed shadow DOM**, invisible to `document.querySelector('iframe')`. Added detection for the queryable host container (`#cf-turnstile`) and hidden response input (`[id^="cf-chl-widget-"]`), returning center coordinates for `humanClickXY`. During visible recovery, the challenge now auto-clicks and resolves transparently.

## [1.8.9] — 2026-05-11

### Changed

- **Halved Gemini synthesis timeout** (`extractors/gemini.mjs`) — `waitForStreamComplete` timeout reduced from 90s to 45s. Gemini synthesis prompts are ~8-10k chars and typically respond in 15-30s. The extra 45s was pure dead time.
- **Aligned Gemini extractor hard timeout** (`src/search/engines.mjs`) — reduced from 120s to 70s, matching the new 45s stream wait + ~25s nav/settle overhead.

### Fixed

- **Perplexity/Bing visible recovery now actually stores cookies** (`bin/search.mjs`) — Two issues fixed:
  1. **Second visible retry**: The first visible retry resolves Cloudflare/Turnstile (navigating through the challenge which breaks the CDP session with "Inspected target navigated or closed"), but the search never ran. A second retry on the same tab now reuses the freshly-cached Turnstile cookies and executes the actual search.
  2. **Keep Chrome alive on recovery success**: Previously Chrome was killed with `taskkill /F` after recovery, losing any pending cookie database writes. Now visible Chrome stays running when recovery succeeds (or needs human intervention), keeping the cookie session alive.
- **Visible Chrome window minimized after recovery** (`bin/search.mjs`) — When visible Chrome is left open after recovery (for cookie persistence or user verification), the window is automatically minimized so it doesn't clutter the desktop.

## [1.8.8] — 2026-05-09

### Added

- **`/set-greedy-locale` Pi command** (`index.ts`) — Set default locale for search results (e.g., `/set-greedy-locale de`, `/set-greedy-locale --clear`, `/set-greedy-locale --show`). Saves to `~/.config/greedysearch/config.json`.
- **Browser lifecycle defense patterns** (`src/search/browser-lifecycle.mjs`, new) — Centralized lifecycle management adopted from open-websearch's robust cross-process browser patterns:
  - **Structured JSON metadata** (`greedysearch-chrome-metadata.json`) replaces three scattered text files (PID, mode, activity) with a single file tracking `browserPid`, `debugPort`, `tempDir`, `clientPids[]`, `sessionMode`, `lastActivity`, `launchedAt`. Backward-compatible — legacy files still written.
  - **Process command-line verification** — `verifyBrowserProcess()` checks not just PID alive but that the process command line contains the profile dir and debug port. Prevents PID collision false-positives where a different process reuses the same PID.
  - **Cross-process launch lock** — `acquireLaunchLock()` uses exclusive-create (`wx` flag) to prevent concurrent `ensureChrome()` calls from racing to launch Chrome. Stale lock recovery after 15s.
  - **Stale session cleanup** — `cleanupStaleSessions()` runs once per process on first `ensureChrome()`. Scans metadata for dead PIDs, verifies survivors via command line, force-kills orphans, reclaims ghost processes on port 9222.
  - **Client PID tracking** — `registerClient`/`unregisterClient` track which processes share the Chrome instance.
- **Mode-specific idle timeouts** (`src/search/chrome.mjs`) — Headless Chrome keeps the aggressive 5-minute idle timeout (`GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES`) since it's cheap to restart. Visible Chrome (explicitly launched for captcha/cookie setup) gets a 60-minute grace period (`GREEDY_SEARCH_VISIBLE_IDLE_TIMEOUT_MINUTES`) to avoid wasting the user's captcha investment. Set either to 0 to disable for that mode.

### Added

- **System command path resolution** (`src/utils/system-cmds.mjs`, new) — `resolveSystemCmd()` resolves `powershell`, `netstat`, `taskkill`, `ps`, `lsof`, `ss`, `grep` to absolute paths for secure execution. `isPathSafe()` validates PATH environment variable composition. Satisfies SonarCloud security hotspot requirements for `execFileSync`/`execSync` PATH safety.

### Fixed

- **SonarCloud security hotspots — 15 resolved** — Addressed all flagged items:
  - **11 ReDoS-prone regex patterns**: Replaced greedy `.{0,50}` in fetcher's content quality check with lazy quantifier `.{0,50}?`; replaced alternation-heavy split regex in bing-copilot with `[^\S\n]*` horizontal whitespace; replaced `[\s\S]*` JSON extraction patterns in synthesis.mjs with `indexOf`/`lastIndexOf` brace matching; replaced `.+?\.` in selectors with `[^.]+`; replaced `\s+\S*$` trim patterns in sources.mjs, common.mjs, and content.mjs with `lastIndexOf` word-boundary detection; replaced markdown link regex in common.mjs with O(n) indexOf-based parser.
  - **4 PATH-injection hotspots in browser-lifecycle.mjs and chrome.mjs**: Created `resolveSystemCmd()` utility returning absolute paths for `powershell.exe`, `netstat.exe`, `taskkill.exe` (Windows) and `/usr/bin/ps`, `/usr/bin/lsof`, `/usr/sbin/ss`, `/usr/bin/grep` (Unix). Replaced all bare command names in `execFileSync`/`execSync` calls.

- **SonarCloud minor vulnerability false positives** — Confirmed both remaining issues are false positives (internal diagnostic logging in `bin/gschrome.mjs` and test debug output in `test/fetcher-cli.mjs`). Verified via full smoke test suite: all 33 unit tests pass, all 4 engines (Perplexity, Bing, Google, Gemini) return results at all depths (fast/standard/deep), CDP safety wrappers correctly enforce mode boundaries.

- **SonarCloud security hotspots** (re-verified) — All previously fixed hotspots remain resolved: replaced `spawn("node", ...)` with `spawn(process.execPath, ...)`, replaced `Math.random()` with `crypto.randomInt()`, 19 remaining hotspots confirmed as false positives (hardcoded `execSync` commands, simple regex patterns).

### Fixed

- **Headless→visible mode switching** (`src/search/chrome.mjs`) — `ensureChrome()` only handled the case where visible was requested but headless Chrome was running. When headless was requested (the default) but visible Chrome was running, it silently kept visible mode — causing env var mismatches that broke extractors like Perplexity. Now properly detects both directions and kills/relaunches in the correct mode.

- **SonarCloud security hotspots** — Replaced `spawn("node", ...)` with `spawn(process.execPath, ...)` in cdp wrapper, `runExtractor`, `synthesizeWithGemini`, and test helper to prevent PATH-based binary substitution. Replaced `Math.random()` with `crypto.randomInt()` in `jitter()` for non-security-sensitive timing variance. Remaining 19 hotspots are verified false positives (hardcoded `execSync` commands, simple regex patterns).
- **Bing stealth not active on page load** (`src/search/chrome.mjs`) — `injectHeadlessStealth` was fire-and-forget (`.catch(() => {})`). The CDP `Page.addScriptToEvaluateOnNewDocument` command is async — extractors often navigated to Copilot before stealth registered. Cloudflare saw headless fingerprints and blocked the page. Fixed by awaiting stealth for Bing tabs. Perplexity/Google kept fire-and-forget since Perplexity's anti-bot detects the awaited patches.
- **Bing copy button handler not hydrated** (`extractors/bing-copilot.mjs`) — Copilot's React copy button exists in the DOM before its click handler is bound. `clickCopyAndPollClipboard` clicked too early → clipboard interceptor empty → 13s wasted polling + DOM fallback. Added 800ms hydration delay after `waitForCopyButton`. Solo Bing went from 37-73s → 16s.
- **Manual verification blocked synthesis** (`bin/search.mjs`) — When Bing/Perplexity needed manual verification after visible recovery, `search.mjs` returned early with `synthesize: false`, discarding all engine results. Now synthesis continues with whichever engines succeeded. Visible Chrome stays open for the user.
- **Source-fetch crash after visible→headless recovery** (`src/search/fetch-source.mjs`) — After recovery killed/restarted Chrome, stale CDP tab references in parallel source-fetch workers caused "No target matching prefix" crashes. Workers now catch `fetchSourceContent` errors; `fetchSourceContentBrowser` returns error objects instead of throwing.
- **Progress tracker "🔄 synthesizing" hang** (`src/tools/shared.ts`) — When synthesis was skipped (manual verification), the progress tracker showed "🔄 synthesizing" forever because no `PROGRESS:synthesis:done` was ever emitted. Now handles `done`/`error`/`skipped` synthesis states.
- **Gemini synthesis eval timeout** (`bin/cdp.mjs`) — CDP daemon `TIMEOUT` was 30s, but `waitForStreamComplete` uses a single `Runtime.evaluate` call that can run 60-90s for long synthesis prompts. Increased to 90s.

### Performance

- **Reduced timeouts across all extractors** — Navigation: 35s→20s, verification retry: 30s→10s (Bing/Perplexity), 60s→10s (Gemini/Google), post-nav settle: 1200ms→600ms (Bing), 1200ms→600ms (Gemini). Turnstile never clears in headless, so 30s of retry loops were pure waste.
- **Hard per-engine timeouts raised** (`bin/search.mjs`) — Fast: 22s→30s, Standard/Deep: 35s→55s. CDP contention from 3 parallel extractors adds overhead that the old budgets didn't account for.
- **Tab creation split: Bing gets blank+stealth, others pre-seeded** (`src/search/chrome.mjs`) — `Target.createTarget` navigation is less detectable than CDP `Page.navigate` for Perplexity/Google. Bing needs blank tab + awaited stealth to hide headless fingerprints from Copilot's Cloudflare.

### Performance

- **Hard per-engine timeouts** (`bin/search.mjs`) — Fast mode: 22s per engine. Standard/deep: 35s per engine. Slow engines are skipped instead of stalling the whole batch. Previously a single slow engine could push `all` searches to 60–90s.
- **Parallel tab creation** (`bin/search.mjs`, `src/search/chrome.mjs`) — All engine tabs open simultaneously instead of sequential 300ms staggered delays. Tabs are pre-seeded to each engine's homepage so extractors skip redundant initial navigation.
- **Reduced settle delays** (`extractors/common.mjs`) — `postNav` 1500→800ms, `postNavSlow` 2000→1200ms, `postClick`/`postType` 400→300ms, `afterVerify` 3000→1500ms. Safe because tabs now load the target domain before the extractor even starts.
- **Higher source-fetch concurrency** (`src/search/constants.mjs`) — Default `GREEDY_FETCH_CONCURRENCY` raised from 2 → 4.
- **Faster HTTP timeouts** (`src/search/fetch-source.mjs`) — HTTP fetch timeout 15s → 10s, browser fallback settle 1500ms → 800ms.
- **Non-blocking cleanup** (`bin/search.mjs`) — Removed the 1500ms hard sleep at process exit; `minimizeChrome` now fire-and-forget.
- **Domain-aware navigation skip** (`extractors/bing-copilot.mjs`, `extractors/perplexity.mjs`, `extractors/google-ai.mjs`) — When a tab is already on the engine's domain (pre-seeded by orchestrator), skip the redundant `cdp nav` call and settle delay.
- **Fast mode keeps short engine budgets** (`bin/search.mjs`) — Fast mode still uses 22s per-engine extraction timeouts and skips source fetch/synthesis work. Verification recovery can now run in fast mode when Bing/Perplexity are blocked, because returning no result is worse than the retry cost.

### Anti-Bot Detection Hardening (Anti-CDP Evasion)

- **Runtime.enable evasion** (`bin/cdp.mjs`) — The primary CDP detection vector (Cloudflare/DataDome watch for `Runtime.consoleAPICalled` timing) has been eliminated. All `Runtime.evaluate` calls now use an explicit `contextId` captured via brief `Runtime.enable` → `Runtime.disable` at daemon startup (~100ms window). No persistent Runtime domain enable for the session. See: rebrowser.net / DataDome research.
- **Stale PID / ghost Chrome cleanup** (`src/search/chrome.mjs`) — `killChrome()` now uses port-based process detection via `netstat`/`lsof` instead of relying solely on the PID file. Handles ghost processes that hold port 9222 after the tracked PID dies. Old `killHeadlessChrome` kept as backward-compat alias.
- **Idle cleanup for both modes** (`src/search/chrome.mjs`) — `checkAndKillIdle()` no longer gates on `GREEDY_SEARCH_HEADLESS=1`. Both headless and visible Chrome auto-kill after idle timeout. Disable with `GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES=0`.
- **`--disable-blink-features=AutomationControlled` for visible mode** (`bin/launch.mjs`, `bin/gschrome.mjs`) — Previously headless-only. The flag and `--window-size` now apply to both modes, suppressing `navigator.webdriver` in visible Chrome too.
- **Stealth injection for visible mode** (`src/search/chrome.mjs`, `extractors/common.mjs`) — Canvas noise, plugin spoofing, `window.chrome.runtime`, and console safening now inject on both headless and visible tabs.
- **Client Hints consistency** (`src/fetcher.mjs`) — Added `Sec-CH-UA`, `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` headers to `DEFAULT_HEADERS`, matching the Chrome 122 user-agent. Inconsistency between UA and Client Hints is a strong bot signal.
- **Perplexity Cloudflare verification** (`extractors/perplexity.mjs`) — Added `handleVerification` call after navigation. Perplexity was the only engine missing Cloudflare challenge handling (Bing, Gemini, Google AI already had it).
- **Chrome TLS fetch fallback** (`src/search/fetch-source.mjs`) — New `fetchSourceViaChrome()` uses `Network.loadNetworkResource` (Chrome 124+) to fetch with authentic Chrome TLS/JA3+HTTP/2 fingerprints when Node.js HTTP fails. Zero navigation overhead.

### Added

- **`visible` / `alwaysVisible` search options** (`src/tools/greedy-search-handler.ts`, `src/tools/shared.ts`, `bin/search.mjs`) — Agents can now force visible Chrome per call with `visible: true`, `alwaysVisible: true`, or `headless: false`. CLI aliases: `--visible`, `--always-visible`. Global env: `GREEDY_SEARCH_ALWAYS_VISIBLE=1`.
- **GreedySearch Chrome commands for Pi** (`index.ts`) — Added `/greedy-visible`, `/greedy-status`, and `/greedy-kill` so users do not need to know package install paths to manage the dedicated Chrome instance.
- **Safe CDP wrappers** (`bin/cdp-greedy.mjs`, `bin/cdp-visible.mjs`, `bin/cdp-headless.mjs`) — Agents can inspect only the dedicated GreedySearch Chrome profile. The wrappers always set `CDP_PROFILE_DIR` and mode-specific wrappers refuse to attach to the wrong mode, preventing accidental main-Chrome pollution.
- **`bin/kill-visible.mjs`** — Strong visible/port cleanup helper backed by `launch-visible.mjs`'s PID + port nuke path.
- **`bin/gschrome.mjs`** — Standalone Chrome lifecycle manager: `launch-headless`, `launch-visible`, `kill`, `status`. Port-based PID detection, forces mode switches, writes `DevToolsActivePort` for CDP.

### Fixed

- **Single-engine visible recovery** (`bin/search.mjs`) — `engine: "bing"` and `engine: "perplexity"` now perform the same headless → visible retry as `engine: "all"` when blocked by Cloudflare, captcha, timeout, missing input, or clipboard failures.
- **Bing visible clipboard race** (`extractors/bing-copilot.mjs`) — Waits for the assistant copy button, polls clipboard interception after click, retries copy/poll, then falls back to visible DOM text. Fixes cases where Copilot visibly answered but the extractor returned `Clipboard interceptor returned empty text`.
- **Manual verification flow** (`bin/search.mjs`, `src/formatters/results.ts`) — If visible retry reaches a human verification challenge, GreedySearch leaves visible Chrome open and returns a clear “solve verification, then rerun” result instead of killing the browser and returning no results.
- **Visible/headless process cleanup** (`bin/launch.mjs`, `bin/visible.mjs`) — Fixed Windows `taskkill` arguments, added port fallback cleanup for `--kill`, and made `visible.mjs --kill` delegate to the stronger `launch-visible.mjs` cleanup path.
- **README install paths and skill guidance** (`README.md`, `skills/greedy-search/skill.md`) — Corrected Pi git/npm package paths, documented visible mode and safe CDP wrappers, and removed stale `coding_task` guidance from the agent skill.

## [1.8.6] — 2026-05-04

### Bing Copilot: Headless Cloudflare Recovery

- **Auto-retry triggers on all Bing failures** — Error pattern expanded from `input not found|verification` to include `clipboard` failures, so any extraction failure triggers the visible Chrome recovery.
- **Clipboard retry** — `bing-copilot.mjs` now retries clipboard extraction once with a 2s delay, matching the Perplexity extractor pattern.
- **Cloudflare detection** — If the clipboard is empty and the AI copy button is hidden, the extractor checks the accessibility tree for Cloudflare challenge text and logs it explicitly for faster diagnosis.
- **DOM extraction fallback** — If clipboard fails and the copy button is missing (headless anti-bot behavior), attempts direct text extraction from the `copilot.fun` → blob: iframe chain via CDP targets. Falls through to the visible auto-retry if Cloudflare blocks the iframe.
- **Investigation confirmed** — In headless mode, Copilot renders the AI response inside a `copilot.fun` → blob: iframe sandbox with a Cloudflare Turnstile challenge. The `copy-ai-message-button` (`data-testid`) is hidden. Content is unreachable from both the main frame JS (cross-origin) and CDP iframe traversal (Cloudflare blocks load). The only viable path is visible Chrome recovery — once cookies are cached in the profile, subsequent headless searches pass transparently.

### Visible Chrome Recovery

- **Mode-aware `ensureChrome()`** — `src/search/chrome.mjs` now reads a mode marker file (`greedysearch-chrome-mode`) written by `launch.mjs`. When `GREEDY_SEARCH_VISIBLE=1` and Chrome is running headless, it kills and relaunches in visible mode with a forced relaunch guard (always relaunches after kill, even if port wasn't freed).
- **`launch.mjs` mode check on reuse** — When Chrome is already running and visible is requested (`GREEDY_SEARCH_VISIBLE=1`), checks the mode file. If headless, kills the running instance and launches visible instead of reusing.
- **Mode file cleanup** — Mode marker file cleaned on `--kill`, ghost cleanup, and idle timeout kill.
- **`bin/launch-visible.mjs`** — Standalone visible Chrome launcher. Nukes any process on port 9222 (by PID file + port scan), launches Chrome without `--headless`, and writes `"visible"` to the mode file. No ghost cleanup complexity, no mode switching — fire-and-forget visible Chrome.
- **`bin/visible.mjs`** — Convenience wrapper: kills headless, then launches visible (delegates to `launch-visible.mjs`).
- **Progress notification** — When the auto-retry launches visible Chrome for manual Cloudflare verification, a `PROGRESS:bing:needs-human` line is emitted to stderr. The progress tracker renders `🔓 bing needs manual verification` in the Pi UI.
- **Idle cleanup preserves mode** — Headless idle timeout cleanup now also removes the mode marker file.

### Security & Robustness

- **Chrome process cleanup hardening** — `launch-visible.mjs` uses `taskkill /F /PID X /T` (process tree kill) on Windows to prevent orphan renderer processes. Repeated up to 5s until port 9222 is confirmed free.
- **Zombie Chrome prevention** — `launch.mjs` and `chrome.mjs` now clean up the mode marker and PID file consistently across all kill paths (--kill, ghost cleanup, idle timeout).

### Added

- **`google-search` engine** — plain Google search extractor (locale-agnostic, `textarea[name="q"]`). Returns title/URL/snippet for traditional 10-blue-link results. Aliases: `gs`, `googlesearch`.

### Headless Mode (default)

- **Chrome now runs headless by default** — no window, no GUI, purely background. Set `GREEDY_SEARCH_VISIBLE=1` to show the browser window.
- **Anti-detection stealth** — Patches injected via `Page.addScriptToEvaluateOnNewDocument` (runs before any page JS):
  - `Runtime.enable` / CDP marker deletion (`__REBROWSER_*`, `__nightmare`, `__phantom`, etc.)
  - `navigator.webdriver` → `false`, `navigator.plugins` → realistic list, `navigator.languages` → `['en-US', 'en']`
  - `window.chrome` shim, WebGL vendor → Intel Iris, `hardwareConcurrency` → 8, `deviceMemory` → 8
  - `TrustedTypes` policy, `requestAnimationFrame` keep-alive (prevents headless stall detection)
  - `--disable-blink-features=AutomationControlled`, realistic `--user-agent`, `--window-size=1920,1080`
- **Human click simulation** — All verification/clicks now use CDP `Input.dispatchMouseEvent` with multi-event `mouseMoved→pressed→released`, ±3px coordinate jitter, and random delays (80–180ms hover, 30–90ms hold). Detection scripts return element selectors instead of clicking in-page; `handleVerification` performs human clicks via `humanClickElement()`/`humanClickXY()`. Applies to Turnstile iframes, reCAPTCHA, Cloudflare challenges, Microsoft auth, Copilot modals, and all generic verify/continue buttons.
- **Idle auto-cleanup** — Headless Chrome auto-killed after `GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES` (default 5 min) of inactivity. Kills only the PID-tracked instance on port 9222 — never touches the main Chrome session. Activity timestamp written at search start and end.

### Performance

- **Timeouts cut ~40–50%** across all extractors — typical search ~60–90s → ~30–45s:
  - `TIMING`: postNav 1500→800ms, postNavSlow 2000→1000ms, postClick 400→250ms, postType 400→250ms, inputPoll 400→300ms, copyPoll 600→400ms, afterVerify 3000→2000ms
  - Defaults: waitForCopyButton 60s→30s, waitForStreamComplete 30s→20s, handleVerification 60s→30s
  - Per-extractor: Google stream 45s→30s, Gemini copyButton 120s→60s + inputDeadline 10s→8s, Perplexity inputDeadline 8s→5s + stream 30s→20s, Bing verification 90s→30s + copyButton 60s→30s
  - Engine process timeout: 90s→60s (180s→120s Gemini)

### Security

- **SonarCloud security hotspots fixed** — Two open hotspots resolved:
  - _Weak cryptography (S2245)_ in `extractors/consent.mjs`: replaced `Math.random()` with `crypto.randomInt()` for the mouse-jitter RNG. Not actually security-sensitive (used only for ±3px jitter and timing delays), but compliant now.
  - _PATH injection (S4036)_ in `src/search/chrome.mjs`: `spawn("node", ...)` replaced with `spawn(process.execPath, ...)` so the launcher doesn't rely on the `PATH` environment variable.
- **Query/prompt leakage prevention** — Queries and synthesis prompts no longer appear in OS process tables. All `spawn()` calls now pipe query/prompt through stdin via `--stdin` flag instead of command-line arguments. Affects `runSearch`, `runExtractor`, `synthesizeWithGemini`, and all 5 extractors (`perplexity`, `bing-copilot`, `google-ai`, `google-search`, `gemini`).

### Visual

- **Redesigned banner** — Cleaner SVG layout with pi logo icon, no text, no lens graphic. Gemini Synthesizer pill badge integrated. Three design iterations landed on a minimal icon-only look (`docs/banner.svg`).

### Fixed

- **Gemini & Bing copy button race condition** — Both extractors were capturing the user's query instead of the AI's answer. Root cause: `document.querySelector()` returns the first copy button in DOM order, which is the user's echoed message (above the assistant's response). For short queries this triggers instantly. Fixed by: (1) replacing `waitForCopyButton` with `waitForStreamComplete` to ensure the response finishes streaming before copying, and (2) clicking the **last** copy button (`querySelectorAll` + `[length-1]`) instead of the first — matching Perplexity's proven pattern. Also added periodic scroll-to-bottom alongside stream wait for Gemini to trigger lazy-loaded content.
- **Progress tracker shows false ✅ for errors** — `makeProgressTracker` in `shared.ts` completely ignored the `status` parameter, always showing `✅ done` for every engine. Now correctly tracks per-engine status and shows `❌ failed` when an engine errors.
- **Synthesis echoes engine JSON when engines fail** — When Perplexity/Bing fail, Gemini was echoing the engine summary JSON back as its "answer". `synthesis-runner.mjs` now detects this pattern (engine keys without synthesis fields) and treats it as a parse failure, falling back to individual engine results.
- **`headless=false` parameter ignored** — The `--headless` flag was never checked by `search.mjs` or `launch.mjs`; they only read `GREEDY_SEARCH_VISIBLE`. `shared.ts` now propagates the visibility preference via the env var when `headless=false` is passed.

### Cloudflare / Verification Recovery

- **Auto-recovery from Cloudflare blocks** — When Perplexity (`#ask-input` not found) or Bing (`input not found` / `verification required`) fail in headless mode, `search.mjs` now:
  1. Detects the Cloudflare/verification error pattern
  2. Kills headless Chrome, relaunches in visible mode
  3. Retries the blocked engines — Cloudflare bypasses, cookies stored in Chrome profile
  4. Kills visible Chrome, relaunches headless
  5. Continues remaining pipeline (source fetch, synthesis)
  6. Cookies persist — subsequent headless searches pass transparently

### Removed

- **`coding_task` tool removed** — `bin/coding-task.mjs`, `src/formatters/coding.ts`, registration deleted (644 lines).
- **`deep_research` tool removed** — handler, test, and `formatDeepResearch` + helpers deleted (521 lines). Use `greedy_search` with `depth: "deep"`.
- **Minimize debug logs** — Removed 9 verbose `[minimize]` console.log statements from launch.mjs.

### Fixes

- **Code scanning alerts resolved (5 alerts)** — (1) Added `permissions: contents: read` to `sync-to-webaio.yml` workflow (#14). (2) Fixed backslash escaping in `consent.mjs`'s `humanClickElement` selector injection (#10) — selectors containing backslashes (e.g., `\"`) weren't properly escaped before DOM injection. (3) Fixed same backslash escaping in `google-search.mjs`'s `SEARCH_BOX` selector in 3 locations (#11-13).
- **`cdp.mjs` `getPages()` filter** — Allows `chrome://newtab/` (headless Chrome default initial tab). Prevents "No Chrome tabs found" on cold start.

### Security

- **SonarCloud: Log injection vulnerability (1 alert)** — `bin/launch.mjs` no longer logs the raw WebSocket debugger URL (user-controlled data). Replaced with a static "WebSocket URL received" message to prevent query/URL content from leaking into logs.

### Code Quality

- **SonarCloud batch fixes (~52 issues resolved)** across 16 source files:
  - `S7781` — Replaced 18 `String#replace()` calls with `String#replaceAll()` for global replacements (regex → literal where applicable).
  - `S1128` — Removed 15 unused imports (`dirname`, `join`, `relative`, `spawn`, `tmpdir`, `existsSync`, `shouldUseBrowser`, `closeTabs`, `cdp`, `openNewTab`, `closeTab`, `activateTab`, `trimText`).
  - `S7773` — Migrated 11 `parseInt`/`parseFloat` calls to `Number.parseInt`/`Number.parseFloat`.
  - `S7780` — Wrapped 8 CDP eval templates containing backslash sequences in `String.raw()` to eliminate double-escaping.
  - `S7735` — Eliminated 13 negated-condition ternaries by inverting the conditional logic (`!== -1 ? ... : null` → `=== -1 ? null : ...`).

### Security Hotspot Review

- **SonarCloud: 20 security hotspots reviewed and marked Safe** — All outstanding hotspots were assessed and resolved in SonarCloud:
  - `S4721` OS Command Injection (×2) — Inputs are hardcoded (`port=9222`) or parsed from system output and validated via `Number.parseInt`. Not user-controlled.
  - `S5852` Regex ReDoS (×10) — Regexes operate on bounded input with negated char classes or short fixed patterns. No practical denial-of-service risk.
  - `S4036` PATH environment variable (×8) — Local CLI extension spawning package-internal Node scripts. PATH is host-controlled; no untrusted input reaches the command.

### Tooling

- **SonarCloud configuration** — Added `sonar-project.properties` with exclusions for `test/**`, `test.mjs`, `test.sh`, `test_unit.mjs`, and `scripts/**` so test-only code does not skew source quality metrics.

## v1.8.5 (2026-04-29)

### Security

- **CodeQL: Incomplete URL substring sanitization (6 alerts)** — Replaced loose `includes()` / `endsWith()` checks on raw URL strings with proper hostname parsing in `src/github.mjs`, `src/reddit.mjs`, `src/fetcher.mjs`, and `extractors/bing-copilot.mjs`. Prevents bypasses where arbitrary subdomains could spoof trusted domains (e.g. `evilgithub.com`, `reddit.com.evil.com`).
- **CodeQL: Resource exhaustion (1 alert)** — `cdp loadall` now bounds `intervalMs` to 100–30,000ms to prevent unbounded `setTimeout` durations from untrusted CLI input.
- **CodeQL: Missing workflow permissions (2 alerts)** — Added explicit `permissions: contents: read` blocks to `.github/workflows/ci.yml` and `.github/workflows/mirror-to-claude.yml`, limiting `GITHUB_TOKEN` scope to the minimum required.

### Dependencies

- **Dependabot security updates** — Bumped `basic-ftp`, `yaml`, `brace-expansion`, `protobufjs`, `fast-xml-parser`, and `@mozilla/readability` to latest patched versions.

### Tests

- **GitHub fetch test fixes** — Corrected ES module import paths and added `'all'` mode to test block conditions so cross-platform test runs pass cleanly.

## v1.8.4 (2026-04-27)

### Fixes

- **Double-escaped enum params (issue #2)** — `pi-coding-agent` v0.70.2 wraps string enum values in extra quotes (e.g. `"all"` → `"\"all\""`) before validation, causing `greedy_search`, `deep_research`, and `coding_task` to reject every call with a validation error. Fixed by switching `engine`, `depth`, and `mode` parameters from strict `Type.Union([Type.Literal(...)])` to `Type.String()` (so the call passes validation), then stripping the extra quotes in each handler via a shared `stripQuotes()` utility.

### Tests

- **Unit tests added** — `node test.mjs unit` runs 13 fast, Chrome-free tests covering `stripQuotes` and param normalization for all affected tools. Included in `quick` and `smoke` modes.
- **CI now runs unit tests** — GitHub Actions workflow runs `node test.mjs unit` after install on all three OS targets (ubuntu, windows, macos).

## v1.8.3 (2026-04-24)

### Fixes

- **Perplexity extraction fixed** — The copy button selector was returning the first matching button ("Copy question") instead of the answer copy button. Changed `.find()` to `.filter().pop()` to get the last matching button, which correctly copies the answer text. Fixes `--full` flag returning only the query text instead of the full answer.

### Features

- **Reddit JSON API support** — Reddit post URLs now use Reddit's public `.json` API instead of HTML scraping. Gets structured post data + top comments with nesting. Falls back to HTTP fetch if API fails.

## v1.8.2 (2026-04-20)

### Cross-Platform Testing

- **Node.js test runner (`test.mjs`)** — Added cross-platform test runner that works on Windows, macOS, and Linux without requiring bash. Runs smoke tests, quick tests, and edge case tests.
- **Updated npm scripts** — `npm test` now runs the Node.js test runner (was bash-only). Original bash tests available via `npm run test:bash`.

### Project Metadata

- **Added `engines` field** — Package now specifies `node: ">=20.11.0"` requirement for `import.meta.dirname` support.
- **Updated README** — Added Testing section documenting both Node.js and bash test runners, clarified Node.js 20.11.0+ requirement.

## v1.8.0 (2026-04-16)

### Fixes

- **`cdpAvailable()` missing `baseDir` argument** — two callsites in `index.ts` (session_start handler and coding_task handler) were calling `cdpAvailable()` without the required `baseDir` parameter, producing an incorrect path (`join(undefined, "bin", "cdp.mjs")`). Both now pass `__dir` so the CDP check resolves against the correct package directory.
- **Duplicated `ENGINES` map removed** — `ENGINES` was defined identically in both `src/search/constants.mjs` and `src/search/engines.mjs`. Now `engines.mjs` imports and re-exports from `constants.mjs`, keeping a single canonical source and eliminating sync drift risk.
- **`ALL_ENGINES` sync comment** — added a `// Keep in sync with src/search/constants.mjs` comment on the `ALL_ENGINES` tuple in `shared.ts` so future maintainers know where the canonical definition lives.

## v1.7.7 (2026-04-14)

### Fixes

- **`--deep` flag leaking into queries** — `depth: "deep"` was passing `--deep` as a bare flag to `search.mjs`, which didn't recognize it and appended it to the query string. Fixed by passing `--depth deep` instead; also added `--deep` as a recognized flag in `search.mjs` for backward compatibility with the legacy `deep_research` tool.
- **GitHub fetch always failing** — `git clone` was being `await`-ed on a non-Promise `ChildProcess` object (Node `execFile` is callback-based), so the clone never actually completed and content was always empty. Replaced git clone entirely with GitHub REST API calls: repo info + README + file tree fetched via parallel HTTP requests (~2-5s vs 30-60s, no git dependency). Non-existent repos now correctly return `ok: false`.
- **`--inline` test false negative** — smoke test was interpolating multiline JSON stdout into a `node -e` string, always producing `PARSE_ERROR`. Fixed to write stdout to a temp file and parse from file.

### Features

- **Rich source metadata** — HTTP-fetched sources now include `publishedTime`, `lastModified`, `byline`, `siteName`, and `lang`. `publishedTime` is extracted from Readability's parser plus a fallback chain of 8 `<meta>` selectors (Open Graph, schema.org, Dublin Core). All fields flow through to the Gemini synthesis prompt. Gemini is instructed to flag sources older than 2 years as potentially stale in caveats.
- **GitHub Fetch Tests** — smoke/edge/quick test modes now include 4 GitHub-specific tests: root repo API fetch (README + tree), blob file via raw URL, blob via HTTP fetcher pipeline, and graceful failure on non-existent repo.

## v1.7.6 (2026-04-11)

### Fixes

- **Close Gemini synthesis tab** — after synthesis completes, the Gemini tab is now closed instead of merely activated, preventing stale tabs from accumulating across searches.

## v1.7.5 (2026-04-10)

### Plugin

- **Claude Code plugin** — added `.claude-plugin/plugin.json` and `marketplace.json` so GreedySearch can be installed directly as a Claude Code plugin via `claude plugin install`.
- **Auto-mirror GH Action** — every push to `GreedySearch-pi/master` automatically syncs to `GreedySearch-claude/main`, keeping the Claude plugin up to date.
- **Tightened `skill.md`** — removed verbose guidance sections; kept parameters, depth table, and coding_task reference. -72 lines.

## v1.7.4 (2026-04-10)

### Refactor

- **Shared `waitForCopyButton()`** — consolidated duplicate copy-button polling loops from `bing-copilot`, `gemini`, and `coding-task` into a single `waitForCopyButton(tab, selector, { timeout, onPoll })` in `common.mjs`. Gemini's scroll-to-bottom logic passed as `onPoll` callback.
- **Shared `TIMING` constants** — replaced 30+ scattered `setTimeout` magic numbers with named constants (`postNav`, `postNavSlow`, `postClick`, `postType`, `inputPoll`, `copyPoll`, `afterVerify`) in `common.mjs`.
- **`waitForStreamComplete` improvements** — added `minLength` option and graceful last-value fallback; `google-ai` now uses the shared implementation instead of its own copy.
- **Removed dead code** — deleted unused `_getOrReuseBlankTab` and `_getOrOpenEngineTab` from `bin/search.mjs`; removed unused `STREAM_POLL_INTERVAL` and `STREAM_STABLE_ROUNDS` from `coding-task`.

### Fixes

- **Synthesis tab regression** — `getOrOpenEngineTab("gemini")` call during synthesis was broken by the dead-code removal; replaced with `openNewTab()`.

## v1.7.3 (2026-04-10)

### Fixes

- **Force English in Google AI results** — Added `hl=en` query parameter to Google AI Mode search URL so responses are always returned in English, regardless of the user's IP-based region (fixes #1).

## v1.7.2 (2026-04-08)

### Release

- **Patch release** — version bump and npm package verification for the `bin/` runtime layout (`bin/search.mjs`, `bin/launch.mjs`, `bin/cdp.mjs`, `bin/coding-task.mjs`).

## v1.7.1 (2026-04-08)

### Performance

- **Bounded source-fetch concurrency** — source fetching now uses a small worker pool (default `2`, configurable via `GREEDY_FETCH_CONCURRENCY`) to reduce burstiness while keeping deep-research fast.

### Project structure

- **Runtime scripts moved to `bin/`** — `search.mjs`, `launch.mjs`, `cdp.mjs`, and `coding-task.mjs` now live under `bin/` for a cleaner repository root.
- **Path references updated** — extension runtime, tests, extractor shared utilities, and docs now point to `bin/*` paths.

### Packaging & docs

- **Package file list updated** — npm package now includes `bin/` directly instead of root script entries.
- **README simplified** — rewritten into a shorter, concise format with quick install, usage, and layout guidance.

## v1.6.5 (2026-04-04)

### Security

- **Private URL blocking** — Added validation to block requests to localhost, RFC1918 private addresses (10.x, 192.168.x), and .local/.internal domains. Prevents accidental exposure of internal services.

### Features

- **GitHub URL rewriting** — GitHub blob URLs (`github.com/owner/repo/blob/...`) are automatically rewritten to `raw.githubusercontent.com` for faster, cleaner raw file access.
- **GitHub repo cloning** — Root and tree URLs now trigger `git clone --depth 1` for complete repo access. Agent can explore files locally instead of parsing rendered HTML. Includes README preview and directory tree listing.
- **Head+tail content trimming** — Large documents now use smart truncation: keeps 75% from the beginning (introduction) + 25% from the end (conclusions/examples) with `[...content trimmed...]` marker, instead of simple truncation.
- **Anubis bot detection** — Added detection for the new Anubis proof-of-work anti-bot system (`protected by anubis`, `anubis uses a proof-of-work`).

### Fixes

- **Perplexity clipboard retry** — Added single retry with 2s delay when clipboard extraction fails, improving reliability.

## v1.6.4 (2026-04-02)

### Fixes

- **Gemini scroll-to-bottom** — Changed from small random jitter scrolls to actual bottom-of-page scrolls every ~6 seconds while waiting for the copy button. This ensures lazy-loaded content is triggered and the full answer is captured.
- **Restored missing files** — `.mjs` source files (extractors, search.mjs, launch.mjs, etc.) were incorrectly removed in v1.6.2 cleanup; now properly tracked again.

## v1.6.3 (2026-04-02)

### Fixes

- **Debug output removed** — Cleaned up stderr passthrough that was causing CDP connection issues in some environments.

## v1.6.2 (2026-04-01)

### Fixes

- **Anti-bot detection evasion** — Gemini synthesis now performs gentle scroll every ~6 seconds while waiting for the copy button. This prevents the button from hanging due to anti-bot "human activity" checks.

## v1.6.1 (2026-03-31)

### Features

- **Single-engine full answers by default** — when using `engine: "perplexity"`, `engine: "bing"`, `engine: "google"`, or `engine: "gemini"`, the full answer is now returned by default instead of truncated previews. Multi-engine (`engine: "all"`) still uses truncated previews (~300 chars) to save tokens during synthesis. Explicit `fullAnswer: true/false` always overrides.

### Code Quality

- **Major refactoring** — extracted 438 lines from `index.ts` (856 → 418 lines) into modular formatters:
  - `src/formatters/coding.ts` — coding task formatting
  - `src/formatters/results.ts` — search and deep research formatting
  - `src/formatters/sources.ts` — source utilities (URL, label, consensus, formatting)
  - `src/formatters/synthesis.ts` — synthesis rendering
  - `src/utils/helpers.ts` — shared formatting utilities
- **Complexity reduced** — cognitive complexity dropped from 360 to ~60, maintainability index improved from 11.2 to ~40+
- **Eliminated code duplication** — removed 6 duplicate blocks, consolidated 4+ single-use helper functions

### Documentation

- Clarified `greedy_search` is WEB SEARCH ONLY — removed "NOT for codebase search" from tool description (still in skill documentation)

## v1.6.0 (2026-03-29)

### Breaking Changes (Backward Compatible)

- **Merged deep_research into greedy_search** — new `depth` parameter with three levels:
  - `fast`: single engine (~15-30s)
  - `standard`: 3 engines + synthesis (~30-90s, default for `engine: "all"`)
  - `deep`: 3 engines + source fetching + synthesis + confidence (~60-180s)
- **Simpler mental model** — one tool with clear speed/quality tradeoffs instead of separate tools with overlapping flags
- **Deprecated flags still work** — `--synthesize` maps to `depth: "standard"`, `--deep-research` maps to `depth: "deep"`
- **deep_research tool aliased** — still works, calls `greedy_search` with `depth: "deep"`

### Documentation

- Updated README with new `depth` parameter and examples
- Updated skill documentation (SKILL.md) to reflect simplified API

## v1.5.1 (2026-03-29)

- **Fixed npm package** — added `.pi-lens/` and test files to `.npmignore` to reduce package size

## v1.5.0 (2026-03-29)

### Features

- **Code extraction fixed** — `coding_task` now uses clipboard interception to preserve markdown code blocks (was losing them via DOM scraping)
- **Chrome targeting hardened** — all tools now consistently target the dedicated GreedySearch Chrome via `CDP_PROFILE_DIR`, preventing fallback to user's main Chrome session
- **Shared utilities** — extracted ~220 lines of duplicate code from extractors into `common.mjs` (cdp wrapper, tab management, clipboard interception)
- **Documentation leaner** — skill documentation reduced 61% (180 → 70 lines) while preserving all decision-making info

### Notable

- **NO API KEYS** — updated messaging to emphasize this works via browser automation, no API keys needed

## v1.4.2 (2026-03-25)

- **Fresh isolated tabs** — each search now always creates a new `about:blank` tab via `Target.createTarget` and refreshes the CDP page cache immediately after, preventing SPA navigation failures and stale DOM state from prior queries
- **Regex-based citation extraction** — all extractors (Perplexity, Bing, Gemini) now parse sources from clipboard Markdown links (`[title](url)`) instead of DOM selectors that break on UI updates
- **Relaxed verification detection** — `consent.mjs` now uses broad keyword matching (`includes('verify')`, `includes('human')`) instead of anchored regexes, correctly catching button text variants like "Verify you are human" across Cloudflare, Microsoft, and generic modals

## v1.4.1

- **Fixed parallel synthesis** — multiple `greedy_search` calls with `synthesize: true` now run safely in parallel. Each search creates a fresh Gemini tab that gets cleaned up after synthesis, preventing tab conflicts and "Uncaught" errors.

## v1.4.0

- **Grounded synthesis** — Gemini now receives a normalized source registry with stable source IDs, agreement summaries, caveats, and cited claims
- **Real deep research** — top sources are fetched before synthesis so deep research answers are grounded in fetched evidence, not just engine summaries
- **Richer source metadata** — source output now includes canonical URLs, domains, source types, per-engine attribution, and confidence metadata
- **Cleaner tab lifecycle** — temporary Perplexity, Bing, and Google tabs are closed after each fan-out search, and synthesis finishes on the Gemini tab
- **Isolated Chrome targeting** — GreedySearch now refuses to fall back to your normal Chrome session, preventing stray remote-debugging prompts

# Stealth Browser MCP — Reuse Assessment

> **Repo:** <https://github.com/vibheksoni/stealth-browser-mcp>
> **Assessed:** 2026-07-04
> **Scope:** Full code-level review of architecture, stealth techniques, CDP patterns, network interception, process lifecycle, and security

---

## ⚠️ Confidence Notes (read first)

This assessment is based on **partial code review** — I read these files in full or near-full:

- ✅ `README.md` (full)
- ✅ `src/browser_manager.py` (full)
- ✅ `src/dom_handler.py` (full)
- ✅ `src/network_interceptor.py` (full)
- ✅ `src/dynamic_hook_system.py` (full)
- ✅ `src/server.py` (first half — 1587 of 2969 lines)
- ✅ `src/models.py` (full)
- ✅ `STEALTH_TESTS.md`, `COMPARISON.md` (full)

I did **not** fully read:

- ⚠️ `src/process_cleanup.py` — file is 30K chars; I read the header + class outline but not every method. Claims about its sophistication are based on file size and method signatures, not exhaustive code review.
- ⚠️ `src/platform_utils.py` — referenced via imports; only header + key methods read.
- ⚠️ `src/debug_logger.py` — referenced extensively in `server.py` but body not opened.
- ⚠️ `src/dynamic_hook_ai_interface.py` — referenced but not read.
- ⚠️ `src/server.py` lines 1588-2969 — second half (likely contains more `section_tool` definitions and the element-cloning wiring).
- ⚠️ All `src/js/*.js` files (element extractors).
- ⚠️ All element-cloner modules (`cdp_element_cloner.py`, `comprehensive_element_cloner.py`, etc.).

**No live testing was performed.** I did not run either tool, did not compare fingerprint results side-by-side, and did not benchmark tab-recycling claims against real ChatGPT stalling.

**Comparative claims about GreedySearch's stealth superiority are inference, not proof.** I read GreedySearch's `AGENTS.md` design notes (which describe the patches) but did not see empirical test results comparable to stealth-browser-mcp's `STEALTH_TESTS.md` (which has actual 0% on CreepJS, 20/20 on Sannysoft). So in practice, stealth-browser-mcp may have *more validation evidence* — I just inferred GreedySearch's patches are deeper from the design intent described in AGENTS.md.

---

## Table of Contents

- [1. Executive Summary](#1-executive-summary)
- [2. Architecture Patterns](#2-architecture-patterns)
- [3. Stealth Techniques](#3-stealth-techniques)
- [4. CDP Patterns](#4-cdp-patterns)
- [5. Network Interception](#5-network-interception)
- [6. Process Lifecycle & Cleanup](#6-process-lifecycle--cleanup)
- [7. DOM Interaction Patterns](#7-dom-interaction-patterns)
- [8. Element Cloning](#8-element-cloning)
- [9. Security Considerations](#9-security-considerations)
- [10. Test & Validation Practices](#10-test--validation-practices)
- [11. Portable Code Patterns (confidence-rated)](#11-portable-code-patterns-confidence-rated)
- [12. Summary Matrix](#12-summary-matrix)
- [13. Recommendations](#13-recommendations)

---

## 1. Executive Summary

**stealth-browser-mcp** is a Python-based MCP server that provides undetectable browser automation to AI agents. It uses **nodriver** (a CDP-only browser driver), **FastMCP** for the MCP server layer, and offers **97 tools across 11 sections** — from basic navigation to advanced CDP function execution, network interception, and AI-generated dynamic hooks.

The project is architecturally impressive but solves a **different problem** than GreedySearch-pi. Stealth Browser MCP is a general-purpose undetectable browser MCP server for AI agents to browse any website. GreedySearch-pi is a purpose-built answer extraction pipeline for AI search/chat engines.

**Top reuse candidates** (where I'm confident):

1. **Tab recycling after N navigations** — solid code in their `browser_manager.py`, directly addresses a class of stale-tab issues GreedySearch extractors may hit.
2. **Recoverable navigation error detection** — the marker list (websocket, target closed, etc.) is a useful pattern.
3. **Stealth test suite URLs** — CreepJS, Sannysoft, Intoli are the right fingerprints to validate against.

**What GreedySearch already has that stealth-browser-mcp does NOT** (per AGENTS.md design notes, not empirical test):

- Aggressive canvas noise / console guards / native-code stringifying
- `Target.createTarget` for less-detectable tab creation
- Headless → visible recovery with cookie caching
- Parallel multi-engine extraction with foregrounded tabs
- Single-eval stream waits (the "Node polling vs single-eval" rule)

---

## 2. Architecture Patterns

### 2.1 Modular Tool Section System

**File:** `src/server.py` — `@section_tool` decorator, `SECTION_TOOLS` dict, `apply_disabled_sections()`

The repo uses a clean section-based tool registration pattern:

```python
SECTION_TOOLS: Dict[str, List[str]] = defaultdict(list)

def section_tool(section: str):
    def decorator(func):
        SECTION_TOOLS[section].append(func.__name__)
        return mcp.tool(func)
    return decorator

def apply_disabled_sections() -> None:
    for section in sorted(DISABLED_SECTIONS):
        for tool_name in SECTION_TOOLS.get(section, []):
            try:
                mcp.remove_tool(tool_name)
            except Exception:
                continue
```

This enables:

- `--minimal` mode (20 core tools instead of 97)
- `--disable-cdp-functions --disable-dynamic-hooks` selective disabling
- `--list-sections` introspection

**Confidence: Medium.** I read this pattern in the first half of `server.py`. The second half (not read) likely follows the same pattern for element-extraction/file-extraction/progressive-cloning tools. I assume the pattern is consistent but haven't verified.

**Relevance to GreedySearch:** Medium. Your parallel extractors already serve different engines; a section-based system could help `--fast` mode disable expensive subsystems, but it's an organizational pattern, not a performance win.

### 2.2 Multi-Instance Browser Manager

**File:** `src/browser_manager.py` — `BrowserManager` class (read in full)

The `BrowserManager` manages multiple browser instances via a `Dict[str, dict]` keyed by UUID:

```python
self._instances: Dict[str, dict] = {}
# Each entry: {
#   'browser': Browser,
#   'tab': Tab,
#   'instance': BrowserInstance,
#   'options': BrowserOptions,
#   'navigation_count': int,
#   'idle_timeout_seconds': int,
#   'spawn_diagnostics': dict,
#   'network_data': []
# }
```

Key methods:

- `touch_instance()` — updates last-activity timestamp
- `cleanup_inactive()` — closes instances past their idle timeout
- `start_idle_reaper()` — background asyncio task for periodic cleanup
- `get_navigation_tab()` — validates tab health before use, recycles stale tabs

**Confidence: High** (read the full file).

**Relevance to GreedySearch:** Low currently — you use a singleton Chrome. If multi-instance (different profiles per engine) is ever needed, this pattern is directly reusable, but it's a YAGNI risk until that need exists.

### 2.3 FastMCP Server with Lifespan Management

**File:** `src/server.py` — `app_lifespan()`

```python
@asynccontextmanager
async def app_lifespan(server):
    try:
        await browser_manager.start_idle_reaper()
        yield
    finally:
        await browser_manager.stop_idle_reaper()
        await browser_manager.close_all()
        process_cleanup._cleanup_all_tracked()
        persistent_storage.clear_all()
```

Clean startup → serve → shutdown lifecycle.

**Confidence: High.**

**Relevance to GreedySearch:** Low. Your `bin/launch.mjs` and `bin/search.mjs` already do this manually. The pattern is worth noting for any persistent server mode but doesn't change your current architecture.

### 2.4 Response Handler for Large Data

**File:** `src/response_handler.py` (referenced in `take_screenshot`, not read directly)

The `take_screenshot` tool auto-detects when base64 data exceeds ~20K estimated tokens and saves to file instead, returning a message instructing the AI agent to use the Read tool. This prevents context window overflow.

**Confidence: Low.** I inferred this from the `take_screenshot` implementation in `server.py` — the `response_handler.handle_response()` call and the explicit 20K-token threshold check. I did not read `response_handler.py` itself.

**Relevance to GreedySearch:** Low. Your research bundle writing already handles large output via disk writes. The auto-detection + file fallback is a clean pattern but already implicit in your architecture.

---

## 3. Stealth Techniques

### 3.1 What Stealth Browser MCP Does

The stealth comes primarily from **nodriver** (not raw puppeteer/playwright). nodriver provides:

- Direct CDP protocol (no WebDriver protocol — less detectable)
- Auto-generated random user data dirs (`uc_*` temp profiles)
- `navigator.webdriver` set to `undefined`
- Removal of automation-controlling command-line flags
- Real Chrome/Chromium/Edge (not bundled Chromium)

The codebase itself does **not** inject custom stealth scripts. No `Page.addScriptToEvaluateOnNewDocument` patches, no canvas noise, no `navigator.plugins` overrides visible in the files I read. The stealth is purely from nodriver's defaults plus:

- `check_browser_executable()` — auto-detects the real browser (Chrome/Edge/Chromium)
- `merge_browser_args()` — strips conflicting args
- Sandbox auto-detection (root/container handling)

**Confidence: Medium-High.** I read `browser_manager.py` fully and confirmed no `addScriptToEvaluateOnNewDocument` calls. I did not search exhaustively across the second half of `server.py` or every submodule, so a stealth patch hidden in one of the unread files is possible but unlikely given the pattern of tool organization.

### 3.2 Comparison with GreedySearch-pi

This table is **design-intent vs design-intent**, not empirical test vs empirical test:

| Feature | Stealth Browser MCP | GreedySearch-pi (per AGENTS.md) |
|---------|---------------------|----------------------------------|
| Browser driver | nodriver (CDP) | CDP directly |
| `navigator.webdriver` | Undefined (nodriver default) | Undefined + native-code stringify |
| Canvas noise | None visible | Stable per-page noise |
| Console guards | None visible | Fire-and-forget for Bing |
| `navigator.plugins` | Default Chrome | Patched for consistency |
| `navigator.mediaDevices` | Default Chrome | Patched for consistency |
| `navigator.userAgentData` | Default Chrome | Patched for consistency |
| Tab creation | `uc.start()` → main tab | `Target.createTarget` (less detectable) |
| Headless detection avoidance | nodriver defaults | Aggressive patches |
| Visible recovery | Not implemented | Bing, Perplexity, ChatGPT, Semantic Scholar, Logically |

**Important caveat:** stealth-browser-mcp has empirical test results in `STEALTH_TESTS.md`:

- 0% headless, 0% stealth on CreepJS
- 20/20 on Sannysoft Bot Detection
- All checks passed on Intoli

GreedySearch's `AGENTS.md` describes the stealth patches but does **not** include equivalent empirical test numbers. So in **measured evidence**, stealth-browser-mcp currently wins — I just inferred GreedySearch's design is *deeper* from the description, not from test data.

**Confidence: Medium.** I have full test data for one side and design intent for the other.

### 3.3 What to Adopt (with caveats)

The **multi-platform browser auto-detection** from `platform_utils.py` is worth porting. It apparently handles:

- Microsoft Edge (msedge.exe on Windows, microsoft-edge on Linux)
- Multiple Chrome install paths
- macOS .app bundles
- Linux snap/flatpak installations

**Confidence: Low-Medium.** I did not read `platform_utils.py` in full. I saw the function name `check_browser_executable` imported into `browser_manager.py` and the high-level description in their README mentions "Windows, macOS, Linux, and Docker; supports Chrome, Chromium, and Edge." The actual implementation details are inferred.

---

## 4. CDP Patterns

### 4.1 Navigation with Tab Recycling

**File:** `src/browser_manager.py` — `navigate()`, `get_navigation_tab()`, `_replace_main_tab()` (read in full)

```python
NAVIGATION_RECYCLE_THRESHOLD = 25

async def get_navigation_tab(self, instance_id):
    data = await self.get_instance(instance_id)
    navigation_count = data.get("navigation_count", 0)
    
    # Recycle tab after threshold to prevent memory leaks
    if navigation_count >= self.NAVIGATION_RECYCLE_THRESHOLD:
        return await self._replace_main_tab(instance_id, reason="recycle threshold")
    
    # Validate tracked tab health
    await browser.update_targets()
    tracked_target_id = self._get_tab_target_id(tracked_tab)
    # ... find matching tab in browser.tabs
```

Recoverable navigation errors trigger automatic retry with a fresh tab:

```python
@staticmethod
def _is_recoverable_navigation_error(error):
    recoverable_markers = (
        "connection dropped", "connection closed", "connection lost",
        "websocket", "target closed", "target crashed",
        "session closed", "invalid state", "not attached",
    )
    return any(marker in message for marker in recoverable_markers)
```

**Confidence: High.** I read the full `navigate()` and `_replace_main_tab()` implementations. The error recovery wraps the navigation in a 2-attempt loop with the second attempt using a fresh tab.

**Relevance to GreedySearch: Likely High, but with a caveat.**

Your AGENTS.md describes stale-tab symptoms:

- "ChatGPT background tabs can stall and leave only citation/header stubs in the DOM"
- "Bing copy button exists in DOM before React hydrates its click handler"
- "Perplexity's anti-bot system detects aggressive stealth patches"

The **first two are potentially related to tab age/health**, but they may also be caused by:

- Background-tab throttling (foregrounding fixes this — your AGENTS.md already mentions `Page.bringToFront`)
- React hydration race (timing, not tab age)
- CDP contention from parallel extractors

Tab recycling might help, might not. **The fix is not guaranteed to address the specific symptoms unless the root cause is tab-age-related.** I cannot determine root cause from either codebase.

### 4.2 Timezone Override via CDP

**File:** `src/browser_manager.py` — `_apply_timezone_override()` (read in full)

```python
@staticmethod
async def _apply_timezone_override(*, tab, timezone_id):
    if not timezone_id:
        return None
    trimmed_timezone = timezone_id.strip()
    if not trimmed_timezone:
        return None
    await tab.send(uc.cdp.emulation.set_timezone_override(timezone_id=trimmed_timezone))
    return trimmed_timezone
```

**Confidence: High.**

**Relevance to GreedySearch: Medium.** You have `/set-greedy-locale` but I did not verify whether it applies timezone via CDP. This is a small, safe addition either way.

### 4.3 Wait Conditions with Timeout Budget

**File:** `src/browser_manager.py` — `_wait_for_navigation_condition()` (read in full)

```python
@staticmethod
async def _wait_for_navigation_condition(tab, wait_until, timeout_seconds):
    if timeout_seconds <= 0:
        raise asyncio.TimeoutError("Navigation wait budget exhausted")
    
    if wait_until == "domcontentloaded":
        await asyncio.wait_for(tab.wait(uc.cdp.page.DomContentEventFired), timeout=timeout_seconds)
    elif wait_until == "networkidle":
        await asyncio.sleep(min(timeout_seconds, 2.0))  # Note: this is a lazy approximation
    else:
        await asyncio.wait_for(tab.wait(uc.cdp.page.LoadEventFired), timeout=timeout_seconds)
```

The timeout budget is split across navigation steps (navigate → wait condition → get URL/title):

```python
await asyncio.wait_for(tab.get(url), timeout=timeout_seconds)
elapsed = time.monotonic() - start_time
await self._wait_for_navigation_condition(tab, wait_until, timeout_seconds - elapsed)
# ... then uses remaining budget for tab.evaluate()
```

**Confidence: High.**

**Relevance to GreedySearch: Medium.** The budget-splitting pattern is good. The `networkidle` implementation is a weak `asyncio.sleep(2)` — not real network-idle detection. So port the budget-splitting idea, not the `networkidle` impl.

### 4.4 Direct CDP Command Execution

**File:** `src/cdp_function_executor.py` (imported but not read)

The repo exposes raw CDP execution as a tool — `execute_cdp_command('Page.navigate', {'url': '...'})`. This is a **security risk** (any AI agent can trigger any CDP command) but useful for debugging.

**Confidence: Low.** I only saw the import and tool name in `server.py`. The actual implementation and security boundary are unverified.

**Relevance to GreedySearch: Negative.** Your `bin/cdp-greedy.mjs` already does this in a controlled way for development. Exposing it as a server-level tool is over-permissive for your use case.

---

## 5. Network Interception

### 5.1 Request/Response Capture

**File:** `src/network_interceptor.py` (read in full)

Uses `cdp.network.enable()` + event handlers to capture all network traffic:

```python
tab.add_handler(uc.cdp.network.RequestWillBeSent,
    lambda event: asyncio.create_task(self._on_request(event, instance_id)))
tab.add_handler(uc.cdp.network.ResponseReceived,
    lambda event: asyncio.create_task(self._on_response(event, instance_id, tab)))
```

Features I confirmed in the code:

- Resource type filtering (include/exclude lists)
- Body capture via `get_response_body()`
- Search with pagination (URL pattern, method, status code, body content)
- Export/import to/from JSON
- Cookie management (get/set/clear)
- Network condition emulation (offline, latency, throughput)

**Confidence: High** for the code I read. I did not test live.

**Relevance to GreedySearch: Low.**

This is a real subsystem but it solves a different problem. GreedySearch extracts answer text from rendered AI chat pages — clipboard interception and DOM text are faster, more reliable, and avoid:

- Storing potentially sensitive request/response bodies
- LLM context bloat from API payloads
- Anti-bot detection from intercepted fetch events (some engines detect `Fetch.enable`)

The only relevant sub-feature is resource blocking (next section).

### 5.2 Resource Blocking

**File:** `src/network_interceptor.py` — `setup_interception()` (read in full)

```python
resource_patterns = {
    'image': ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.webp', '*.svg'],
    'stylesheet': ['*.css'],
    'font': ['*.woff', '*.woff2', '*.ttf', '*.otf', '*.eot'],
    'script': ['*.js', '*.mjs'],
    'media': ['*.mp4', '*.mp3', '*.wav', '*.avi', '*.webm']
}
# Uses network.set_blocked_ur_ls() to block
```

**Confidence: High.**

**Relevance to GreedySearch: Medium-Low.** Blocking images/fonts on AI chat pages *would* speed up navigation, but:

- AI chat UIs depend on JS frameworks (React/Vue) — blocking scripts would break them
- Your extractors already use tight timeouts (20s nav, 35-60s engine budgets)
- The speedup is probably small for text-heavy AI pages (most resources are already small)

**Worth measuring before adopting.**

### 5.3 Dynamic AI-Generated Hook System

**File:** `src/dynamic_hook_system.py` (read in full — ~600 lines)

The most architecturally ambitious feature: AI-generated Python functions that intercept `fetch.RequestPaused` events in real-time.

**How it works:**

1. AI generates Python function code with `process_request(request)` signature
2. Code is compiled via `exec()` into a restricted namespace
3. On each `RequestPaused` event, matching hooks execute and return `HookAction`
4. Actions: `continue`, `block`, `redirect`, `fulfill`, `modify`

**Security analysis — the `exec()` sandbox is weak (verified in code):**

```python
def _compile_function(self):
    namespace = {
        'HookAction': HookAction,
        'datetime': datetime,
        'fnmatch': fnmatch,
        '__builtins__': {
            'len': len, 'str': str, 'int': int, 'float': float,
            'bool': bool, 'dict': dict, 'list': list, 'tuple': tuple,
            'print': lambda *args: ...
        }
    }
    exec(self.function_code, namespace)
    return namespace['process_request']
```

The restricted `__builtins__` is the **only** sandbox. But `HookAction` is a real class exposed in the namespace. A motivated AI can do:

```python
def process_request(request):
    return HookAction.__class__.__mro__[-1].__subclasses__()  # -> <class 'type'> and all subclasses
```

From there, standard Python jailbreak: find `subprocess.Popen` or `os._wrap_close` in the subclasses, access its globals, get `os.system`. This is a textbook Python `exec()` escape.

**Confidence: High** for the security finding (I read the compile function and the namespace construction).

**Relevance to GreedySearch: NONE.** This pattern should not be ported:

1. **Security:** `exec()` from AI prompts is dangerous in any context
2. **Complexity:** You don't need real-time request interception
3. **Maintenance:** `fetch.RequestPaused` is a complex CDP domain — the code has bugs (e.g., `add_handler` with a lambda creating a task on every event has no backpressure; if many requests pause simultaneously, you get unbounded task spawning)
4. **Use case mismatch:** You want the AI to answer your question, not to be your request-interception programmer

---

## 6. Process Lifecycle & Cleanup

### 6.1 Process Cleanup Manager

**File:** `src/process_cleanup.py` — 30K chars (largest file in the project)

**Confidence: Low.** I fetched the file but did not read it in full. The following characterization is based on:

- File size (30K chars is substantial for a Python file)
- Method names in the header (which I did read)
- Imports referenced in `browser_manager.py` (`process_cleanup.track_browser_process`, `kill_browser_process`, `finalize_browser_process`, `cleanup_deferred_profiles`)

I do not have code-level confirmation of:

- Whether the graceful SIGTERM → SIGKILL escalation actually works on Windows
- Whether the deferred profile cleanup handles Windows file-lock delays correctly
- The actual orphan-detection logic at startup

**Claims to treat as provisional:** "Sophisticated process tracking," "orphan detection at startup," "graceful shutdown with timeout escalation," "temp profile cleanup on Windows."

**What I can say with confidence:**

- The file exists and is large
- It provides the API surface that `browser_manager.py` uses
- GreedySearch's equivalent (`bin/kill-visible.mjs`, `bin/launch.mjs --kill`) is simpler based on what I've seen

**Relevance to GreedySearch: Probably High, but I cannot confirm without reading the full file.**

### 6.2 Idle Reaper Pattern

**File:** `src/browser_manager.py` — `_run_idle_reaper()` (read in full)

```python
async def _run_idle_reaper(self):
    try:
        while True:
            await asyncio.sleep(self._idle_reaper_interval_seconds)
            closed_count = await self.cleanup_inactive()
            finalized_profiles = process_cleanup.cleanup_deferred_profiles()
    except asyncio.CancelledError:
        raise
```

Configurable via env vars:

- `BROWSER_IDLE_TIMEOUT` (default 600s, 0 to disable)
- `BROWSER_IDLE_REAPER_INTERVAL` (default 60s)
- `BROWSER_ORPHAN_PROFILE_MAX_AGE` (default 21600s = 6h)

**Confidence: High.**

**Relevance to GreedySearch: Low.** Your Chrome lifecycle is session-based. This pattern only matters for persistent server mode.

### 6.3 Instance Timeout Resolution

**File:** `src/browser_manager.py` — `_resolve_idle_timeout_seconds()` (read in full)

```python
def _resolve_idle_timeout_seconds(self, override):
    if self._idle_timeout_seconds_default == 0:
        return 0
    if override is None:
        return self._idle_timeout_seconds_default
    return max(int(override), 0)
```

**Confidence: High.**

**Relevance to GreedySearch: Low** (not applicable to your architecture).

---

## 7. DOM Interaction Patterns

### 7.1 File Upload with Wrapper Resolution

**File:** `src/dom_handler.py` — `file_upload()` (read in full)

```python
tag_name = element.tag_name
input_type = (element.attrs.get('type') or '').lower()
if tag_name != 'input' or input_type != 'file':
    inner_input = await element.query_selector('input[type="file"]')
    if inner_input:
        element = inner_input
```

**Confidence: High.**

**Relevance to GreedySearch: Low.** You're not doing file upload. The "resolve the actual target when a wrapper is found" pattern is general, but your specific copy-button extraction is already more sophisticated (data-attribute selectors, hydration race handling, etc.).

### 7.2 Human-like Typing

**File:** `src/dom_handler.py` — `type_text()`, `paste_text()` (read in full)

```python
# Bulk paste via CDP (fast)
await tab.send(cdp.input_.insert_text(text))

# Human-like typing (slow, detectable)
for char in text:
    await element.send_keys(char)
    await asyncio.sleep(delay_ms / 1000)
```

**Confidence: High.**

**Relevance to GreedySearch: Low.** Your extractors use URL-parameter queries (e.g., `https://perplexity.ai/?q=...`) or clipboard injection, not character-by-character typing into chat inputs. If you ever needed to type into a chat, the `cdp.input_.insert_text()` approach is already what you'd want.

### 7.3 Paginated Debug Logging

**File:** `src/debug_logger.py` (not read — only referenced)

**Confidence: Very Low.** I saw the function names `get_debug_view_paginated`, `clear_debug_view_safe`, `export_to_file_paginated` referenced in `server.py` but did not read the implementation. Claims about JSON/pickle/gzip-pickle format support are inferred from the `format` parameter in `export_debug_logs`.

**Relevance to GreedySearch: Low.** You have your own logging system.

---

## 8. Element Cloning

### 8.1 CDP-Based Element Cloner

**Files:** `src/cdp_element_cloner.py`, `src/comprehensive_element_cloner.py`, `src/progressive_element_cloner.py`, `src/element_cloner.py`, `src/file_based_element_cloner.py` — 6+ files (not read)

**Confidence: Very Low.** I saw the imports in `server.py` and the tool names (`extract_element_styles`, `extract_element_structure`, etc.) but did not read any of the implementation. The "300+ CSS properties," "React/Vue event detector" claims are from the README, not code review.

**Relevance to GreedySearch: NONE.** Element cloning is a completely different use case from answer extraction.

### 8.2 JS Injectors for Element Extraction

**Files:** `src/js/*.js` (7 files, not read)

**Confidence: Very Low.** Listed in the file tree only.

**Pattern note:** The approach of injecting full JS scripts and then calling them from Python is interesting. GreedySearch already does this for clipboard interception (`injectClipboardInterceptor`) and stream waits. Not new ground.

---

## 9. Security Considerations

### 9.1 Hook System Sandbox Weakness

**Severity: HIGH (verified)**

I read `dynamic_hook_system.py` in full. The `exec()` sandbox is weak:

- `__builtins__` is restricted to ~10 functions
- But `HookAction` (a real class) is in the namespace
- Standard Python jailbreak: `HookAction.__class__.__mro__[-1].__subclasses__()` returns `<class 'type'>` and all loaded subclasses, including `os._wrap_close`, `subprocess.Popen`, etc.
- The `print` replacement is a lambda — harmless but also not a real sandbox

**Verdict:** Unsafe for production. GreedySearch-pi should not adopt this pattern. Documented in the repo as "AI-generated Python functions" with a vague note about safety — the safety is not real.

### 9.2 CDP Function Executor

**Severity: MEDIUM (claimed, not verified)**

The `execute_cdp_command()` tool allegedly exposes ALL CDP commands. I did not read `cdp_function_executor.py`, so I cannot confirm the exact command allowlist (if any). The risk model is:

- If commands are unfiltered: an AI can call `Browser.grantPermissions`, `Storage.clearDataForOrigin`, etc.
- If commands are allowlisted: the risk depends on what's allowed

**Verdict:** Without reading the implementation, I cannot rate this accurately. Treat as "possible risk" until verified.

**Relevance to GreedySearch: Low.** Your `bin/cdp-greedy.mjs` is a CLI for development, not exposed to AI agents.

### 9.3 File Upload Security

**File:** `src/file_upload_security.py` (not read)

**Confidence: Low.** I saw the `validate_upload_paths` function imported into `dom_handler.py` and the env var `BROWSER_FILE_UPLOAD_ALLOWED_DIRS` documented in README, but did not read the implementation.

**Relevance to GreedySearch: N/A** (no file upload feature).

### 9.4 HTTP Transport Auth

**File:** `src/http_security.py` (not read)

**Confidence: Low.** Documented in README: `STEALTH_BROWSER_MCP_AUTH_TOKEN` enables bearer-token auth for HTTP transport. `stdio` transport has no auth (safe for local use).

**Relevance to GreedySearch: N/A** (you use stdio via Pi).

---

## 10. Test & Validation Practices

### 10.1 STEALTH_TESTS.md Methodology

**File:** `STEALTH_TESTS.md` (read in full)

The empirical testing approach is solid and worth adopting:

| Test | Result | URL |
|------|--------|-----|
| CreepJS fingerprint analysis | 0% headless, 0% stealth detection | `https://abrahamjuliot.github.io/creepjs/` |
| Sannysoft Bot Detection | 20/20 (all checks passed) | `https://bot.sannysoft.com/` |
| Intoli Headless Detection | All parameters cleared | `https://intoli.com/blog/not-possible-to-block-chrome-headless/chrome-headless-test.html` |
| Cloudflare Challenge | Automated bypass | `https://nowsecure.nl/` |
| X.com login wall | DOM manipulation bypass | `https://x.com/` |

**Test date:** February 10, 2026

**Confidence: High** for the URLs and methodology. The specific pass rates are from their tests, not mine.

**Relevance to GreedySearch: High.**

This is the most concrete, actionable finding. A `npm run stealth-check` script that:

1. Spawns GreedySearch Chrome (headless + visible)
2. Navigates to each test URL
3. Extracts the fingerprint report
4. Compares against expected "clean" values
5. Fails the CI run if regressions appear

…would catch stealth-patch regressions early. The test URLs themselves are the most valuable part — they are the right fingerprints to validate against.

### 10.2 COMPARISON.md

**File:** `COMPARISON.md` (read in full)

Compares against Playwright MCP across:

- Cloudflare / Queue-It bypass
- Banking / Gov portals
- Social media automation
- UI element cloning
- Network debugging
- API reverse engineering
- Dynamic hook system
- Modular architecture
- Total tools (97 vs ~20)

**Confidence: High** for the content, **Low** for the objectivity (it's their own comparison doc, naturally favorable).

**Relevance to GreedySearch: Low.** You could write your own comparison doc vs other web search MCP tools, but this isn't a direct port.

---

## 11. Portable Code Patterns (confidence-rated)

This table is **replaced** from the original. Each row now includes a confidence rating based on how thoroughly I read the source.

| Pattern | Source file | Confidence in pattern | Confidence in priority | Notes |
|---------|-------------|----------------------|------------------------|-------|
| `_is_recoverable_navigation_error()` | `browser_manager.py` | High | Medium | Marker list is solid; may not fix specific GreedySearch symptoms |
| Tab recycling at `NAVIGATION_RECYCLE_THRESHOLD=25` | `browser_manager.py` | High | Medium-Low | Useful pattern but root cause of GreedySearch issues unclear |
| `_apply_timezone_override()` via CDP | `browser_manager.py` | High | Medium | Small, safe addition |
| Budget-splitting timeout pattern | `browser_manager.py` | High | Medium | Port the idea, not the `networkidle` impl (it's a 2s sleep) |
| `cdp.input_.insert_text()` for bulk paste | `dom_handler.py` | High | Low | GreedySearch already has equivalent approaches |
| `check_browser_executable()` (multi-platform) | `platform_utils.py` | Low | Medium | File not read in full; claims are inferred |
| `merge_browser_args()` (strip conflicting args) | `platform_utils.py` | Low | Low | Not read |
| Process cleanup with deferred profiles | `process_cleanup.py` | Low | Probably High | File not read in full; claims are size-based |
| Resource blocking patterns | `network_interceptor.py` | High | Low | Speedup uncertain; needs measurement |
| Section-based tool registration | `server.py` | Medium | Low | Organizational pattern, not a perf win |
| Stealth test URLs (CreepJS, Sannysoft, Intoli) | `STEALTH_TESTS.md` | High | High | Most actionable finding in the whole review |

### What I'm NOT Confident Enough to Recommend

- **Specific process cleanup mechanics** — the file is 30K chars; I read maybe 5%. The "graceful kill, orphan detection" claims could be right or could be a thin wrapper around `os.kill`.
- **`platform_utils.py` browser detection quality** — the function names suggest thoroughness, but I didn't read the implementations.
- **Multi-platform Edge/Chrome path coverage** — README claims Windows/macOS/Linux/Docker; I didn't verify the actual paths searched.
- **Dynamic hook system stability** — I read the code but didn't test it. There may be subtle bugs (e.g., the unbounded `asyncio.create_task` spawning on each `RequestPaused` event).

### What I Would Not Port Even If It Were Perfect

- **Dynamic hook system** — `exec()` of AI prompts is a security vulnerability regardless of the surrounding code quality.
- **Element cloning** — unrelated to your use case.
- **Raw CDP command exposure** — too permissive for a tool installed in user environments.

---

## 12. Summary Matrix

| Category | Score (1-5) | Confidence in score | Notes |
|----------|-------------|---------------------|-------|
| Architecture patterns | ⭐⭐⭐⭐⭐ | Medium | Section-based tools, multi-instance manager, FastMCP lifespan — verified for the parts I read |
| Stealth techniques | ⭐⭐ | Low-Medium | Their patches are minimal; my "GreedySearch wins" claim is design-intent, not empirical |
| CDP usage patterns | ⭐⭐⭐⭐ | High | Tab recycling, error recovery, wait conditions are concrete code |
| Network interception | ⭐⭐⭐⭐⭐ | High (for the code), Low (for "best-in-class" vs alternatives) | Rich feature set, but I haven't compared to Playwright HAR, Puppeteer, etc. |
| Dynamic hooks (AI→Python) | ⭐ | High | The pattern is interesting; the `exec()` sandbox is genuinely weak |
| Element cloning | ⭐⭐⭐⭐⭐ | Very Low | Score is for the feature itself, not my verification of it |
| Process lifecycle | ⭐⭐⭐⭐⭐ | Low | File is 30K chars but I read ~5% |
| Security patterns | ⭐⭐ | High for hook system, Low for others | Hook system is unsafe (verified); others not read |
| Testing methodology | ⭐⭐⭐⭐⭐ | High | Stealth test suite is directly portable |
| Documentation quality | ⭐⭐⭐⭐ | High | Good README, detailed env-var docs |

### Overall: ~3.5 / 5 (with wide confidence intervals)

The score is driven up by the directly-verifiable portable patterns (tab recycling, error recovery, test URLs) and down by the unverified claims (process cleanup, platform utilities). Net positive but not as definitive as the first version presented.

---

## 13. Recommendations

### Confident Recommendations (High Confidence)

1. **Adopt the stealth test URLs.** CreepJS, Sannysoft, and Intoli are the right fingerprints. Add a `npm run stealth-check` script that navigates to each and checks the result. This catches stealth-patch regressions even if you don't port any other code from this repo.

2. **Consider tab recycling for `all` mode.** Even if it doesn't fix the specific symptoms in AGENTS.md, a 25-navigation tab-recycle threshold is a defensive measure that costs little. Add it to `common.mjs` `getOrOpenTab`.

3. **Add the recoverable-navigation-error marker list.** The pattern of "retry with fresh tab on connection drop / websocket failure / target closed" is low-risk and catches a real failure mode.

### Probable Recommendations (Medium Confidence)

1. **Audit `process_cleanup.py` before deciding to port.** The file is large enough that it probably has value, but I cannot confirm without reading it. Recommendation: spend 30 minutes reading it before deciding.

2. **Add timezone override via CDP if you don't already.** Small, safe, and GreedySearch's `/set-greedy-locale` may or may not already do this — I didn't read the full GreedySearch source to confirm.

3. **Adopt the budget-splitting timeout pattern.** The `navigate → wait condition → get URL/title` budget split is a clean pattern. Don't copy the `networkidle = asyncio.sleep(2)` implementation — it's a placeholder, not real network-idle detection.

### Recommendations Against Porting (High Confidence)

1. **Do not port the dynamic hook system.** The `exec()` sandbox is genuinely weak. Standard Python jailbreak techniques work. If you want user-extensible network interception, do it with a typed schema (JSON request/response, not arbitrary Python).

2. **Do not port element cloning.** Unrelated to your use case.

3. **Do not expose raw CDP commands to AI agents.** Your `bin/cdp-greedy.mjs` is a fine developer tool. Don't add a server-level equivalent.

### Areas Where I Was Wrong or Overconfident in v1

- **"GreedySearch wins on stealth depth"** — I have full test data for stealth-browser-mcp and design intent for GreedySearch. In empirical terms, stealth-browser-mcp is currently better-validated. GreedySearch's design is plausibly deeper, but unproven.
- **"Process cleanup is directly portable"** — I made this claim without reading the file in full. The character count suggests complexity, but I cannot confirm the quality.
- **"3.5/5 overall"** — with the confidence intervals now explicit, the honest range is 3.0-4.0 depending on what the unread files actually contain.
- **The priority table in section 11** — I gave confident "High/Medium/Low" ratings without confidence labels. Some of those ratings were based on weak evidence (e.g., I rated process cleanup as High priority because the file is 30K chars, which is a poor proxy for quality).

---

## 14. What I'd Want to Read Before Being More Definitive

To upgrade this from "informed opinion" to "verified assessment":

1. **`process_cleanup.py` in full** — confirms or refutes the lifecycle claims
2. **`platform_utils.py` in full** — confirms multi-platform browser detection
3. **`dynamic_hook_ai_interface.py`** — may explain how AI is supposed to use the hook system
4. **`server.py` lines 1588-2969** — second half has more tool definitions
5. **Live testing** — run both GreedySearch and stealth-browser-mcp against the same test URLs and compare

Without those, treat the High-Confidence recommendations as solid and the Medium-Confidence ones as "probably worth a look, but verify before porting."

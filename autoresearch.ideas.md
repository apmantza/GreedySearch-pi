# Inspiration from browser-use-rs (BB-fat/browser-use-rs)

Source: https://github.com/BB-fat/browser-use-rs
Analyzed: 2026-05-08

## Update: ARIA Bing extractor built

✅ `extractors/bing-aria.mjs` — working prototype (registered as `bing2`).

- ARIA tree extraction: ~4ms JS time, locale-agnostic (structural roles/classes only).
- Hybrid clipboard sources: click copy button once (~400ms) for real source URLs.
- Cleaner than original: 1 path vs 4 fallbacks, no hydration delay, no retry loops.
- Limitation: Copilot `ca://` links hide real URLs — hybrid clipboard step needed for sources.
- Kept as dead code for now, to be improved later.

## 1. ARIA-based DOM extraction for answer scraping (HIGH impact)

**Current GreedySearch approach:**

- Bing: copy button → clipboard polling → DOM text fallback → iframe detection. Fragile — the 800ms hydration delay is a hack, clipboard interception races React handlers.
- Perplexity: clipboard interception + language-agnostic copy button finder.
- Both rely on clicking the copy button and reading clipboard, with DOM text as degraded fallback.

**browser-use-rs pattern:** The `extract_dom.js` script (inspired by Playwright's `ariaSnapshot`) builds an ARIA accessibility tree from the live DOM, assigning numeric indices to all visible interactive elements. It strips noise (style/script/noscript, display:none, aria-hidden), normalizes text, resolves shadow DOM, and computes bounding boxes. The result is a compact, structured tree that LLMs can consume directly.

**What GreedySearch could adopt:**

- Replace clipboard-based extraction with ARIA-tree extraction of answer containers. No more copy button races, no more 800ms hydration waits.
- Recognize answer regions by ARIA role (`role: "region"`, `role: "article"`) rather than fragile DOM selectors like `#\:r1\:`.
- Handle iframe-sandboxed Bing responses by detecting `role: "iframe"` and recursing into the iframe tree.
- Extract code blocks, lists, headings, and links with proper structure — richer context for synthesis.
- The index-based element targeting means we can `click(index=3)` instead of finding ephemeral React className selectors.

**Key differentiator:** ARIA trees are designed for screen readers, so they're stable across React re-renders (roles don't change even when CSS classes do). This is a massive reliability win for the fragile Bing/Perplexity extractors.

## 2. Tool registries and typed params for extractors (MEDIUM impact)

**Current GreedySearch approach:** Each extractor (bing-copilot.mjs, perplexity.mjs, google-ai.mjs) is a standalone script with ad-hoc parameter passing via CLI args and env vars. No shared interface, no schema validation, no registry.

**browser-use-rs pattern:** A clean `Tool` trait with associated `Params` types (serde + JSON Schema), a `ToolRegistry` for dynamic dispatch, and a `ToolContext` (session + cached DOM). The `register_mcp_tools!` macro auto-generates MCP server wrappers from the internal tools. Each tool's params are self-documenting via JSON Schema.

**What GreedySearch could adopt:**

- Define an `Extractor` interface with typed params (query, locale, timeout, headless/visible).
- `ExtractorRegistry` to discover and dispatch extractors by engine name.
- JSON Schema on params for self-documentation and validation.
- Cached DOM tree in the context (extract once, query multiple times).

**Benefit:** Easier to add new search engines, better error messages, less ad-hoc CLI arg parsing.

## 3. Dual element selection: CSS selectors + numeric indices (MEDIUM impact)

**Current GreedySearch approach:** Extractor selectors (in `selectors.mjs`) use CSS selectors and sometimes text-based finders. React-generated class names (`#\:r1\:`, `.__ljq7mu`) are brittle.

**browser-use-rs pattern:** Every tool accepts either a CSS selector or a numeric index. Indices come from the DOM extraction step — `extract_dom()` assigns sequential indices to visible interactive elements. `ClickParams { selector: Option<String>, index: Option<usize> }` with validation that exactly one is provided. Indexes get resolved to selectors via `DomTree.get_selector(index)`.

**What GreedySearch could adopt:**

- After ARIA extraction of the answer container, index interactive elements within it.
- Use indices for any interaction (click copy button, expand section, dismiss dialogs).
- Indices are more resilient than React class names — they survive minor DOM diffs as long as element count/order doesn't shift.
- Could even let LLM agents target elements by index in future interactive search modes.

## 4. Readability / markdown conversion for deep research (LOW-MEDIUM impact)

**Current GreedySearch approach:** In `depth: "deep"`, source URLs are fetched but raw HTML is used. No readability extraction, no markdown conversion.

**browser-use-rs pattern:** Includes `Readability.min.js` for content extraction and `html_to_markdown.rs` / `convert_to_markdown.js` for converting extracted content to markdown. Also has a `read_links` tool that extracts all links from the page.

**What GreedySearch could adopt:**

- When fetching source pages in deep mode, run Readability.js to extract just the article content.
- Convert to markdown for token-efficient LLM consumption in synthesis.
- Could significantly improve synthesis quality in deep research mode.

## 5. Snapshot-based state capture for debugging (LOW impact)

**browser-use-rs pattern:** `snapshot.rs` captures the full ARIA tree at a point in time. Useful for debugging ("what did the browser see when we tried to click?").

**What GreedySearch could adopt:**

- Take ARIA snapshots before/after extraction attempts.
- Log snapshots on failure for post-mortem debugging.
- Would make debugging Bing extraction failures much easier — see exactly what the DOM looked like when the copy button wasn't found.

## 6. Pure Rust CDP layer — not practical now, but note for later

**browser-use-rs approach:** Zero Node.js — pure Rust using `headless_chrome` crate for CDP. Much lighter runtime, faster startup, smaller footprint.

**For GreedySearch:** A full Rust rewrite isn't practical given the Pi/jiti/Node.js ecosystem integration. BUT — some performance-critical paths could be Rust WASM or Rust native addons:

- The DOM extraction JS script (currently injected via CDP evaluate)
- The stealth patches (canvas/WebGL fingerprinting)
- The CDP daemon communication layer

This is a long-term consideration, not actionable now.

## Quick wins (in priority order)

1. **Port `extract_dom.js` concept to a GreedySearch answer extractor** — An ARIA-tree-based extraction for Bing would eliminate the clipboard race, the 800ms delay, and the DOM fallback complexity. Replace ~300 lines of fragile Bing extraction with ~100 lines of ARIA tree walking.
2. **Add readability+markdown for deep mode source fetching** — Easy to add, immediate quality improvement for synthesis.
3. **Snapshot on extraction failure** — Trivial to add, huge debugging value.

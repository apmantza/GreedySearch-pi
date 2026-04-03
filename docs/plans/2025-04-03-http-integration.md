# GreedySearch HTTP Integration & Deep Research Merge Plan

> **For Pi:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Integrate HTTP source fetching with Readability extraction into search.mjs, replacing the basic regex-based fetcher. Merge "deep research" into the default flow so all multi-engine searches include source fetching + synthesis.

**Architecture:** Replace `fetchSourceContent()` with HTTP-first Readability-based extraction. Default "all" engine searches now always fetch top sources (HTTP parallel) and synthesize. Remove --deep-research flag—make it the standard behavior.

**Tech Stack:** Node.js ESM, JSDOM, @mozilla/readability, turndown

---

## Current State

- `search.mjs` has basic `fetchSourceContent()` using regex HTML stripping
- Deep research mode (`--deep-research`) is opt-in, fetches 5 sources sequentially
- `src/fetcher.mjs` exists with Readability-based extraction (tested, 90% success rate)
- Fast mode exists for single-engine quick queries (no synthesis)

## Target State

- All `search.mjs all "query"` runs: extractors → source fetch (HTTP) → synthesis
- HTTP fetching is parallel (Promise.all) vs sequential browser tabs
- Readability extraction: structured markdown vs plain text soup
- ~3x faster deep research (9s vs 32s observed in testing)

---

### Task 1: Import HTTP Fetcher Module

**Files:**
- Modify: `search.mjs:1-20` (add import)

**Step 1: Add import statement after existing imports**

```javascript
import { fetchSourceHttp, shouldUseBrowser } from "./src/fetcher.mjs";
```

**Step 2: Verify import works**

Run: `node -e "import('./search.mjs').then(() => console.log('Import OK')).catch(e => console.error(e.message))"`

Expected: "Import OK" or no error

**Step 3: Commit**

```bash
git add search.mjs
git commit -m "refactor: import HTTP fetcher module in search.mjs"
```

**Verification:**
- [ ] Import statement added at top of search.mjs
- [ ] No syntax errors on import
- [ ] Commit made

---

### Task 2: Create HTTP-First Source Fetcher Wrapper

**Files:**
- Modify: `search.mjs:714-770` (replace fetchSourceContent)

**Step 1: Replace fetchSourceContent with HTTP-first version**

Replace the entire `fetchSourceContent` function (lines ~714-770):

```javascript
/**
 * Fetch source content via HTTP with Readability extraction.
 * Falls back to browser if HTTP fails or content quality is low.
 * @param {string} url - URL to fetch
 * @param {number} maxChars - Max characters to return
 * @returns {Promise<object>} Fetch result
 */
async function fetchSourceContent(url, maxChars = 8000) {
	const start = Date.now();

	// Try HTTP first
	const httpResult = await fetchSourceHttp(url, { timeoutMs: 15000 });

	if (httpResult.ok) {
		const content = httpResult.markdown.slice(0, maxChars);
		return {
			url,
			finalUrl: httpResult.finalUrl,
			status: httpResult.status,
			contentType: "text/markdown",
			lastModified: "",
			title: httpResult.title,
			snippet: httpResult.excerpt,
			content,
			contentChars: content.length,
			source: "http",
			duration: Date.now() - start,
		};
	}

	// HTTP failed or blocked - fall back to browser
	process.stderr.write(`[greedysearch] HTTP failed for ${url.slice(0, 60)}, trying browser...\n`);
	return await fetchSourceContentBrowser(url, maxChars);
}

/**
 * Browser fallback for source fetching (original CDP-based method)
 */
async function fetchSourceContentBrowser(url, maxChars = 8000) {
	const start = Date.now();
	const tab = await openNewTab();

	try {
		await cdp(["nav", tab, url], 30000);
		await new Promise((r) => setTimeout(r, 1500));

		const content = await cdp([
			"eval",
			tab,
			`
			(function(){
				var el = document.querySelector('article, [role="main"], main, .post-content, .article-body, #content, .content');
				var text = (el || document.body).innerText;
				return JSON.stringify({
					title: document.title,
					content: text.replace(/\\s+/g, ' ').trim(),
					url: location.href
				});
			})()
		`,
		]);

		const parsed = JSON.parse(content);
		const finalContent = parsed.content.slice(0, maxChars);

		return {
			url,
			finalUrl: parsed.url || url,
			status: 200,
			contentType: "text/plain",
			lastModified: "",
			title: parsed.title,
			snippet: trimText(finalContent, 320),
			content: finalContent,
			contentChars: finalContent.length,
			source: "browser",
			duration: Date.now() - start,
		};
	} catch (error) {
		return {
			url,
			title: "",
			content: null,
			snippet: "",
			contentChars: 0,
			error: error.message,
			source: "browser",
			duration: Date.now() - start,
		};
	} finally {
		await closeTab(tab);
	}
}
```

**Step 2: Test the new fetcher**

Run: `node -e "import('./search.mjs').then(m => console.log('Syntax OK')).catch(e => console.error(e.message))"`

Expected: "Syntax OK"

**Step 3: Commit**

```bash
git add search.mjs
git commit -m "feat: replace fetchSourceContent with HTTP-first Readability extraction"
```

**Verification:**
- [ ] fetchSourceContent uses HTTP fetcher first
- [ ] fetchSourceContentBrowser fallback preserved
- [ ] Both functions have source field ("http" | "browser")
- [ ] Commit made

---

### Task 3: Parallel HTTP Source Fetching

**Files:**
- Modify: `search.mjs:776-830` (replace fetchMultipleSources)

**Step 1: Replace fetchMultipleSources with parallel version**

Replace the entire `fetchMultipleSources` function:

```javascript
async function fetchMultipleSources(sources, maxSources = 5, maxChars = 8000) {
	process.stderr.write(
		`[greedysearch] Fetching content from ${Math.min(sources.length, maxSources)} sources via HTTP (parallel)...\n`,
	);

	const toFetch = sources.slice(0, maxSources);

	// Fetch all sources in parallel via HTTP
	const fetchPromises = toFetch.map(async (s, index) => {
		const url = s.canonicalUrl || s.url;
		process.stderr.write(
			`[greedysearch] [${index + 1}/${toFetch.length}] Fetching: ${url.slice(0, 60)}...\n`,
		);

		const result = await fetchSourceContent(url, maxChars);

		return {
			id: s.id,
			...result,
		};
	});

	const fetched = await Promise.all(fetchPromises);

	// Log summary
	const successful = fetched.filter((f) => f.content && f.content.length > 100);
	const httpCount = fetched.filter((f) => f.source === "http").length;
	const browserCount = fetched.filter((f) => f.source === "browser").length;

	process.stderr.write(
		`[greedysearch] Fetched ${successful.length}/${fetched.length} sources ` +
		`(HTTP: ${httpCount}, Browser: ${browserCount})\n`,
	);

	return fetched;
}
```

**Step 2: Verify syntax**

Run: `node -e "import('./search.mjs').then(() => console.log('OK')).catch(e => console.log(e.message))"`

Expected: "OK"

**Step 3: Commit**

```bash
git add search.mjs
git commit -m "refactor: parallel HTTP source fetching (was sequential browser tabs)"
```

**Verification:**
- [ ] fetchMultipleSources uses Promise.all for parallel fetching
- [ ] Summary stats logged (HTTP vs Browser count)
- [ ] Commit made

---

### Task 4: Merge Deep Research into Default Flow

**Files:**
- Modify: `search.mjs:1073-1120` (CLI argument parsing)
- Modify: `search.mjs:1158-1215` (main flow logic)

**Step 4.1: Update CLI argument parsing**

Find the depth parsing section (~line 1073-1095) and replace:

```javascript
// Parse --depth or fall back to deprecated flags
const depthIdx = args.indexOf("--depth");
let depth = "fast"; // default for single engine
if (depthIdx !== -1 && args[depthIdx + 1]) {
	depth = args[depthIdx + 1];
} else if (args.includes("--deep-research")) {
	depth = "deep";
} else if (args.includes("--synthesize")) {
	depth = "standard";
}

// For "all" engine, default to standard+fetch if not specified
const engineArg = args.find((a) => !a.startsWith("--"))?.toLowerCase();
if (
	engineArg === "all" &&
	depthIdx === -1 &&
	!args.includes("--deep-research") &&
	!args.includes("--synthesize")
) {
	depth = "standard";
}
```

With:

```javascript
// Depth modes: fast (no synthesis), standard (synthesis+fetch), research (synthesis+more fetch)
const depthIdx = args.indexOf("--depth");
let depth = "standard"; // DEFAULT: all "all" searches now include synthesis + source fetch

if (depthIdx !== -1 && args[depthIdx + 1]) {
	depth = args[depthIdx + 1];
} else if (args.includes("--fast")) {
	depth = "fast"; // Explicit fast mode requested
}

// For single engine (not "all"), default to fast unless explicit
const engineArg = args.find((a) => !a.startsWith("--"))?.toLowerCase();
if (engineArg !== "all" && depthIdx === -1 && !args.includes("--fast")) {
	// Single engine: default to fast for speed (no synthesis overhead)
	depth = "fast";
}

// --deep-research flag now just means "research" depth (more sources)
if (args.includes("--deep-research")) {
	depth = "research";
}
```

**Step 4.2: Update the filter to keep --fast flag**

Find the rest filter (~line 1100) and update:

```javascript
const rest = args.filter(
	(a, i) =>
		a !== "--full" &&
		a !== "--short" &&
		a !== "--fast" &&           // ADD: keep --fast as valid flag
		a !== "--fetch-top-source" &&
		a !== "--synthesize" &&     // DEPRECATED: now default
		a !== "--deep-research" &&  // DEPRECATED: now "research" depth
		a !== "--inline" &&
		a !== "--depth" &&
		a !== "--out" &&
		(depthIdx === -1 || i !== depthIdx + 1) &&
		(outIdx === -1 || i !== outIdx + 1),
);
```

**Step 4.3: Update main flow logic**

Find the engine === "all" block (~line 1158) and update the source fetching logic:

Replace:
```javascript
if (depth === "deep") {
	process.stderr.write("PROGRESS:deep-research:start\n");
	const fetchedSources =
		out._sources.length > 0
			? await fetchMultipleSources(out._sources, 5, 8000)
				: [];

	out._sources = mergeFetchDataIntoSources(out._sources, fetchedSources);
	out._fetchedSources = fetchedSources;
	process.stderr.write(
		out._sources.length > 0
			? "PROGRESS:deep-research:done\n"
			: "PROGRESS:deep-research:no-sources\n",
	);
}
```

With:
```javascript
// Source fetching: default for all "all" searches (was deep-research only)
if (depth !== "fast" && out._sources.length > 0) {
	const fetchCount = depth === "research" ? 8 : 5; // More sources in research mode
	const maxChars = depth === "research" ? 12000 : 8000;

	process.stderr.write("PROGRESS:source-fetch:start\n");
	const fetchedSources = await fetchMultipleSources(out._sources, fetchCount, maxChars);

	out._sources = mergeFetchDataIntoSources(out._sources, fetchedSources);
	out._fetchedSources = fetchedSources;
	process.stderr.write("PROGRESS:source-fetch:done\n");
}
```

**Step 4.4: Update synthesis flag**

Replace:
```javascript
// Synthesize with Gemini for standard and deep modes
if (depth !== "fast") {
```

With:
```javascript
// Synthesize with Gemini for all non-fast modes (now default)
if (depth !== "fast") {
```

**Step 4.5: Remove grounded flag dependency on depth === "deep"**

Replace:
```javascript
const synthesis = await synthesizeWithGemini(query, out, {
	grounded: depth === "deep",
```

With:
```javascript
const synthesis = await synthesizeWithGemini(query, out, {
	grounded: depth !== "fast", // Always grounded when we have sources
```

**Step 4.6: Update confidence metrics**

Replace:
```javascript
if (depth === "deep") out._confidence = buildConfidence(out);
```

With:
```javascript
// Always include confidence metrics for non-fast searches
if (depth !== "fast") out._confidence = buildConfidence(out);
```

**Step 4.7: Update help text**

Find and update the help text (~line 1058):

Replace:
```
"  --deep-research     Full research: full answers + source fetching + synthesis",
```

With:
```
"  --fast              Quick mode: no source fetching or synthesis (default for single engine)",
"  --depth research    Deeper research: fetch more sources (8 vs 5), longer content",
```

**Step 4.8: Commit**

```bash
git add search.mjs
git commit -m "feat: merge deep-research into default flow; all 'all' searches now synthesize + fetch sources"
```

**Verification:**
- [ ] Default depth for "all" engine is "standard" (synthesis + 5 sources)
- [ ] --fast flag explicitly disables synthesis/fetching
- [ ] --deep-research flag still works (maps to "research" depth)
- [ ] Single engine defaults to "fast" for speed
- [ ] Help text updated
- [ ] Commit made

---

### Task 5: Update mergeFetchDataIntoSources for Source Tracking

**Files:**
- Modify: `search.mjs:find mergeFetchDataIntoSources function`

**Step 1: Update mergeFetchDataIntoSources to track source type**

Find `mergeFetchDataIntoSources` (around line ~530) and update:

```javascript
function mergeFetchDataIntoSources(sources, fetchedSources) {
	const byId = new Map(fetchedSources.map((source) => [source.id, source]));
	return sources.map((source) => {
		const fetched = byId.get(source.id);
		if (!fetched) return source;

		const title = pickPreferredTitle(source.title, fetched.title || "");
		return {
			...source,
			title: title || source.title,
			fetch: {
				attempted: true,
				ok: !fetched.error && fetched.contentChars > 100,
				status: fetched.status || null,
				finalUrl: fetched.finalUrl || fetched.url || source.canonicalUrl,
				contentType: fetched.contentType || "",
				lastModified: fetched.lastModified || "",
				title: fetched.title || "",
				snippet: fetched.snippet || "",
				contentChars: fetched.contentChars || 0,
				source: fetched.source || "unknown", // "http" | "browser"
				duration: fetched.duration || 0,
				error: fetched.error || "",
			},
		};
	});
}
```

**Step 2: Commit**

```bash
git add search.mjs
git commit -m "feat: track HTTP vs Browser source in merged fetch data"
```

**Verification:**
- [ ] mergeFetchDataIntoSources includes source field (http/browser)
- [ ] Includes duration field for performance tracking
- [ ] Commit made

---

### Task 6: Integration Test

**Files:**
- Test: Run actual search command

**Step 1: Test the new default flow**

Run: `node search.mjs all "Node.js streams best practices" --inline 2>&1 | head -50`

Expected output shows:
- "PROGRESS:source-fetch:start"
- Multiple "Fetching:" lines
- "PROGRESS:synthesis:start"
- "PROGRESS:synthesis:done"
- Valid JSON output with `_sources` and `_synthesis`

**Step 2: Test fast mode**

Run: `node search.mjs all "test query" --fast --inline 2>&1 | head -30`

Expected:
- NO "PROGRESS:source-fetch" messages
- NO "PROGRESS:synthesis" messages
- JSON output without `_fetchedSources`

**Step 3: Test single engine (should default to fast)**

Run: `node search.mjs p "test query" --inline 2>&1 | head -20`

Expected:
- Quick response
- No synthesis/source fetching

**Step 4: Commit test results (if any fixes needed)**

If tests pass:
```bash
git commit --allow-empty -m "test: integration tests passed for HTTP fetch + merged deep-research"
```

If fixes needed:
```bash
# Make fixes, then:
git add search.mjs
git commit -m "fix: address issues from integration testing"
```

**Verification:**
- [ ] Default "all" search includes source fetch + synthesis
- [ ] --fast flag disables fetch + synthesis
- [ ] Single engine defaults to fast
- [ ] All tests pass
- [ ] Commit made

---

### Task 7: Update Documentation

**Files:**
- Modify: `README.md`

**Step 1: Update README to reflect new default behavior**

Find the usage section and update:

Replace:
```markdown
### Deep Research Mode

For comprehensive research with source verification:

```bash
node search.mjs all "your complex question" --deep-research
```

This will:
1. Query all engines
2. Fetch content from top sources
3. Synthesize a grounded answer
```

With:
```markdown
### Default Behavior (Multi-Engine)

All multi-engine searches now include source fetching and synthesis by default:

```bash
node search.mjs all "your question"
```

This will:
1. Query Perplexity, Bing Copilot, and Google AI
2. Fetch content from top 5 sources via HTTP (with Readability extraction)
3. Synthesize a grounded answer with source citations

**Speed**: ~10-15 seconds (was ~30s with browser-only fetching)

### Fast Mode

Skip source fetching and synthesis for quick answers:

```bash
node search.mjs all "quick question" --fast
```

### Deeper Research

Fetch more sources (8 vs 5) with longer content:

```bash
node search.mjs all "complex question" --depth research
```
```

**Step 2: Add section about HTTP fetching**

Add after the usage section:

```markdown
## Source Fetching

GreedySearch now uses HTTP-first source fetching with Mozilla Readability for content extraction:

- **HTTP**: Fast (~200-800ms), parallel, structured markdown output
- **Browser fallback**: Only when HTTP fails (bot protection, JS-heavy sites)
- **Typical success rate**: 90%+ of documentation sites work via HTTP

The old regex-based HTML stripping has been replaced with professional-grade content extraction that preserves document structure, code blocks, and headings.
```

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README for merged deep-research and HTTP source fetching"
```

**Verification:**
- [ ] README reflects new default behavior
- [ ] Documents --fast and --depth research flags
- [ ] Documents HTTP fetching advantages
- [ ] Commit made

---

### Task 8: Cleanup Deprecated Flags

**Files:**
- Modify: `search.mjs` (remove deprecated flag warnings if any)

**Step 1: Optionally add deprecation warnings**

If desired, add subtle deprecation warnings for old flags. This is optional since we're keeping backward compatibility.

**Step 2: Final test of all flag combinations**

Test matrix:

```bash
# Test all combinations
node search.mjs all "test" --fast                    # Fast mode
node search.mjs all "test" --depth research          # Research depth
node search.mjs all "test"                           # Default (standard)
node search.mjs all "test" --deep-research           # Backward compat
node search.mjs p "test"                             # Single engine (fast)
node search.mjs p "test" --full                      # Single engine full
```

All should work without errors.

**Step 3: Final commit**

```bash
git commit --allow-empty -m "feat: HTTP source fetching integrated, deep-research merged into default flow"
```

**Verification:**
- [ ] All flag combinations tested
- [ ] No errors
- [ ] Final commit made

---

## Summary

After this plan is executed:

1. **HTTP fetching is primary**: `fetchSourceContent` tries HTTP first, falls back to browser
2. **Parallel fetching**: All sources fetched simultaneously via HTTP (was sequential browser tabs)
3. **Readability extraction**: Clean markdown vs regex-stripped text
4. **Deep research is default**: All `search.mjs all` queries now synthesize + fetch sources
5. **--fast flag**: Explicit opt-out for quick queries
6. **90%+ success rate**: HTTP works for most docs, browser fallback for rest
7. **~3x faster**: 10s vs 30s observed in testing

---

**Execute with:** superpowers:subagent-driven-development

// src/search/fetch-source.mjs — HTTP and browser-based source content fetching
//
// Extracted from search.mjs.  PRIMARY path uses Chrome's network stack
// (fetch() over CDP) to produce authentic Chrome TLS/JA3 fingerprints.
// Falls back to Node.js HTTP (via fetcher.mjs) if Chrome is unavailable.

import {
	fetchSourceHttp,
	extractContent,
	detectBotBlock,
	checkContentQuality,
	defaultFetchHeaders,
	isPrivateUrl,
} from "../fetcher.mjs";
import { fetchGitHubContent, parseGitHubUrl } from "../github.mjs";
import { fetchRedditContent, parseRedditUrl } from "../reddit.mjs";
import { trimContentHeadTail } from "../utils/content.mjs";
import { cdp, closeTab, openNewTab } from "./chrome.mjs";
import { SOURCE_FETCH_CONCURRENCY } from "./constants.mjs";
import { extractPdfMarkdown } from "./pdf.mjs";
import { trimText } from "./sources.mjs";

/**
 * Fetch a URL using Chrome's Network.loadNetworkResource (Chrome 124+).
 * This uses Chrome's native network stack (authentic TLS/JA3 fingerprint)
 * without the overhead of page navigation — response body returned via CDP.
 *
 * Used as FALLBACK when Node.js HTTP fails (TLS mismatch, etc.).
 */
async function fetchSourceViaChrome(tab, url, maxChars = 8000) {
	const start = Date.now();

	try {
		// Get the frameId of the tab for Network.loadNetworkResource
		const frames = await cdp(["evalraw", tab, "Page.getFrameTree", "{}"])
			.then((r) => JSON.parse(r))
			.catch(() => null);
		const frameId = frames?.frameTree?.frame?.id || undefined;

		// Load resource using Chrome's network stack (authentic TLS fingerprint)
		const raw = await cdp(
			[
				"evalraw",
				tab,
				"Network.loadNetworkResource",
				JSON.stringify({
					frameId,
					url,
					options: { disableCache: true, includeCredentials: false },
				}),
			],
			20000,
		);

		const result = JSON.parse(raw);
		const resource = result.resource;
		if (!resource?.success || !resource.httpStatusCode) {
			return {
				url,
				error:
					resource?.netErrorName ||
					resource?.netError ||
					"loadNetworkResource failed",
				source: "chrome",
				duration: Date.now() - start,
				needsFallback: true,
			};
		}

		// Read response body from stream
		let body = "";
		if (resource.stream) {
			try {
				const ioRaw = await cdp(
					[
						"evalraw",
						tab,
						"IO.read",
						JSON.stringify({ handle: resource.stream }),
					],
					10000,
				);
				const ioResult = JSON.parse(ioRaw);
				body = ioResult.data || "";
				// Close stream
				await cdp([
					"evalraw",
					tab,
					"IO.close",
					JSON.stringify({ handle: resource.stream }),
				]).catch(() => {});
			} catch {}
		}

		if (!body || body.length < 100) {
			return {
				url,
				error: "Empty response body from Network.loadNetworkResource",
				source: "chrome",
				duration: Date.now() - start,
				needsFallback: true,
			};
		}

		// Bot-detection and content extraction
		const botCheck = detectBotBlock(resource.httpStatusCode, body, url, url);
		if (botCheck.blocked) {
			return {
				url,
				status: resource.httpStatusCode,
				error: `Blocked: ${botCheck.reason}`,
				source: "chrome",
				duration: Date.now() - start,
				needsBrowser: true,
			};
		}

		const extracted = await extractContent(body, url);
		const quality = checkContentQuality(extracted);
		if (!quality.ok) {
			return {
				url,
				status: resource.httpStatusCode,
				error: `Low quality: ${quality.reason}`,
				source: "chrome",
				duration: Date.now() - start,
				needsBrowser: true,
			};
		}

		const content = trimContentHeadTail(extracted.markdown, maxChars);
		return {
			url,
			finalUrl: url,
			status: resource.httpStatusCode,
			contentType: "text/markdown",
			lastModified: "",
			publishedTime: extracted.publishedTime || "",
			byline: extracted.byline || "",
			siteName: extracted.siteName || "",
			lang: extracted.lang || "",
			title: extracted.title || url,
			snippet: extracted.excerpt,
			content,
			contentChars: content.length,
			source: "chrome",
			duration: Date.now() - start,
		};
	} catch (error) {
		return {
			url,
			error: error.message,
			source: "chrome",
			duration: Date.now() - start,
			needsFallback: true,
		};
	}
}

function isLikelyPdfUrl(url) {
	try {
		const parsed = new URL(url);
		return parsed.pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

async function fetchPdfSourceHttp(url, maxChars = 8000) {
	const privateCheck = isPrivateUrl(url);
	if (privateCheck.blocked) {
		return {
			url,
			finalUrl: url,
			status: 403,
			error: `Blocked: ${privateCheck.reason}`,
			source: "pdf-http",
		};
	}

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), 20000);
	const start = Date.now();
	try {
		const response = await fetch(url, {
			method: "GET",
			redirect: "follow",
			signal: controller.signal,
			headers: defaultFetchHeaders({
				accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
			}),
		});
		clearTimeout(timeoutId);

		const contentType = response.headers.get("content-type") || "";
		const finalUrl = response.url || url;
		const contentLength = Number.parseInt(
			response.headers.get("content-length") || "0",
			10,
		);
		if (response.status >= 400) {
			return {
				url,
				finalUrl,
				status: response.status,
				error: `HTTP ${response.status}`,
				source: "pdf-http",
				duration: Date.now() - start,
			};
		}
		if (
			!contentType.toLowerCase().includes("application/pdf") &&
			!isLikelyPdfUrl(finalUrl)
		) {
			return null;
		}
		if (contentLength > 30 * 1024 * 1024) {
			return {
				url,
				finalUrl,
				status: response.status,
				error: `PDF too large: ${contentLength} bytes`,
				source: "pdf-http",
				duration: Date.now() - start,
			};
		}

		const buffer = Buffer.from(await response.arrayBuffer());
		const pdf = await extractPdfMarkdown(buffer, finalUrl);
		if (!pdf || pdf.error) {
			return {
				url,
				finalUrl,
				status: response.status,
				error: pdf?.error || "PDF text extraction failed",
				source: "pdf-http",
				duration: Date.now() - start,
			};
		}
		const content = trimContentHeadTail(pdf.content, maxChars);
		return {
			url,
			finalUrl,
			status: response.status,
			contentType: "application/pdf",
			lastModified: response.headers.get("last-modified") || "",
			title: pdf.title,
			snippet: trimText(content, 320),
			content,
			contentChars: content.length,
			pages: pdf.pages,
			source: "pdf-http",
			duration: Date.now() - start,
		};
	} catch (error) {
		clearTimeout(timeoutId);
		return {
			url,
			finalUrl: url,
			error: error.message || String(error),
			source: "pdf-http",
			duration: Date.now() - start,
		};
	}
}

export async function fetchSourceContent(url, maxChars = 8000) {
	const start = Date.now();

	if (isLikelyPdfUrl(url)) {
		const pdfResult = await fetchPdfSourceHttp(url, maxChars);
		if (pdfResult?.content || pdfResult?.status === 403) return pdfResult;
	}

	// Check if it's a GitHub URL
	if (parseGitHubUrl(url)) {
		const parsed = parseGitHubUrl(url);
		if (
			parsed &&
			(parsed.type === "root" ||
				parsed.type === "tree" ||
				(parsed.type === "blob" && !parsed.path?.includes(".")))
		) {
			const ghResult = await fetchGitHubContent(url);
			if (ghResult.ok) {
				const content = trimContentHeadTail(ghResult.content, maxChars);
				return {
					url,
					finalUrl: url,
					status: 200,
					contentType: "text/markdown",
					lastModified: "",
					title: ghResult.title,
					snippet: content.slice(0, 320),
					content,
					contentChars: content.length,
					source: "github-api",
					...(ghResult.tree && { tree: ghResult.tree }),
					duration: Date.now() - start,
				};
			}
			process.stderr.write(
				`[greedysearch] GitHub API fetch failed, trying HTTP: ${ghResult.error}\n`,
			);
		}
	}

	// Check if it's a Reddit URL (posts and comments)
	const redditInfo = parseRedditUrl(url);
	if (redditInfo?.type === "post") {
		process.stderr.write(
			`[greedysearch] Using Reddit JSON API for: ${url.slice(0, 60)}...\n`,
		);
		const redditResult = await fetchRedditContent(url, maxChars);
		if (redditResult.ok) {
			const content = trimContentHeadTail(redditResult.markdown, maxChars);
			return {
				url,
				finalUrl: redditResult.finalUrl,
				status: redditResult.status,
				contentType: "text/markdown",
				lastModified: redditResult.lastModified || "",
				publishedTime: redditResult.publishedTime || "",
				byline: redditResult.byline || "",
				siteName: redditResult.siteName || "",
				lang: redditResult.lang || "",
				title: redditResult.title,
				snippet: redditResult.excerpt,
				content,
				contentChars: content.length,
				source: "reddit-api",
				duration: Date.now() - start,
			};
		}
		process.stderr.write(
			`[greedysearch] Reddit API fetch failed, falling back to HTTP: ${redditResult.error}\n`,
		);
	}

	// Try HTTP (Node.js fetch) first — fast, works for most sites.
	const httpResult = await fetchSourceHttp(url, { timeoutMs: 10000 });

	if (httpResult.ok) {
		const content = trimContentHeadTail(httpResult.markdown, maxChars);
		return {
			url,
			finalUrl: httpResult.finalUrl,
			status: httpResult.status,
			contentType: "text/markdown",
			lastModified: httpResult.lastModified || "",
			publishedTime: httpResult.publishedTime || "",
			byline: httpResult.byline || "",
			siteName: httpResult.siteName || "",
			lang: httpResult.lang || "",
			title: httpResult.title,
			snippet: httpResult.excerpt,
			content,
			contentChars: content.length,
			source: "http",
			duration: Date.now() - start,
		};
	}

	// HTTP failed — try Chrome Network.loadNetworkResource (authentic TLS).
	// Only attempted if the HTTP error is retryable (network/TLS issues).
	if (httpResult.needsBrowser) {
		try {
			const chromeTab = await openNewTab();
			try {
				const chromeResult = await fetchSourceViaChrome(
					chromeTab,
					url,
					maxChars,
				);
				if (chromeResult.content && chromeResult.content.length > 100) {
					return chromeResult;
				}
			} finally {
				await closeTab(chromeTab);
			}
		} catch {
			// Chrome unavailable — fall through to browser
		}
	}

	// Last resort — full browser navigation (handles JS-heavy pages)
	process.stderr.write(
		`[greedysearch] HTTP failed for ${url.slice(0, 60)}, trying browser...\n`,
	);
	return await fetchSourceContentBrowser(url, maxChars);
}

async function waitForPageReady(tab, timeoutMs = 4000, intervalMs = 200) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const ready = await cdp([
				"eval",
				tab,
				`document.readyState === "complete" && !!document.body && document.body.innerText.length > 500`,
			]);
			if (ready.trim() === "true") return;
		} catch {}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

async function fetchSourceContentBrowser(url, maxChars = 8000) {
	const start = Date.now();
	let tab;

	try {
		tab = await openNewTab();
	} catch (e) {
		return {
			url,
			title: "",
			content: null,
			snippet: "",
			contentChars: 0,
			error: `openNewTab failed: ${e.message}`,
			source: "browser",
			duration: Date.now() - start,
		};
	}

	try {
		await cdp(["nav", tab, url], 30000);
		await waitForPageReady(tab);

		const content = await cdp([
			"eval",
			tab,
			String.raw`
			(function(){
				var el = document.querySelector('article, [role="main"], main, .post-content, .article-body, #content, .content');
				var text = (el || document.body).innerText;
				return JSON.stringify({
					title: document.title,
					content: text.replace(/\s+/g, ' ').trim(),
					url: location.href
				});
			})()
		`,
		]);

		const parsed = JSON.parse(content);
		const finalContent = trimContentHeadTail(parsed.content, maxChars);

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

export async function fetchMultipleSources(
	sources,
	maxSources = 5,
	maxChars = 8000,
	concurrency = SOURCE_FETCH_CONCURRENCY,
) {
	const toFetch = sources.slice(0, maxSources);
	if (toFetch.length === 0) return [];

	const workerCount = Math.min(
		toFetch.length,
		Math.max(
			1,
			Number.parseInt(String(concurrency), 10) || SOURCE_FETCH_CONCURRENCY,
		),
	);

	process.stderr.write(
		`[greedysearch] Fetching content from ${toFetch.length} sources via HTTP (concurrency ${workerCount})...\n`,
	);

	const fetched = new Array(toFetch.length);
	let nextIndex = 0;
	let completed = 0;

	async function worker() {
		while (true) {
			const index = nextIndex++;
			if (index >= toFetch.length) return;

			const s = toFetch[index];
			const url = s.canonicalUrl || s.url;
			process.stderr.write(
				`[greedysearch] [${index + 1}/${toFetch.length}] Fetching: ${url.slice(0, 60)}...\n`,
			);

			const result = await fetchSourceContent(url, maxChars).catch((e) => ({
				url,
				title: "",
				content: null,
				snippet: "",
				contentChars: 0,
				error: e.message,
				source: "error",
				duration: 0,
			}));
			fetched[index] = {
				id: s.id,
				...result,
			};

			if (result.content && result.content.length > 100) {
				process.stderr.write(
					`[greedysearch] ✓ ${result.source}: ${result.content.length} chars\n`,
				);
			} else if (result.error) {
				process.stderr.write(`[greedysearch] ✗ ${result.error.slice(0, 80)}\n`);
			}

			completed += 1;
			process.stderr.write(`PROGRESS:fetch:${completed}/${toFetch.length}\n`);
		}
	}

	await Promise.all(Array.from({ length: workerCount }, () => worker()));

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

export async function fetchTopSource(url) {
	const tab = await openNewTab();
	try {
		await cdp(["nav", tab, url], 30000);
		await waitForPageReady(tab);
		const content = await cdp([
			"eval",
			tab,
			String.raw`
      (function(){
        var el = document.querySelector('article, [role="main"], main, .post-content, .article-body, #content, .content');
        var text = (el || document.body).innerText;
        return text.replace(/\s+/g, ' ').trim();
      })()
    `,
		]);
		return { url, content };
	} catch (e) {
		return { url, content: null, error: e.message };
	} finally {
		await closeTab(tab);
	}
}

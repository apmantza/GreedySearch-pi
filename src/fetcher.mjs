// src/fetcher.mjs — HTTP source fetching with Readability extraction

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const turndown = new TurndownService({
	headingStyle: "atx",
	bulletListMarker: "-",
	codeBlockStyle: "fenced",
});

// Strip data URLs from markdown
turndown.addRule("removeDataUrls", {
	filter: (node) =>
		node.tagName === "IMG" && node.getAttribute("src")?.startsWith("data:"),
	replacement: () => "",
});

const DEFAULT_USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const DEFAULT_HEADERS = {
	"user-agent": DEFAULT_USER_AGENT,
	accept:
		"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
	"accept-language": "en-US,en;q=0.9",
	"accept-encoding": "gzip, deflate, br",
	"cache-control": "no-cache",
	pragma: "no-cache",
	"sec-fetch-dest": "document",
	"sec-fetch-mode": "navigate",
	"sec-fetch-site": "none",
	"sec-fetch-user": "?1",
	"upgrade-insecure-requests": "1",
};

/**
 * Fetch a URL via HTTP and extract readable content
 * @param {string} url - URL to fetch
 * @param {object} options - Options
 * @param {number} [options.timeoutMs=15000] - Request timeout
 * @param {string} [options.userAgent] - Custom user agent
 * @param {AbortSignal} [options.signal] - Abort signal
 * @returns {Promise<FetchResult>}
 */
export async function fetchSourceHttp(url, options = {}) {
	const { timeoutMs = 15000, userAgent, signal } = options;

	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

	// Link external signal if provided
	if (signal) {
		signal.addEventListener("abort", () => controller.abort(), { once: true });
	}

	try {
		const response = await fetch(url, {
			method: "GET",
			headers: {
				...DEFAULT_HEADERS,
				"user-agent": userAgent || DEFAULT_USER_AGENT,
			},
			redirect: "follow",
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		const contentType = response.headers.get("content-type") || "";
		const finalUrl = response.url;

		// Check for non-HTML content
		if (
			!contentType.includes("text/html") &&
			!contentType.includes("application/xhtml")
		) {
			return {
				ok: false,
				url,
				finalUrl,
				status: response.status,
				error: `Unsupported content type: ${contentType}`,
				needsBrowser: false,
			};
		}

		const html = await response.text();

		// Quick bot detection check
		const quickCheck = detectBotBlock(response.status, html);
		if (quickCheck.blocked) {
			return {
				ok: false,
				url,
				finalUrl,
				status: response.status,
				error: `Blocked: ${quickCheck.reason}`,
				needsBrowser: true,
			};
		}

		// Extract content with Readability
		const extracted = extractContent(html, finalUrl);

		return {
			ok: true,
			url,
			finalUrl,
			status: response.status,
			title: extracted.title,
			markdown: extracted.markdown,
			excerpt: extracted.excerpt,
			contentLength: extracted.markdown.length,
			needsBrowser: false,
		};
	} catch (error) {
		clearTimeout(timeoutId);

		// Check for network errors that might work with browser
		const needsBrowser = isNetworkErrorRetryableWithBrowser(error);

		return {
			ok: false,
			url,
			finalUrl: url,
			status: 0,
			error: error.message,
			needsBrowser,
		};
	}
}

/**
 * Detect if HTTP response indicates bot blocking
 */
function detectBotBlock(status, html) {
	const lower = html.toLowerCase();
	const title =
		html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.toLowerCase() || "";

	// Status-based blocks
	if (status === 403 || status === 429) {
		return { blocked: true, reason: `HTTP ${status}` };
	}

	// Content-based blocks
	const blockSignals = [
		{
			pattern: /captcha|i'm not a robot|verify you are human/i,
			reason: "captcha",
		},
		{ pattern: /access denied|accessDenied|blocked/i, reason: "access denied" },
		{
			pattern: /just a moment.{0,50}checking your browser/i,
			reason: "cloudflare challenge",
		},
		{
			pattern: /enable javascript|javascript is required/i,
			reason: "requires javascript",
		},
		{
			pattern: /unusual traffic|unusual activity/i,
			reason: "unusual traffic detection",
		},
		{ pattern: /bot detected|automated request/i, reason: "bot detection" },
	];

	const combined = `${title} ${lower.slice(0, 10000)}`;
	for (const signal of blockSignals) {
		if (signal.pattern.test(combined)) {
			return { blocked: true, reason: signal.reason };
		}
	}

	return { blocked: false };
}

/**
 * Check if a network error might succeed with browser fallback
 */
function isNetworkErrorRetryableWithBrowser(error) {
	const message = error.message.toLowerCase();
	return (
		message.includes("fetch failed") ||
		message.includes("unable to verify") || // TLS issues
		message.includes("certificate") ||
		message.includes("timeout")
	);
}

/**
 * Extract readable content using Mozilla Readability + Turndown
 */
function extractContent(html, url) {
	const dom = new JSDOM(html, { url });
	const document = dom.window.document;

	// Try Readability first
	const reader = new Readability(document);
	const article = reader.parse();

	if (article && article.content) {
		const markdown = turndown.turndown(article.content);
		const cleanMarkdown = markdown.replace(/\n{3,}/g, "\n\n").trim();

		return {
			title: article.title || document.title || url,
			markdown: cleanMarkdown,
			excerpt: cleanMarkdown.slice(0, 300).replace(/\n/g, " "),
		};
	}

	// Fallback: extract body text
	const body = document.body;
	if (body) {
		// Remove script/style/nav/footer
		const clone = body.cloneNode(true);
		clone
			.querySelectorAll("script, style, nav, footer, header, aside")
			.forEach((el) => el.remove());
		const text = clone.textContent || "";
		const cleanText = text.replace(/\s+/g, " ").trim();

		return {
			title: document.title || url,
			markdown: cleanText,
			excerpt: cleanText.slice(0, 300),
		};
	}

	// Last resort
	return {
		title: url,
		markdown: "",
		excerpt: "",
	};
}

/**
 * Predict if a URL will likely need browser fallback (before attempting HTTP)
 * @param {string} url - URL to check
 * @returns {boolean}
 */
export function shouldUseBrowser(url) {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();
		const pathname = parsed.pathname.toLowerCase();

		// Known JS-heavy sites
		const jsHeavyDomains = [
			"react.dev",
			"nextjs.org",
			"vuejs.org",
			"angular.io",
			"svelte.dev",
			"docs.expo.dev",
			"tailwindcss.com",
			"storybook.js.org",
		];

		if (
			jsHeavyDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`))
		) {
			return true;
		}

		// Single-page app indicators in URL
		if (
			pathname.includes("/playground") ||
			pathname.includes("/demo") ||
			pathname.includes("/app")
		) {
			return true;
		}

		// Hash-based routing often indicates SPA
		if (parsed.hash && parsed.hash.length > 1) {
			return true;
		}

		return false;
	} catch {
		return false;
	}
}

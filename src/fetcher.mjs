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

/** Blocked private/internal URL patterns */
const PRIVATE_URL_PATTERNS = [
	/^localhost$/i,
	/^127\.\d+\.\d+\.\d+$/,
	/^0\.0\.0\.0$/,
	/^\[::1\]$/,
	/^10\./, // RFC1918 - Class A
	/^172\.(1[6-9]|2\d|3[01])\./, // RFC1918 - Class B
	/^192\.168\./, // RFC1918 - Class C
	/^169\.254\./, // Link-local
	/^fc00:/i, // IPv6 unique local
	/^fe80:/i, // IPv6 link-local
	/\.local$/i,
	/\.internal$/i,
	/\.localhost$/i,
];

/**
 * Check if URL is a private/internal address that should not be fetched
 * @param {string} url - URL to check
 * @returns {{blocked: boolean, reason?: string}}
 */
export function isPrivateUrl(url) {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		for (const pattern of PRIVATE_URL_PATTERNS) {
			if (pattern.test(hostname)) {
				return {
					blocked: true,
					reason: `Private/internal address: ${hostname}`,
				};
			}
		}

		// Block file:// protocol
		if (parsed.protocol === "file:") {
			return { blocked: true, reason: "File protocol not allowed" };
		}

		return { blocked: false };
	} catch (error) {
		return { blocked: true, reason: `Invalid URL: ${error.message}` };
	}
}

/**
 * Rewrite GitHub blob URLs to raw.githubusercontent.com
 * github.com/owner/repo/blob/ref/path → raw.githubusercontent.com/owner/repo/ref/path
 * @param {string} url - URL to rewrite
 * @returns {string} - Rewritten URL or original if not applicable
 */
export function rewriteGitHubUrl(url) {
	try {
		const parsed = new URL(url);

		// Only process github.com
		if (
			!(
				parsed.hostname === "github.com" ||
				parsed.hostname.endsWith(".github.com")
			)
		) {
			return url;
		}

		// Parse path: /owner/repo/blob/ref/path/to/file
		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 5) {
			return url; // Not a blob URL (need owner, repo, 'blob', ref, path...)
		}

		const [owner, repo, type, ref, ...fileParts] = parts;

		// Must be /blob/ path
		if (type !== "blob") {
			return url;
		}

		// Build raw URL
		const rawPath = fileParts.join("/");
		const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${rawPath}`;

		return rawUrl;
	} catch {
		// If parsing fails, return original
		return url;
	}
}

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
	// Security: Block private/internal URLs
	const privateCheck = isPrivateUrl(url);
	if (privateCheck.blocked) {
		return {
			ok: false,
			url,
			finalUrl: url,
			status: 403,
			error: `Blocked: ${privateCheck.reason}`,
			needsBrowser: false,
		};
	}

	// Rewrite GitHub blob URLs to raw.githubusercontent.com
	const originalUrl = url;
	url = rewriteGitHubUrl(url);
	if (url !== originalUrl) {
		console.error(
			`[fetcher] Rewrote GitHub URL: ${originalUrl.slice(0, 60)}... → raw.githubusercontent.com`,
		);
	}

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
		const lastModified = response.headers.get("last-modified") || "";

		// Handle raw text/plain from GitHub (raw file content)
		let isRawGitHub = false;
		try {
			const finalHost = new URL(finalUrl).hostname.toLowerCase();
			isRawGitHub = finalHost === "raw.githubusercontent.com";
		} catch {}
		if (contentType.includes("text/plain") && isRawGitHub) {
			const text = await response.text();
			return {
				ok: true,
				url: originalUrl,
				finalUrl,
				status: response.status,
				title: finalUrl.split("/").pop() || "GitHub File",
				byline: "",
				siteName: "GitHub",
				lang: "",
				publishedTime: lastModified,
				lastModified,
				markdown: text,
				contentLength: text.length,
				excerpt: text.slice(0, 300).replace(/\n/g, " "),
				needsBrowser: false,
			};
		}

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

		// Quick bot detection check (pass both original and final URL for redirect detection)
		const quickCheck = detectBotBlock(response.status, html, finalUrl, url);
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

		// Quality check: if content looks suspicious or too short, recommend browser
		const quality = checkContentQuality(extracted);
		if (!quality.ok) {
			return {
				ok: false,
				url,
				finalUrl,
				status: response.status,
				error: `Low quality content: ${quality.reason}`,
				needsBrowser: true,
			};
		}

		return {
			ok: true,
			url,
			finalUrl,
			status: response.status,
			title: extracted.title,
			byline: extracted.byline,
			siteName: extracted.siteName,
			lang: extracted.lang,
			publishedTime: extracted.publishedTime || lastModified,
			lastModified,
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
 * Checks first 30KB of HTML for performance
 */
function detectBotBlock(status, html, finalUrl, originalUrl) {
	const title =
		html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.toLowerCase() || "";
	const sample = html.slice(0, 30000).toLowerCase();
	const combined = `${title} ${sample}`;

	// Status-based blocks
	if (status === 403 || status === 429 || status === 503) {
		return { blocked: true, reason: `HTTP ${status}` };
	}

	// Content-based blocks - more specific patterns to avoid false positives
	const blockSignals = [
		// Captcha: must be in context of challenge (not just mentioned on page)
		{
			pattern: /class=["'][^"']*captcha["']|<div[^>]*id=["']captcha/i,
			reason: "captcha",
		},
		{
			pattern: /g-recaptcha|data-sitekey|i['"]m not a robot/i,
			reason: "captcha",
		},

		// Cloudflare challenge pages
		{
			pattern:
				/checking your browser.{0,100}please wait|cf-browser-verification/i,
			reason: "cloudflare challenge",
		},
		{
			pattern:
				/just a moment.{0,50}security check|ddos protection by cloudflare/i,
			reason: "cloudflare challenge",
		},

		// Bot detection
		{
			pattern: /unusual traffic.{0,50}from your computer network/i,
			reason: "unusual traffic",
		},
		{
			pattern: /bot detected|automated.{0,20}request/i,
			reason: "bot detection",
		},

		// JavaScript requirements (specific patterns)
		{
			pattern:
				/enable\s+javascript\s+to\s+view|javascript\s+is\s+required.{0,50}enabled/i,
			reason: "requires javascript",
		},

		// Access denied
		{ pattern: /access denied|accessdenied/i, reason: "access denied" },

		// Anubis (new proof-of-work anti-bot system)
		{
			pattern: /protected by anubis|anubis uses a proof-of-work/i,
			reason: "anubis challenge",
		},
	];

	for (const signal of blockSignals) {
		if (signal.pattern.test(combined)) {
			return { blocked: true, reason: signal.reason };
		}
	}

	// Check for login redirect (different hostname, auth patterns)
	const loginRedirect = detectLoginRedirect(originalUrl, finalUrl, html);
	if (loginRedirect) {
		return { blocked: true, reason: loginRedirect };
	}

	return { blocked: false };
}

/** Known authentication/login domains. */
const AUTH_DOMAINS = [
	"accounts.google.com",
	"login.microsoftonline.com",
	"login.live.com",
	"auth0.com",
	"okta.com",
	"auth.mozilla.auth0.com",
	"id.atlassian.com",
];

/** Hostname prefixes that indicate an auth/login service. */
const AUTH_HOSTNAME_PREFIXES = [
	"login.",
	"signin.",
	"auth.",
	"sso.",
	"accounts.",
	"idp.",
];

/** Content patterns that indicate a login wall when combined with a hostname redirect. */
const LOGIN_CONTENT_PATTERNS = [
	"sign in to continue",
	"log in to continue",
	"authentication required",
	"create an account to continue",
	"subscribe to continue reading",
	"members only",
];

/**
 * Detects redirect-to-login pages: sites that return 200 but redirect to an
 * auth domain or serve a login form instead of the requested content.
 */
function detectLoginRedirect(requestedUrl, finalUrl, html) {
	try {
		const requested = new URL(requestedUrl);
		const final = new URL(finalUrl);

		// Same hostname = not a redirect to login
		if (requested.hostname.toLowerCase() === final.hostname.toLowerCase()) {
			return undefined;
		}

		const finalHost = final.hostname.toLowerCase();

		// Check for known auth domains
		if (
			AUTH_DOMAINS.some((d) => finalHost === d || finalHost.endsWith(`.${d}`))
		) {
			return `redirected to login (${final.hostname})`;
		}

		// Check for auth-related hostname prefixes
		if (AUTH_HOSTNAME_PREFIXES.some((p) => finalHost.startsWith(p))) {
			return `redirected to login (${final.hostname})`;
		}

		// Check for login content patterns (only when redirected)
		const sample = html.slice(0, 20000).toLowerCase();
		if (LOGIN_CONTENT_PATTERNS.some((p) => sample.includes(p))) {
			return `redirected to login page (${final.hostname})`;
		}
	} catch {
		// URL parsing failures are not login redirects
	}

	return undefined;
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
 * Extract a date string from <meta> tags (Open Graph, schema.org, standard)
 * Returns ISO string or empty string.
 */
function extractMetaDate(document) {
	const selectors = [
		'meta[property="article:published_time"]',
		'meta[name="article:published_time"]',
		'meta[property="og:published_time"]',
		'meta[name="publication_date"]',
		'meta[name="date"]',
		'meta[itemprop="datePublished"]',
		'time[itemprop="datePublished"]',
		'meta[name="DC.date"]',
	];
	for (const sel of selectors) {
		const el = document.querySelector(sel);
		const val =
			el?.getAttribute("content") || el?.getAttribute("datetime") || "";
		if (val) return val;
	}
	return "";
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

		const publishedTime =
			article.publishedTime || extractMetaDate(document) || "";

		return {
			title: article.title || document.title || url,
			byline: article.byline || "",
			siteName: article.siteName || "",
			lang: article.lang || "",
			publishedTime,
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
			byline: "",
			siteName: "",
			lang: "",
			publishedTime: extractMetaDate(document),
			markdown: cleanText,
			excerpt: cleanText.slice(0, 300),
		};
	}

	// Last resort
	return {
		title: url,
		byline: "",
		siteName: "",
		lang: "",
		publishedTime: "",
		markdown: "",
		excerpt: "",
	};
}

/**
 * Check if extracted content quality is sufficient
 * Returns { ok: true } or { ok: false, reason: string }
 */
function checkContentQuality(extracted) {
	const markdown = extracted.markdown.trim().toLowerCase();
	const title = (extracted.title || "").toLowerCase();

	// Minimum content length check
	if (extracted.markdown.trim().length < 100) {
		return { ok: false, reason: "content too short (< 100 chars)" };
	}

	// Suspicious content patterns that indicate bot block or incomplete extraction
	const suspiciousPatterns = [
		{ pattern: /\bloading\b.{0,50}\bplease wait\b/i, desc: "loading page" },
		{
			pattern: /please\s+ensure\s+javascript\s+is\s+enabled/i,
			desc: "requires javascript",
		},
		{
			pattern: /enable\s+javascript\s+to\s+view/i,
			desc: "requires javascript",
		},
		{
			pattern: /just\s+a\s+moment\b/i,
			desc: "cloudflare challenge detected in content",
		},
		{ pattern: /verify\s+you\s+are\s+human/i, desc: "human verification" },
		{ pattern: /captcha\s+required/i, desc: "captcha in extracted content" },
		{ pattern: /access\s+denied/i, desc: "access denied in content" },
		{
			pattern: /^\s*sign\s+in\s*$|^\s*log\s+in\s*$/im,
			desc: "login form only",
		},
	];

	for (const { pattern, desc } of suspiciousPatterns) {
		if (pattern.test(markdown)) {
			return { ok: false, reason: desc };
		}
	}

	// Title-based checks
	if (
		title.includes("just a moment") ||
		title.includes("checking your browser")
	) {
		return { ok: false, reason: "cloudflare challenge page detected in title" };
	}

	return { ok: true };
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

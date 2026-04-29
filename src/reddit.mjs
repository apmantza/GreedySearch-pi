// src/reddit.mjs - Reddit content fetching via public JSON API
// Reddit exposes structured data by appending .json to any URL

const REDDIT_HEADERS = {
	"user-agent": "GreedySearch/1.0 (Research Bot)",
	accept: "application/json",
};

/**
 * Parse a Reddit URL to check if it's a post, comment, or user profile
 * @param {string} url
 * @returns {{type: 'post'|'user'|'other', cleanUrl: string} | null}
 */
export function parseRedditUrl(url) {
	try {
		const parsed = new URL(url);
		const hostname = parsed.hostname.toLowerCase();

		// Support reddit.com, old.reddit.com, www.reddit.com
		if (!(hostname === "reddit.com" || hostname.endsWith(".reddit.com"))) {
			return null;
		}

		const pathname = parsed.pathname;

		// User profile: /u/username or /user/username
		if (pathname.match(/^\/(u|user)\/[^/]+\/?$/i)) {
			return { type: "user", cleanUrl: normalizeRedditUrl(url) };
		}

		// Post: /r/subreddit/comments/xxxx/...
		if (pathname.match(/^\/r\/[^/]+\/comments\/[^/]+/i)) {
			return { type: "post", cleanUrl: normalizeRedditUrl(url) };
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Normalize Reddit URL (remove query params, fragments)
 * @param {string} url
 * @returns {string}
 */
function normalizeRedditUrl(url) {
	try {
		const parsed = new URL(url);
		// Reconstruct without query/fragment
		return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
	} catch {
		return url;
	}
}

/**
 * Fetch Reddit content via the .json API
 * @param {string} url - Reddit URL (will have .json appended)
 * @param {number} maxChars - Max characters for content
 * @returns {Promise<FetchResult>}
 */
export async function fetchRedditContent(url, maxChars = 8000) {
	const start = Date.now();

	try {
		// Append .json to get API response
		const jsonUrl = url.replace(/\/?$/, ".json");

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 15000);

		const response = await fetch(jsonUrl, {
			headers: REDDIT_HEADERS,
			signal: controller.signal,
		});

		clearTimeout(timeoutId);

		if (!response.ok) {
			throw new Error(`Reddit API ${response.status}`);
		}

		const data = await response.json();

		// data[0] = post listing, data[1] = comments listing
		if (!Array.isArray(data) || data.length < 1) {
			throw new Error("Invalid Reddit API response structure");
		}

		const postListing = data[0];
		const commentsListing = data[1];

		// Extract post data
		const post = postListing?.data?.children?.[0]?.data;
		if (!post) {
			throw new Error("No post data in Reddit response");
		}

		// Format as markdown
		const markdown = formatRedditPost(post, commentsListing, maxChars);

		return {
			ok: true,
			url,
			finalUrl: url,
			status: 200,
			contentType: "text/markdown",
			lastModified: "",
			title: post.title || "Reddit Post",
			byline: `u/${post.author}`,
			siteName: `r/${post.subreddit}`,
			lang: "en",
			publishedTime: new Date(post.created_utc * 1000).toISOString(),
			excerpt: post.selftext?.slice(0, 300).replace(/\n/g, " ") || "",
			markdown,
			contentLength: markdown.length,
			needsBrowser: false,
			duration: Date.now() - start,
		};
	} catch (error) {
		return {
			ok: false,
			url,
			finalUrl: url,
			status: 0,
			error: `Reddit fetch failed: ${error.message}`,
			needsBrowser: false,
			duration: Date.now() - start,
		};
	}
}

/**
 * Format Reddit post and comments as clean markdown
 * @param {object} post - Reddit post data
 * @param {object|null} commentsListing - Comments listing data
 * @param {number} maxChars - Max characters
 * @returns {string}
 */
function formatRedditPost(post, commentsListing, maxChars) {
	let md = "";

	// Post header
	md += `# ${post.title}\n\n`;
	md += `**Subreddit:** r/${post.subreddit} | **Author:** u/${post.author} | **Score:** ${post.score}\n\n`;

	// Post body (selftext) or link
	if (post.selftext) {
		md += post.selftext;
		md += "\n\n";
	} else if (post.url) {
		try {
			const postUrlHost = new URL(post.url).hostname.toLowerCase();
			if (
				postUrlHost !== "reddit.com" &&
				!postUrlHost.endsWith(".reddit.com")
			) {
				// External link post
				md += `**Link:** ${post.url}\n\n`;
			}
		} catch {
			// If URL parsing fails, treat as external link
			md += `**Link:** ${post.url}\n\n`;
		}
	}

	// Comments section
	if (commentsListing?.data?.children?.length > 0) {
		md += "---\n\n## Comments\n\n";
		const comments = commentsListing.data.children
			.filter((c) => c.kind === "t1") // t1 = comment
			.slice(0, 10); // Top 10 comments

		for (const comment of comments) {
			md += formatComment(comment.data, 0);
			md += "\n";
		}
	}

	// Trim to maxChars while keeping structure
	if (md.length > maxChars) {
		md = md.slice(0, maxChars).trim() + "\n\n... (truncated)";
	}

	return md;
}

/**
 * Format a single comment with nesting
 * @param {object} comment - Reddit comment data
 * @param {number} depth - Nesting depth
 * @returns {string}
 */
function formatComment(comment, depth) {
	if (
		!comment ||
		comment.body === "[deleted]" ||
		comment.body === "[removed]"
	) {
		return "";
	}

	const indent = "> ".repeat(depth);
	let md = "";

	md += `${indent}**u/${comment.author}** (${comment.score} pts)\n`;
	md += `${indent}${comment.body.replace(/\n/g, "\n" + indent)}\n`;

	// Handle nested replies (limit depth to 3)
	if (depth < 3 && comment.replies?.data?.children) {
		const replies = comment.replies.data.children.filter(
			(r) => r.kind === "t1",
		);
		for (const reply of replies.slice(0, 5)) {
			md += "\n" + formatComment(reply.data, depth + 1);
		}
	}

	return md;
}

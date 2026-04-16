// src/search/sources.mjs — Source registry, URL normalization, domain inference, classification
//
// Responsible for: deduplicating sources across engines, normalizing URLs,
// classifying source types, inferring preferred domains from queries, and
// merging fetch data into source objects.

export const TRACKING_PARAMS = [
	"fbclid",
	"gclid",
	"ref",
	"ref_src",
	"ref_url",
	"source",
	"utm_campaign",
	"utm_content",
	"utm_medium",
	"utm_source",
	"utm_term",
];

export const COMMUNITY_HOSTS = [
	"dev.to",
	"hashnode.com",
	"medium.com",
	"reddit.com",
	"stackoverflow.com",
	"stackexchange.com",
	"substack.com",
];

export const NEWS_HOSTS = [
	"arstechnica.com",
	"techcrunch.com",
	"theverge.com",
	"venturebeat.com",
	"wired.com",
	"zdnet.com",
];

export function trimText(text = "", maxChars = 240) {
	const clean = String(text).replace(/\s+/g, " ").trim();
	if (clean.length <= maxChars) return clean;
	return `${clean.slice(0, maxChars).replace(/\s+\S*$/, "")}...`;
}

export function normalizeSourceTitle(title = "") {
	const clean = trimText(title, 180);
	if (!clean) return "";
	if (/^https?:\/\//i.test(clean)) return "";

	const wordCount = clean.split(/\s+/).filter(Boolean).length;
	const hasUppercase = /[A-Z]/.test(clean);
	const hasDigit = /\d/.test(clean);
	const looksLikeFragment =
		clean === clean.toLowerCase() &&
		wordCount <= 4 &&
		!hasUppercase &&
		!hasDigit;
	return looksLikeFragment ? "" : clean;
}

export function pickPreferredTitle(currentTitle = "", nextTitle = "") {
	const current = normalizeSourceTitle(currentTitle);
	const next = normalizeSourceTitle(nextTitle);
	if (!next) return current;
	if (!current) return next;
	const currentLooksLikeUrl = /^https?:\/\//i.test(current);
	const nextLooksLikeUrl = /^https?:\/\//i.test(next);
	if (currentLooksLikeUrl && !nextLooksLikeUrl) return next;
	if (!currentLooksLikeUrl && nextLooksLikeUrl) return current;
	return next.length > current.length ? next : current;
}

export function normalizeUrl(rawUrl) {
	if (!rawUrl) return null;
	try {
		const url = new URL(rawUrl);
		if (!["http:", "https:"].includes(url.protocol)) return null;
		url.hash = "";
		url.hostname = url.hostname.toLowerCase();
		if (
			(url.protocol === "https:" && url.port === "443") ||
			(url.protocol === "http:" && url.port === "80")
		) {
			url.port = "";
		}
		for (const key of [...url.searchParams.keys()]) {
			const lower = key.toLowerCase();
			if (TRACKING_PARAMS.includes(lower) || lower.startsWith("utm_")) {
				url.searchParams.delete(key);
			}
		}
		url.searchParams.sort();
		const normalizedPath = url.pathname.replace(/\/+$/, "") || "/";
		url.pathname = normalizedPath;
		const normalized = url.toString();
		return normalizedPath === "/" ? normalized.replace(/\/$/, "") : normalized;
	} catch {
		return null;
	}
}

export function getDomain(rawUrl) {
	try {
		const domain = new URL(rawUrl).hostname.toLowerCase();
		return domain.replace(/^www\./, "");
	} catch {
		return "";
	}
}

export function matchesDomain(domain, hosts) {
	return hosts.some((host) => domain === host || domain.endsWith(`.${host}`));
}

export function classifySourceType(domain, title = "", rawUrl = "") {
	const lowerTitle = title.toLowerCase();
	const lowerUrl = rawUrl.toLowerCase();

	if (domain === "github.com" || domain === "gitlab.com") return "repo";
	if (matchesDomain(domain, COMMUNITY_HOSTS)) return "community";
	if (matchesDomain(domain, NEWS_HOSTS)) return "news";
	if (
		domain.startsWith("docs.") ||
		domain.startsWith("developer.") ||
		domain.startsWith("developers.") ||
		domain.startsWith("api.") ||
		lowerTitle.includes("documentation") ||
		lowerTitle.includes("docs") ||
		lowerTitle.includes("reference") ||
		lowerUrl.includes("/docs/") ||
		lowerUrl.includes("/reference/") ||
		lowerUrl.includes("/api/")
	) {
		return "official-docs";
	}
	if (domain.startsWith("blog.") || lowerUrl.includes("/blog/"))
		return "maintainer-blog";
	return "website";
}

export function sourceTypePriority(sourceType) {
	switch (sourceType) {
		case "official-docs":
			return 5;
		case "repo":
			return 4;
		case "maintainer-blog":
			return 3;
		case "website":
			return 2;
		case "community":
			return 1;
		case "news":
			return 0;
		default:
			return 0;
	}
}

export function bestRank(source) {
	const ranks = Object.values(source.perEngine || {}).map((v) => v?.rank || 99);
	return ranks.length ? Math.min(...ranks) : 99;
}

export function inferPreferredDomains(query) {
	const normalized = query.toLowerCase();
	const matches = [];

	if (
		normalized.includes("openai") ||
		normalized.includes("gpt") ||
		normalized.includes("chatgpt")
	) {
		matches.push("openai.com", "platform.openai.com", "help.openai.com");
	}
	if (normalized.includes("anthropic") || normalized.includes("claude")) {
		matches.push("anthropic.com", "docs.anthropic.com");
	}
	if (normalized.includes("bun")) {
		matches.push("bun.sh", "bun.com");
	}
	if (normalized.includes("next.js") || normalized.includes("nextjs")) {
		matches.push("nextjs.org", "vercel.com");
	}
	if (normalized.includes("playwright")) {
		matches.push("playwright.dev");
	}
	if (normalized.includes("supabase")) {
		matches.push("supabase.com", "supabase.io");
	}
	if (normalized.includes("prisma")) {
		matches.push("prisma.io");
	}
	if (normalized.includes("tailwind")) {
		matches.push("tailwindcss.com");
	}
	if (normalized.includes("vite")) {
		matches.push("vitejs.dev", "vite.dev");
	}
	if (normalized.includes("astro")) {
		matches.push("astro.build");
	}
	if (normalized.includes("svelte")) {
		matches.push("svelte.dev");
	}
	if (normalized.includes("solid")) {
		matches.push("solidjs.com");
	}
	if (normalized.includes("vue") || normalized.includes("nuxt")) {
		matches.push("vuejs.org", "nuxt.com");
	}
	if (normalized.includes("react") || normalized.includes("react native")) {
		matches.push("react.dev", "reactnative.dev");
	}
	if (normalized.includes("angular")) {
		matches.push("angular.io", "angular.dev");
	}
	if (normalized.includes("node.js") || normalized.includes("nodejs")) {
		matches.push("nodejs.org", "nodejs.dev", "npmjs.com");
	}
	if (/\bgo\b/.test(normalized) || normalized.includes("golang")) {
		matches.push("go.dev", "golang.org", "pkg.go.dev");
	}
	if (normalized.includes("deno")) {
		matches.push("deno.land", "deno.com");
	}
	if (normalized.includes("fresh")) {
		matches.push("fresh.deno.dev");
	}
	if (normalized.includes("typescript") || normalized.includes("ts")) {
		matches.push("typescriptlang.org");
	}
	if (normalized.includes("python")) {
		matches.push("python.org", "docs.python.org");
	}
	if (normalized.includes("rust")) {
		matches.push("rust-lang.org", "docs.rs", "crates.io");
	}
	if (normalized.includes("zig")) {
		matches.push("ziglang.org");
	}
	if (normalized.includes("docker")) {
		matches.push("docker.com", "docs.docker.com", "hub.docker.com");
	}
	if (normalized.includes("kubernetes") || normalized.includes("k8s")) {
		matches.push("kubernetes.io", "k8s.io");
	}
	if (normalized.includes("postgres") || normalized.includes("postgresql")) {
		matches.push("postgresql.org", "neon.tech", "supabase.com");
	}
	if (normalized.includes("redis")) {
		matches.push("redis.io");
	}
	if (normalized.includes("sqlite")) {
		matches.push("sqlite.org");
	}
	if (normalized.includes("cloudflare")) {
		matches.push("developers.cloudflare.com", "cloudflare.com");
	}
	if (normalized.includes("vercel")) {
		matches.push("vercel.com", "nextjs.org");
	}
	if (normalized.includes("netlify")) {
		matches.push("netlify.com", "docs.netlify.com");
	}
	if (normalized.includes("stripe")) {
		matches.push("stripe.com", "docs.stripe.com");
	}
	if (normalized.includes("github")) {
		matches.push("github.com", "docs.github.com");
	}
	if (normalized.includes("gitlab")) {
		matches.push("gitlab.com", "docs.gitlab.com");
	}
	if (normalized.includes("aws")) {
		matches.push("aws.amazon.com", "docs.aws.amazon.com");
	}
	if (normalized.includes("azure")) {
		matches.push("azure.microsoft.com", "learn.microsoft.com");
	}
	if (normalized.includes("gcp") || normalized.includes("google cloud")) {
		matches.push("cloud.google.com", "developers.google.com");
	}
	if (normalized.includes("gemini") || normalized.includes("google ai")) {
		matches.push("ai.google.dev", "developers.google.com");
	}

	return [...new Set(matches)];
}

export function domainMatches(hostname, candidate) {
	return hostname === candidate || hostname.endsWith(`.${candidate}`);
}

export function buildSourceRegistry(out, query = "") {
	const seen = new Map();
	const engineOrder = ["perplexity", "bing", "google"];

	// Get preferred domains for this query
	const preferredDomains = inferPreferredDomains(query);

	for (const engine of engineOrder) {
		const result = out[engine];
		if (!result?.sources) continue;

		for (let i = 0; i < result.sources.length; i++) {
			const source = result.sources[i];
			const canonicalUrl = normalizeUrl(source.url);
			if (!canonicalUrl || canonicalUrl.length < 10) continue;

			const title = normalizeSourceTitle(source.title || "");
			const domain = getDomain(canonicalUrl);
			const sourceType = classifySourceType(domain, title, canonicalUrl);

			// Calculate smart score boost
			let smartScore = 0;

			// Boost preferred domains for this query
			if (preferredDomains.some((pd) => domainMatches(domain, pd))) {
				smartScore += 10; // Strong boost for query-relevant official docs
			}

			// Boost docs/developer sites
			if (sourceType === "official-docs") {
				smartScore += 3;
			}

			// Boost based on URL path patterns
			const lowerUrl = canonicalUrl.toLowerCase();
			if (
				/\/docs\/|\/documentation\/|\.dev\/|\/api\/|\/reference\//.test(
					lowerUrl,
				)
			) {
				smartScore += 2;
			}

			// Penalize community/discussion sites for technical queries
			if (sourceType === "community" && preferredDomains.length > 0) {
				smartScore -= 2;
			}

			const existing = seen.get(canonicalUrl) || {
				id: "",
				canonicalUrl,
				displayUrl: source.url || canonicalUrl,
				domain,
				title: "",
				engines: [],
				engineCount: 0,
				perEngine: {},
				sourceType,
				isOfficial: sourceType === "official-docs",
				smartScore: 0,
			};

			existing.title = pickPreferredTitle(existing.title, title);
			existing.displayUrl = existing.displayUrl || source.url || canonicalUrl;
			existing.sourceType = existing.sourceType || sourceType;
			existing.isOfficial =
				existing.isOfficial || sourceType === "official-docs";
			existing.smartScore = Math.max(existing.smartScore, smartScore);

			if (!existing.engines.includes(engine)) {
				existing.engines.push(engine);
			}
			existing.perEngine[engine] = {
				rank: i + 1,
				title: pickPreferredTitle(
					existing.perEngine[engine]?.title || "",
					title,
				),
			};

			seen.set(canonicalUrl, existing);
		}
	}

	const sources = Array.from(seen.values())
		.map((source) => ({
			...source,
			engineCount: source.engines.length,
		}))
		.sort((a, b) => {
			// Primary: smart score (query-aware domain boosting)
			if (b.smartScore !== a.smartScore) return b.smartScore - a.smartScore;

			// Secondary: consensus (sources found by more engines)
			if (b.engineCount !== a.engineCount) return b.engineCount - a.engineCount;

			// Tertiary: source type priority
			if (
				sourceTypePriority(b.sourceType) !== sourceTypePriority(a.sourceType)
			) {
				return (
					sourceTypePriority(b.sourceType) - sourceTypePriority(a.sourceType)
				);
			}

			// Quaternary: best rank across engines
			if (bestRank(a) !== bestRank(b)) return bestRank(a) - bestRank(b);

			return a.domain.localeCompare(b.domain);
		})
		.slice(0, 12)
		.map((source, index) => ({
			...source,
			id: `S${index + 1}`,
			title: source.title || source.domain || source.canonicalUrl,
		}));

	return sources;
}

export function mergeFetchDataIntoSources(sources, fetchedSources) {
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
				publishedTime: fetched.publishedTime || "",
				byline: fetched.byline || "",
				siteName: fetched.siteName || "",
				lang: fetched.lang || "",
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
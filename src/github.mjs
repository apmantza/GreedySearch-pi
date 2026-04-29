// src/github.mjs - GitHub content fetching via REST API

const GITHUB_API = "https://api.github.com";
const DEFAULT_HEADERS = {
	"user-agent": "GreedySearch/1.0",
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
};

/**
 * Parse a GitHub URL into components
 * @param {string} url
 * @returns {{owner: string, repo: string, type: 'blob'|'tree'|'root', ref?: string, path?: string} | null}
 */
export function parseGitHubUrl(url) {
	try {
		const parsed = new URL(url);
		if (
			!(
				parsed.hostname === "github.com" ||
				parsed.hostname.endsWith(".github.com")
			)
		) {
			return null;
		}

		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 2) {
			return null;
		}

		const [owner, repo] = parts;

		// Root: github.com/owner/repo
		if (parts.length === 2) {
			return { owner, repo, type: "root" };
		}

		// With type: github.com/owner/repo/blob|tree/ref/path
		if (parts.length >= 4 && (parts[2] === "blob" || parts[2] === "tree")) {
			const type = parts[2];
			const ref = parts[3];
			const path = parts.slice(4).join("/");
			return { owner, repo, type, ref, path };
		}

		return null;
	} catch {
		return null;
	}
}

/**
 * Fetch JSON from GitHub API with timeout
 */
async function apiGet(path, timeoutMs = 10000) {
	const controller = new AbortController();
	const tid = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const res = await fetch(`${GITHUB_API}${path}`, {
			headers: DEFAULT_HEADERS,
			signal: controller.signal,
		});
		clearTimeout(tid);
		if (!res.ok) {
			throw new Error(`GitHub API ${res.status}: ${path}`);
		}
		return await res.json();
	} catch (err) {
		clearTimeout(tid);
		throw err;
	}
}

/**
 * Fetch the default branch README as plain text
 */
async function fetchReadme(owner, repo) {
	try {
		const data = await apiGet(`/repos/${owner}/${repo}/readme`);
		if (data.content && data.encoding === "base64") {
			return Buffer.from(data.content, "base64").toString("utf8");
		}
		return "";
	} catch {
		return "";
	}
}

/**
 * Fetch top-level file tree (non-recursive)
 */
async function fetchTree(owner, repo, ref = "HEAD", subPath = "") {
	try {
		// Resolve ref to a tree SHA first when using HEAD or a branch name
		const refData = await apiGet(
			`/repos/${owner}/${repo}/git/ref/heads/${ref === "HEAD" ? "main" : ref}`,
		).catch(() =>
			apiGet(`/repos/${owner}/${repo}/git/ref/heads/master`).catch(() => null),
		);

		let treeSha;
		if (refData?.object?.sha) {
			// Get commit to get tree SHA
			const commit = await apiGet(
				`/repos/${owner}/${repo}/git/commits/${refData.object.sha}`,
			);
			treeSha = commit.tree.sha;
		} else {
			// Fall back to repo default branch info
			const repoInfo = await apiGet(`/repos/${owner}/${repo}`);
			const branch = await apiGet(
				`/repos/${owner}/${repo}/branches/${repoInfo.default_branch}`,
			);
			treeSha = branch.commit.commit.tree.sha;
		}

		const treeData = await apiGet(
			`/repos/${owner}/${repo}/git/trees/${treeSha}`,
		);
		let items = treeData.tree || [];

		// Filter to subPath if requested
		if (subPath) {
			items = items.filter((item) => item.path.startsWith(subPath));
		}

		return items.slice(0, 50).map((item) => ({
			path: item.path,
			type: item.type === "tree" ? "dir" : "file",
			size: item.size,
		}));
	} catch {
		return [];
	}
}

/**
 * Fetch a specific file via raw.githubusercontent.com
 */
async function fetchRawFile(owner, repo, ref, filePath, timeoutMs = 10000) {
	const ref_ = ref && ref !== "HEAD" ? ref : "main";
	const urls = [
		`https://raw.githubusercontent.com/${owner}/${repo}/${ref_}/${filePath}`,
		`https://raw.githubusercontent.com/${owner}/${repo}/master/${filePath}`,
	];

	for (const url of urls) {
		const controller = new AbortController();
		const tid = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const res = await fetch(url, {
				headers: { "user-agent": DEFAULT_HEADERS["user-agent"] },
				signal: controller.signal,
			});
			clearTimeout(tid);
			if (res.ok) {
				return await res.text();
			}
		} catch {
			clearTimeout(tid);
		}
	}
	return null;
}

/**
 * Fetch GitHub content via API
 * @param {string} url - GitHub URL (blob, tree, or root)
 * @returns {Promise<{ok: boolean, content?: string, title?: string, error?: string, tree?: Array}>}
 */
export async function fetchGitHubContent(url) {
	const parsed = parseGitHubUrl(url);
	if (!parsed) {
		return { ok: false, error: "Not a valid GitHub URL" };
	}

	const { owner, repo, type, ref, path } = parsed;

	try {
		if (type === "root" || (type === "tree" && !path)) {
			// Fetch repo info + README + top-level tree in parallel
			const [repoInfo, readme, tree] = await Promise.allSettled([
				apiGet(`/repos/${owner}/${repo}`),
				fetchReadme(owner, repo),
				fetchTree(owner, repo, ref || "HEAD"),
			]);

			// If repo info failed (e.g. 404 — repo doesn't exist), bail out
			if (repoInfo.status === "rejected") {
				return {
					ok: false,
					error: repoInfo.reason?.message || "Repo not found",
				};
			}

			const info = repoInfo.value;
			const readmeText = readme.status === "fulfilled" ? readme.value : "";
			const treeItems = tree.status === "fulfilled" ? tree.value : [];

			const description = info?.description ? `\n\n> ${info.description}` : "";
			const stars =
				info?.stargazers_count != null ? ` ⭐ ${info.stargazers_count}` : "";
			const language = info?.language ? ` · ${info.language}` : "";

			let content = `# ${owner}/${repo}${stars}${language}${description}\n\n`;

			if (readmeText) {
				content += readmeText.slice(0, 6000);
			} else {
				content += `[No README found]\n\nFiles:\n${treeItems.map((t) => `  ${t.type === "dir" ? "📁" : "📄"} ${t.path}`).join("\n")}`;
			}

			return {
				ok: true,
				title: `${owner}/${repo}`,
				content,
				tree: treeItems.slice(0, 30),
			};
		}

		if (type === "blob" && path) {
			// Fetch specific file via raw URL
			const content = await fetchRawFile(owner, repo, ref, path);
			if (content === null) {
				return { ok: false, error: `File not found: ${path}` };
			}
			return {
				ok: true,
				title: `${owner}/${repo}: ${path}`,
				content,
			};
		}

		if (type === "tree" && path) {
			// Directory listing via API tree
			const treeItems = await fetchTree(owner, repo, ref || "HEAD", path);
			const listing = treeItems
				.map((t) => `  ${t.type === "dir" ? "📁" : "📄"} ${t.path}`)
				.join("\n");

			return {
				ok: true,
				title: `${owner}/${repo}/${path}`,
				content: `[Directory: ${path}]\n\nFiles:\n${listing}`,
				tree: treeItems,
			};
		}

		return { ok: false, error: "Unsupported GitHub URL type" };
	} catch (err) {
		return { ok: false, error: err.message };
	}
}

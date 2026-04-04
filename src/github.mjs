// src/github.mjs - GitHub repo cloning for better code extraction

import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const CLONE_CACHE = new Map(); // repo key -> path
const DEFAULT_MAX_FILES = 50;
const MAX_FILE_SIZE_BYTES = 1024 * 1024; // 1MB per file

/**
 * Parse a GitHub URL into components
 * @param {string} url
 * @returns {{owner: string, repo: string, type: 'blob'|'tree'|'root', ref?: string, path?: string} | null}
 */
export function parseGitHubUrl(url) {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.endsWith("github.com")) {
			return null;
		}

		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length < 2) {
			return null; // Need at least owner/repo
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
 * Check if git CLI is available
 */
async function checkGitAvailable() {
	try {
		await execFile("git", ["--version"]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Clone a GitHub repo and return local path
 * @param {string} owner - Repo owner
 * @param {string} repo - Repo name
 * @param {string} [ref] - Branch/tag/commit (default: main/master)
 * @returns {Promise<{path: string, cached: boolean, error?: string}>}
 */
export async function cloneGitHubRepo(owner, repo, ref = "HEAD") {
	const cacheKey = `${owner}/${repo}@${ref}`;

	// Check cache
	if (CLONE_CACHE.has(cacheKey)) {
		const cachedPath = CLONE_CACHE.get(cacheKey);
		if (existsSync(cachedPath)) {
			return { path: cachedPath, cached: true };
		}
		// Cache stale, remove
		CLONE_CACHE.delete(cacheKey);
	}

	// Check git available
	if (!(await checkGitAvailable())) {
		return { path: "", cached: false, error: "git CLI not available" };
	}

	// Create temp directory
	const tempBase = mkdtempSync(join(tmpdir(), `github-${owner}-${repo}-`));
	const clonePath = join(tempBase, "repo");

	try {
		// Shallow clone
		await execFile(
			"git",
			[
				"clone",
				"--depth",
				"1",
				"--single-branch",
				"--branch",
				ref === "HEAD" ? "main" : ref,
				`https://github.com/${owner}/${repo}.git`,
				clonePath,
			],
			{ timeout: 60000 },
		);

		// Cache result
		CLONE_CACHE.set(cacheKey, clonePath);

		return { path: clonePath, cached: false };
	} catch (error) {
		// Try 'master' if 'main' failed
		if (ref === "HEAD") {
			try {
				await execFile(
					"git",
					[
						"clone",
						"--depth",
						"1",
						"--single-branch",
						"--branch",
						"master",
						`https://github.com/${owner}/${repo}.git`,
						clonePath,
					],
					{ timeout: 60000 },
				);

				CLONE_CACHE.set(cacheKey, clonePath);
				return { path: clonePath, cached: false };
			} catch {
				// Fall through to error
			}
		}

		return { path: "", cached: false, error: error.message };
	}
}

/**
 * Read a file from cloned repo
 * @param {string} repoPath - Local repo path
 * @param {string} filePath - Relative path within repo
 * @returns {{content: string, size: number} | null}
 */
export function readRepoFile(repoPath, filePath) {
	const fullPath = join(repoPath, filePath);

	// Security: ensure path is within repo
	if (!fullPath.startsWith(repoPath)) {
		return null;
	}

	if (!existsSync(fullPath)) {
		return null;
	}

	const stats = statSync(fullPath);
	if (stats.isDirectory()) {
		return null;
	}

	if (stats.size > MAX_FILE_SIZE_BYTES) {
		return {
			content: `[File too large: ${(stats.size / 1024).toFixed(1)}KB]`,
			size: stats.size,
		};
	}

	try {
		const content = readFileSync(fullPath, "utf8");
		return { content, size: stats.size };
	} catch {
		return null;
	}
}

/**
 * Get directory tree listing
 * @param {string} repoPath - Local repo path
 * @param {string} [subPath] - Subdirectory to list
 * @param {number} [maxFiles] - Max files to return
 * @returns {Array<{path: string, type: 'file'|'dir', size?: number}>}
 */
export function getRepoTree(
	repoPath,
	subPath = "",
	maxFiles = DEFAULT_MAX_FILES,
) {
	const targetPath = join(repoPath, subPath);

	// Security: ensure within repo
	if (!targetPath.startsWith(repoPath)) {
		return [];
	}

	if (!existsSync(targetPath)) {
		return [];
	}

	const results = [];

	function walk(dir, relativePath) {
		if (results.length >= maxFiles) return;

		try {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				if (results.length >= maxFiles) break;

				// Skip hidden and common non-source dirs
				if (
					entry.name.startsWith(".") ||
					entry.name === "node_modules" ||
					entry.name === "vendor"
				) {
					continue;
				}

				const entryRelPath = join(relativePath, entry.name);

				if (entry.isDirectory()) {
					results.push({ path: entryRelPath, type: "dir" });
					walk(join(dir, entry.name), entryRelPath);
				} else if (entry.isFile()) {
					const stats = statSync(join(dir, entry.name));
					results.push({ path: entryRelPath, type: "file", size: stats.size });
				}
			}
		} catch {
			// Ignore permission errors
		}
	}

	walk(targetPath, subPath);
	return results;
}

/**
 * Fetch GitHub content by cloning repo
 * @param {string} url - GitHub URL (blob, tree, or root)
 * @returns {Promise<{ok: boolean, content?: string, title?: string, error?: string, localPath?: string, tree?: Array}>}
 */
export async function fetchGitHubContent(url) {
	const parsed = parseGitHubUrl(url);
	if (!parsed) {
		return { ok: false, error: "Not a valid GitHub URL" };
	}

	const { owner, repo, type, ref, path } = parsed;

	// Clone repo
	const cloneResult = await cloneGitHubRepo(owner, repo, ref);
	if (cloneResult.error) {
		return { ok: false, error: `Clone failed: ${cloneResult.error}` };
	}

	const repoPath = cloneResult.path;

	// Handle different URL types
	if (type === "root" || (type === "tree" && !path)) {
		// Return README + tree
		const tree = getRepoTree(repoPath, "", 50);

		// Try to find README
		const readmeNames = ["README.md", "Readme.md", "readme.md", "README.MD"];
		let readmeContent = "";
		for (const name of readmeNames) {
			const readme = readRepoFile(repoPath, name);
			if (readme) {
				readmeContent = readme.content.slice(0, 5000); // First 5KB of README
				break;
			}
		}

		return {
			ok: true,
			title: `${owner}/${repo}`,
			content: readmeContent || `[Repository: ${owner}/${repo}]`,
			localPath: repoPath,
			tree: tree.slice(0, 30),
		};
	}

	if (type === "blob" && path) {
		// Return specific file
		const file = readRepoFile(repoPath, path);
		if (!file) {
			return { ok: false, error: `File not found: ${path}` };
		}

		return {
			ok: true,
			title: `${owner}/${repo}: ${path}`,
			content: file.content,
			localPath: join(repoPath, path),
		};
	}

	if (type === "tree" && path) {
		// Return directory listing
		const tree = getRepoTree(repoPath, path, 50);

		return {
			ok: true,
			title: `${owner}/${repo}/${path}`,
			content: `[Directory: ${path}]\n\nFiles:\n${tree.map((t) => `  ${t.type === "dir" ? "📁" : "📄"} ${t.path}`).join("\n")}`,
			localPath: join(repoPath, path),
			tree,
		};
	}

	return { ok: false, error: "Unsupported GitHub URL type" };
}

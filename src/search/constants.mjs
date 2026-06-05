// src/search/constants.mjs — Shared constants for GreedySearch search pipeline

import { tmpdir } from "node:os";

export const GREEDY_PORT = 9222;
export const GREEDY_PROFILE_DIR = `${tmpdir().replaceAll("\\", "/")}/greedysearch-chrome-profile`;
export const ACTIVE_PORT_FILE = `${GREEDY_PROFILE_DIR}/DevToolsActivePort`;
export const PAGES_CACHE = `${tmpdir().replaceAll("\\", "/")}/cdp-pages.json`;
export const CHROME_MODE_FILE = `${tmpdir().replaceAll("\\", "/")}/greedysearch-chrome-mode`;

// ALL_ENGINES drives the "all" fan-out. Add engines here to include them in multi-engine searches.
// Engines in ENGINES but not in ALL_ENGINES are available for explicit use only.
// Bing Copilot removed from default fan-out (2026-06-05) — now requires Microsoft sign-in on fresh sessions.
export const ALL_ENGINES = ["perplexity", "google"];

export const ENGINE_DOMAINS = {
	perplexity: "perplexity.ai",
	bing: "copilot.microsoft.com",
	google: "google.com",
	gemini: "gemini.google.com",
};

export const ENGINES = {
	perplexity: "perplexity.mjs",
	p: "perplexity.mjs",
	bing: "bing-copilot.mjs",
	b: "bing-copilot.mjs",
	google: "google-ai.mjs",
	g: "google-ai.mjs",
	gemini: "gemini.mjs",
	gem: "gemini.mjs",
};

export const SOURCE_FETCH_CONCURRENCY = Math.max(
	1,
	Number.parseInt(process.env.GREEDY_FETCH_CONCURRENCY || "5", 10) || 5,
);

// Tell cdp.mjs to prefer the GreedySearch Chrome profile's DevToolsActivePort
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;

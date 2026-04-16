// src/search/constants.mjs — Shared constants for GreedySearch search pipeline

import { tmpdir } from "node:os";

export const GREEDY_PORT = 9222;
export const GREEDY_PROFILE_DIR = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
export const ACTIVE_PORT_FILE = `${GREEDY_PROFILE_DIR}/DevToolsActivePort`;
export const PAGES_CACHE = `${tmpdir().replace(/\\/g, "/")}/cdp-pages.json`;

export const ALL_ENGINES = ["perplexity", "bing", "google"];

export const ENGINE_DOMAINS = {
	perplexity: "perplexity.ai",
	bing: "copilot.microsoft.com",
	google: "google.com",
	gemini: "gemini.google.com",
};

export const ENGINES = {
	perplexity: "perplexity.mjs",
	pplx: "perplexity.mjs",
	p: "perplexity.mjs",
	bing: "bing-copilot.mjs",
	copilot: "bing-copilot.mjs",
	b: "bing-copilot.mjs",
	google: "google-ai.mjs",
	g: "google-ai.mjs",
	gemini: "gemini.mjs",
	gem: "gemini.mjs",
};

export const SOURCE_FETCH_CONCURRENCY = Math.max(
	1,
	parseInt(process.env.GREEDY_FETCH_CONCURRENCY || "2", 10) || 2,
);

// Tell cdp.mjs to prefer the GreedySearch Chrome profile's DevToolsActivePort
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;
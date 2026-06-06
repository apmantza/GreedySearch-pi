// src/search/constants.mjs — Shared constants for GreedySearch search pipeline

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const GREEDY_PORT = 9222;
export const GREEDY_PROFILE_DIR = `${tmpdir().replaceAll("\\", "/")}/greedysearch-chrome-profile`;
export const ACTIVE_PORT_FILE = `${GREEDY_PROFILE_DIR}/DevToolsActivePort`;
export const PAGES_CACHE = `${tmpdir().replaceAll("\\", "/")}/cdp-pages.json`;
export const CHROME_MODE_FILE = `${tmpdir().replaceAll("\\", "/")}/greedysearch-chrome-mode`;

// ── User config: ~/.pi/greedyconfig ────────────────────────────────────────
// Users can override which engines participate in the "all" fan-out and which
// engine performs optional synthesis.
// Default engines: perplexity, google, chatgpt; synthesizer: gemini

const CONFIG_DIR = join(homedir(), ".pi");
const CONFIG_FILE = join(CONFIG_DIR, "greedyconfig");

const DEFAULT_ENGINES = ["perplexity", "google", "chatgpt"];
const DEFAULT_SYNTHESIZER = "gemini";

function loadUserEngines() {
	try {
		if (existsSync(CONFIG_FILE)) {
			const raw = readFileSync(CONFIG_FILE, "utf8");
			const config = JSON.parse(raw);
			if (
				Array.isArray(config.engines) &&
				config.engines.length > 0 &&
				config.engines.every((e) => typeof e === "string")
			) {
				// Validate each engine exists in ENGINES. Unknown names are
				// silently dropped — but at least once we tell the user about
				// it so a typo in ~/.pi/greedyconfig doesn't quietly shrink
				// the all-search fan-out.
				const valid = config.engines.filter((e) => ENGINES[e]);
				const invalid = config.engines.filter((e) => !ENGINES[e]);
				if (invalid.length > 0) {
					process.stderr.write(
						`[greedysearch] Warning: ignoring unknown engine(s) in ${CONFIG_FILE}: ${invalid.join(", ")}\n` +
							`[greedysearch] Available engines: ${Object.keys(ENGINES).join(", ")}\n`,
					);
				}
				if (valid.length > 0) return valid;
				process.stderr.write(
					`[greedysearch] Warning: no valid engines in ${CONFIG_FILE}, falling back to defaults: ${DEFAULT_ENGINES.join(", ")}\n`,
				);
			}
		}
	} catch {
		// Ignore parse/read errors — fall through to default
	}
	return DEFAULT_ENGINES;
}

function ensureDefaultConfig() {
	try {
		if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
		if (!existsSync(CONFIG_FILE)) {
			writeFileSync(
				CONFIG_FILE,
				JSON.stringify(
					{ engines: DEFAULT_ENGINES, synthesizer: DEFAULT_SYNTHESIZER },
					null,
					2,
				) + "\n",
				"utf8",
			);
		}
	} catch {
		// Best-effort — don't crash if we can't write the config file
	}
}

ensureDefaultConfig();

export const SUPPORTED_SYNTHESIZERS = ["gemini", "chatgpt"];

function loadUserSynthesizer() {
	try {
		if (existsSync(CONFIG_FILE)) {
			const raw = readFileSync(CONFIG_FILE, "utf8");
			const config = JSON.parse(raw);
			if (typeof config.synthesizer === "string") {
				const normalized = config.synthesizer.toLowerCase();
				if (SUPPORTED_SYNTHESIZERS.includes(normalized)) return normalized;
				process.stderr.write(
					`[greedysearch] Warning: unknown synthesizer "${config.synthesizer}" in ${CONFIG_FILE}\n` +
						`[greedysearch] Available synthesizers: ${SUPPORTED_SYNTHESIZERS.join(", ")}\n` +
						`[greedysearch] Falling back to default: ${DEFAULT_SYNTHESIZER}\n`,
				);
			}
		}
	} catch {
		// Ignore parse/read errors — fall through to default
	}
	return DEFAULT_SYNTHESIZER;
}

export const ENGINE_DOMAINS = {
	perplexity: "perplexity.ai",
	bing: "copilot.microsoft.com",
	google: "google.com",
	gemini: "gemini.google.com",
	chatgpt: "chatgpt.com",
	consensus: "consensus.app",
	logically: "logically.app",
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
	chatgpt: "chatgpt.mjs",
	gpt: "chatgpt.mjs",
	consensus: "consensus.mjs",
	cns: "consensus.mjs",
	logically: "logically.mjs",
	log: "logically.mjs",
};

// ALL_ENGINES drives the "all" fan-out. Edit ~/.pi/greedyconfig to customize.
export const ALL_ENGINES = loadUserEngines();

// SYNTHESIZER drives optional all-search synthesis. Edit ~/.pi/greedyconfig to customize.
export const SYNTHESIZER = loadUserSynthesizer();

export const SOURCE_FETCH_CONCURRENCY = Math.max(
	1,
	Number.parseInt(process.env.GREEDY_FETCH_CONCURRENCY || "5", 10) || 5,
);

// Tell cdp.mjs to prefer the GreedySearch Chrome profile's DevToolsActivePort
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;

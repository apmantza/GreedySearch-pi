/**
 * GreedySearch Pi Extension
 *
 * Adds `greedy_search` tool to Pi.
 * Use depth: "deep" for deep research (source fetching + synthesis + confidence).
 *
 * Reports streaming progress as each engine completes.
 * Requires Chrome to be running (or it auto-launches a dedicated instance).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { registerGreedySearchTool } from "./src/tools/greedy-search-handler.js";
import { cdpAvailable } from "./src/tools/shared.js";

const __dir = dirname(fileURLToPath(import.meta.url));

export default function greedySearchExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!cdpAvailable(__dir)) {
			ctx.ui.notify(
				"GreedySearch: cdp.mjs missing from package directory — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi",
				"warning",
			);
		}
	});

	// ─── greedy_search ────────────────────────────────────────────────────────
	registerGreedySearchTool(pi, __dir);

	// ─── /set-greedy-locale command ───────────────────────────────────────────
	pi.registerCommand("set-greedy-locale", {
		description:
			"Set default locale for GreedySearch results (e.g., /set-greedy-locale de, /set-greedy-locale --clear, /set-greedy-locale --show)",
		handler: async (args, ctx) => {
			const arg = args.trim() || "--show";

			if (arg === "--show") {
				const config = loadUserConfig();
				if (config.locale) {
					ctx.ui.notify(`Default locale: ${config.locale}`, "info");
				} else {
					ctx.ui.notify("No default locale (uses: en)", "info");
				}
				return;
			}

			if (arg === "--clear") {
				const config = loadUserConfig();
				delete config.locale;
				saveUserConfig(config);
				ctx.ui.notify("Default locale cleared (now uses: en).", "info");
				return;
			}

			// Set locale
			const locale = arg.toLowerCase();
			const VALID_LOCALES = [
				"en",
				"de",
				"fr",
				"es",
				"it",
				"pt",
				"nl",
				"pl",
				"ru",
				"ja",
				"ko",
				"zh",
				"ar",
				"hi",
				"tr",
				"sv",
				"da",
				"no",
				"fi",
				"cs",
				"hu",
				"ro",
				"el",
			];

			if (!VALID_LOCALES.includes(locale)) {
				ctx.ui.notify(
					`Invalid locale "${locale}". Valid: ${VALID_LOCALES.join(", ")}`,
					"error",
				);
				return;
			}

			const config = loadUserConfig();
			config.locale = locale;
			saveUserConfig(config);
			ctx.ui.notify(`Default locale set to: ${locale}`, "info");
		},
	});
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
// Config helpers for /set-greedy-locale command
import { homedir } from "node:os";

const USER_CONFIG_DIR = join(homedir(), ".config", "greedysearch");
const USER_CONFIG_FILE = join(USER_CONFIG_DIR, "config.json");

function loadUserConfig(): Record<string, string> {
	try {
		if (existsSync(USER_CONFIG_FILE)) {
			return JSON.parse(readFileSync(USER_CONFIG_FILE, "utf8"));
		}
	} catch {
		// Ignore parse errors
	}
	return {};
}

function saveUserConfig(config: Record<string, string>): void {
	mkdirSync(USER_CONFIG_DIR, { recursive: true });
	writeFileSync(USER_CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
}

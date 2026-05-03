/**
 * GreedySearch Pi Extension
 *
 * Adds `greedy_search`, `deep_research`, and `coding_task` tools to Pi.
 * Tool handlers are split into separate modules for maintainability.
 *
 * Reports streaming progress as each engine completes.
 * Requires Chrome to be running (or it auto-launches a dedicated instance).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { formatCodingTask } from "./src/formatters/coding.js";
import { touchActivity } from "./src/search/chrome.mjs";
import { DEFAULTS } from "./src/search/defaults.mjs";
import { registerDeepResearchTool } from "./src/tools/deep-research-handler.js";
import { registerGreedySearchTool } from "./src/tools/greedy-search-handler.js";
import {
	cdpAvailable,
	type ProgressUpdate,
	stripQuotes,
} from "./src/tools/shared.js";

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

	// ─── deep_research ────────────────────────────────────────────────────────
	registerDeepResearchTool(pi, __dir);

	// ─── coding_task ───────────────────────────────────────────────────────────
	pi.registerTool({
		name: "coding_task",
		label: "Coding Task",
		description:
			"Delegate a coding task to Gemini and/or Copilot via browser automation. " +
			"Returns extracted code blocks and explanations. Supports multiple modes: " +
			"'code' (write/modify code), 'review' (senior engineer code review), " +
			"'plan' (architect risk assessment), 'test' (edge case testing), " +
			"'debug' (fresh-eyes root cause analysis). " +
			"Best for getting a 'second opinion' on hard problems, debugging tricky issues, " +
			"or risk-assessing major refactors. Use engine 'all' for both perspectives.",
		promptSnippet: "Browser-based coding assistant with Gemini and Copilot",
		parameters: Type.Object({
			task: Type.String({ description: "The coding task or question" }),
			engine: Type.String({
				description:
					'Engine to use: "all" (runs both Gemini and Copilot in parallel), "gemini" (default), "copilot".',
				default: "gemini",
			}),
			mode: Type.String({
				description:
					'Task mode: "code" (default), "review" (code review), "plan" (architect review), "test" (write tests), "debug" (root cause analysis).',
				default: "code",
			}),
			context: Type.Optional(
				Type.String({
					description: "Optional code context/snippet to include with the task",
				}),
			),
			headless: Type.Optional(
				Type.Boolean({
					description:
						"When true, runs Chrome in headless mode (no GUI window).",
					default: false,
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { task, context } = params as {
				task: string;
				engine: string;
				mode: string;
				context?: string;
				headless?: boolean;
			};
			const engine =
				stripQuotes((params as any).engine ?? "gemini") || "gemini";
			const mode = stripQuotes((params as any).mode ?? "code") || "code";
			const headless =
				(params as any).headless === true ||
				process.env.GREEDY_SEARCH_HEADLESS === "1";

			if (!cdpAvailable(__dir)) {
				return {
					content: [
						{ type: "text", text: "cdp.mjs missing — try reinstalling." },
					],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			// Touch activity for headless idle timeout
			touchActivity();

			const flags: string[] = ["--engine", engine, "--mode", mode];
			if (context) flags.push("--context", context);
			if (headless) flags.push("--headless");

			try {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `**Coding task...** 🔄 ${engine === "all" ? "Gemini + Copilot" : engine} (${mode} mode)`,
						},
					],
					details: { _progress: true },
				} satisfies ProgressUpdate);

				const data = await new Promise<Record<string, unknown>>(
					(resolve, reject) => {
						const proc = spawn(
							"node",
							[join(__dir, "bin", "coding-task.mjs"), task, ...flags],
							{
								stdio: ["ignore", "pipe", "pipe"],
							},
						);
						let out = "";
						let err = "";

						const onAbort = () => {
							proc.kill("SIGTERM");
							reject(new Error("Aborted"));
						};
						signal?.addEventListener("abort", onAbort, { once: true });

						proc.stdout.on("data", (d: Buffer) => (out += d));
						proc.stderr.on("data", (d: Buffer) => (err += d));
						proc.on("close", (code: number) => {
							signal?.removeEventListener("abort", onAbort);
							if (code !== 0) {
								reject(
									new Error(
										err.trim() || `coding-task.mjs exited with code ${code}`,
									),
								);
							} else {
								try {
									resolve(JSON.parse(out.trim()));
								} catch {
									reject(
										new Error(
											`Invalid JSON from coding-task.mjs: ${out.slice(0, 200)}`,
										),
									);
								}
							}
						});

						// Timeout after 3 minutes
						setTimeout(() => {
							proc.kill("SIGTERM");
							reject(
								new Error(
									`Coding task timed out after ${DEFAULTS.CODING_TASK_TIMEOUT / 1000}s`,
								),
							);
						}, DEFAULTS.CODING_TASK_TIMEOUT);
					},
				);

				const text = formatCodingTask(data);
				return {
					content: [{ type: "text", text: text || "No response." }],
					details: { raw: data },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Coding task failed: ${msg}` }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}
		},
	});

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

/**
 * GreedySearch Pi Extension
 *
 * Adds a `greedy_search` tool to Pi that fans out queries to Perplexity,
 * Bing Copilot, and Google AI in parallel, returning synthesized AI answers.
 *
 * Reports streaming progress as each engine completes.
 * Requires Chrome to be running (or it auto-launches a dedicated instance).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

// Formatters extracted to reduce file complexity
import { formatCodingTask } from "./src/formatters/coding.js";
import { formatResults, formatDeepResearch } from "./src/formatters/results.js";

const __dir = dirname(fileURLToPath(import.meta.url));

const ALL_ENGINES = ["perplexity", "bing", "google"] as const;

function cdpAvailable(): boolean {
	return existsSync(join(__dir, "cdp.mjs"));
}

function runSearch(
	engine: string,
	query: string,
	flags: string[] = [],
	signal?: AbortSignal,
	onProgress?: (engine: string, status: "done" | "error") => void,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const proc = spawn(
			"node",
			[`${__dir}/search.mjs`, engine, "--inline", ...flags, query],
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

		// Watch stderr for progress events (PROGRESS:engine:done|error)
		proc.stderr.on("data", (d: Buffer) => {
			err += d;
			const lines = d.toString().split("\n");
			for (const line of lines) {
				const match = line.match(/^PROGRESS:(\w+):(done|error)$/);
				if (match && onProgress) {
					onProgress(match[1], match[2] as "done" | "error");
				}
			}
		});

		proc.stdout.on("data", (d: Buffer) => (out += d));
		proc.on("close", (code: number) => {
			signal?.removeEventListener("abort", onAbort);
			if (code !== 0) {
				reject(new Error(err.trim() || `search.mjs exited with code ${code}`));
			} else {
				try {
					resolve(JSON.parse(out.trim()));
				} catch {
					reject(
						new Error(`Invalid JSON from search.mjs: ${out.slice(0, 200)}`),
					);
				}
			}
		});
	});
}

export default function greedySearchExtension(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		if (!cdpAvailable()) {
			ctx.ui.notify(
				"GreedySearch: cdp.mjs missing from package directory — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi",
				"warning",
			);
		}
	});

	pi.registerTool({
		name: "greedy_search",
		label: "Greedy Search",
		description:
			"WEB SEARCH ONLY — searches live web via Perplexity, Bing Copilot, and Google AI in parallel. " +
			"Optionally synthesizes results with Gemini, deduplicates sources by consensus. " +
			"Use for: library docs, recent framework changes, error messages, best practices, current events. " +
			"Reports streaming progress as each engine completes.",
		promptSnippet: "Multi-engine AI web search with streaming progress",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			engine: Type.Union(
				[
					Type.Literal("all"),
					Type.Literal("perplexity"),
					Type.Literal("bing"),
					Type.Literal("google"),
					Type.Literal("gemini"),
					Type.Literal("gem"),
				],
				{
					description:
						'Engine to use. "all" fans out to Perplexity, Bing, and Google in parallel (default).',
					default: "all",
				},
			),
			depth: Type.Union(
				[Type.Literal("fast"), Type.Literal("standard"), Type.Literal("deep")],
				{
					description:
						"Search depth: fast (single engine, ~15-30s), standard (3 engines + synthesis, ~30-90s), deep (3 engines + source fetching + synthesis + confidence, ~60-180s). Default: standard.",
					default: "standard",
				},
			),
			fullAnswer: Type.Optional(
				Type.Boolean({
					description:
						"When true, returns the complete answer instead of a truncated preview (default: false, answers are shortened to ~300 chars to save tokens).",
					default: false,
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const {
				query,
				engine = "all",
				depth = "standard",
				fullAnswer: fullAnswerParam,
			} = params as {
				query: string;
				engine: string;
				depth?: "fast" | "standard" | "deep";
				fullAnswer?: boolean;
			};

			if (!cdpAvailable()) {
				return {
					content: [
						{
							type: "text",
							text: "cdp.mjs missing — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi",
						},
					],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const flags: string[] = [];
			// Default to full answer for single-engine queries (unless explicitly set to false)
			// For multi-engine, default to truncated to save tokens during synthesis
			const fullAnswer = fullAnswerParam ?? (engine !== "all");
			if (fullAnswer) flags.push("--full");
			if (depth === "deep") flags.push("--deep");
			else if (depth === "standard" && engine === "all") flags.push("--synthesize");

			const completed = new Set<string>();

			const onProgress = (eng: string, _status: "done" | "error") => {
				completed.add(eng);
				const parts: string[] = [];
				for (const e of ALL_ENGINES) {
					if (completed.has(e)) parts.push(`✅ ${e} done`);
					else parts.push(`⏳ ${e}`);
				}
				if (depth !== "fast" && completed.size >= 3)
					parts.push("🔄 synthesizing");

				onUpdate?.({
					content: [
						{ type: "text", text: `**Searching...** ${parts.join(" · ")}` },
					],
					details: { _progress: true },
				} as any);
			};

			try {
				const data = await runSearch(
					engine,
					query,
					flags,
					signal,
					engine === "all" ? onProgress : undefined,
				);
				const text = formatResults(engine, data);
				return {
					content: [{ type: "text", text: text || "No results returned." }],
					details: { raw: data },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}
		},
	});

	// ─── deep_research ─────────────────────────────────────────────────────────
	pi.registerTool({
		name: "deep_research",
		label: "Deep Research (legacy)",
		description:
			"DEPRECATED — Use greedy_search with depth: 'deep' instead. " +
			"Comprehensive multi-engine research with source fetching and synthesis.",
		promptSnippet: "Deep multi-engine research (legacy alias to greedy_search)",
		parameters: Type.Object({
			query: Type.String({ description: "The research question" }),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query } = params as { query: string };

			if (!cdpAvailable()) {
				return {
					content: [
						{ type: "text", text: "cdp.mjs missing — try reinstalling." },
					],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const completed = new Set<string>();

			const onProgress = (eng: string, _status: "done" | "error") => {
				completed.add(eng);
				const parts: string[] = [];
				for (const e of ALL_ENGINES) {
					if (completed.has(e)) parts.push(`✅ ${e}`);
					else parts.push(`⏳ ${e}`);
				}
				if (completed.size >= 3) parts.push("🔄 synthesizing");

				onUpdate?.({
					content: [
						{ type: "text", text: `**Researching...** ${parts.join(" · ")}` },
					],
					details: { _progress: true },
				} as any);
			};

			try {
				const data = await runSearch(
					"all",
					query,
					["--deep"],
					signal,
					onProgress,
				);
				const text = formatDeepResearch(data);
				return {
					content: [{ type: "text", text: text || "No results returned." }],
					details: { raw: data },
				};
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Deep research failed: ${msg}` }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}
		},
	});

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
			engine: Type.Union(
				[Type.Literal("all"), Type.Literal("gemini"), Type.Literal("copilot")],
				{
					description:
						'Engine to use. "all" runs both Gemini and Copilot in parallel.',
					default: "gemini",
				},
			),
			mode: Type.Union(
				[
					Type.Literal("code"),
					Type.Literal("review"),
					Type.Literal("plan"),
					Type.Literal("test"),
					Type.Literal("debug"),
				],
				{
					description:
						"Task mode: code (default), review (code review), plan (architect review), test (write tests), debug (root cause analysis)",
					default: "code",
				},
			),
			context: Type.Optional(
				Type.String({
					description: "Optional code context/snippet to include with the task",
				}),
			),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const {
				task,
				engine = "gemini",
				mode = "code",
				context,
			} = params as {
				task: string;
				engine: string;
				mode: string;
				context?: string;
			};

			if (!cdpAvailable()) {
				return {
					content: [
						{ type: "text", text: "cdp.mjs missing — try reinstalling." },
					],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const flags: string[] = ["--engine", engine, "--mode", mode];
			if (context) flags.push("--context", context);

			try {
				onUpdate?.({
					content: [
						{
							type: "text",
							text: `**Coding task...** 🔄 ${engine === "all" ? "Gemini + Copilot" : engine} (${mode} mode)`,
						},
					],
					details: { _progress: true },
				} as any);

				const data = await new Promise<Record<string, unknown>>(
					(resolve, reject) => {
						const proc = spawn(
							"node",
							[`${__dir}/coding-task.mjs`, task, ...flags],
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
						proc.stderr.on("data", (d: Buffer) => {
							err += d;
						});
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
							reject(new Error("Coding task timed out after 180s"));
						}, 180000);
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
}

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
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

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
		const proc = spawn("node", [__dir + "/search.mjs", engine, "--inline", ...flags, query], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";

		const onAbort = () => { proc.kill("SIGTERM"); reject(new Error("Aborted")); };
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
					reject(new Error(`Invalid JSON from search.mjs: ${out.slice(0, 200)}`));
				}
			}
		});
	});
}

function formatResults(engine: string, data: Record<string, unknown>): string {
	const lines: string[] = [];

	if (engine === "all") {
		// Synthesized output: prefer _synthesis + _sources
		const synthesis = data._synthesis as Record<string, unknown> | undefined;
		const dedupedSources = data._sources as Array<Record<string, unknown>> | undefined;
		if (synthesis?.answer) {
			lines.push("## Synthesis");
			lines.push(String(synthesis.answer));
			if (dedupedSources?.length) {
				lines.push("\n**Top sources by consensus:**");
				for (const s of dedupedSources.slice(0, 6)) {
					const engines = (s.engines as string[]) || [];
					lines.push(`- [${s.title || s.url}](${s.url}) [${engines.length}/3]`);
				}
			}
			lines.push("\n---\n*Synthesized from Perplexity, Bing Copilot, and Google AI*");
			return lines.join("\n").trim();
		}

		// Standard output: per-engine answers
		for (const [eng, result] of Object.entries(data)) {
			if (eng.startsWith("_")) continue;
			lines.push(`\n## ${eng.charAt(0).toUpperCase() + eng.slice(1)}`);
			const r = result as Record<string, unknown>;
			if (r.error) {
				lines.push(`Error: ${r.error}`);
			} else {
				if (r.answer) lines.push(String(r.answer));
				if (Array.isArray(r.sources) && r.sources.length > 0) {
					lines.push("\nSources:");
					for (const s of r.sources.slice(0, 3)) {
						const src = s as Record<string, string>;
						lines.push(`- [${src.title || src.url}](${src.url})`);
					}
				}
			}
		}
	} else {
		if (data.error) {
			lines.push(`Error: ${data.error}`);
		} else {
			if (data.answer) lines.push(String(data.answer));
			if (Array.isArray(data.sources) && data.sources.length > 0) {
				lines.push("\nSources:");
				for (const s of data.sources.slice(0, 5)) {
					const src = s as Record<string, string>;
					lines.push(`- [${src.title || src.url}](${src.url})`);
				}
			}
		}
	}

	return lines.join("\n").trim();
}

function formatDeepResearch(data: Record<string, unknown>): string {
	const lines: string[] = [];
	const confidence = data._confidence as Record<string, unknown> | undefined;
	const fetchedSources = data._fetchedSources as Array<Record<string, unknown>> | undefined;
	const dedupedSources = data._sources as Array<Record<string, unknown>> | undefined;

	lines.push("# Deep Research Report\n");

	// Confidence summary
	if (confidence) {
		const enginesResponded = (confidence.enginesResponded as string[]) || [];
		const enginesFailed = (confidence.enginesFailed as string[]) || [];
		const consensusScore = confidence.consensusScore || 0;

		lines.push("## Confidence\n");
		lines.push(`- **Engines responded:** ${enginesResponded.join(", ") || "none"}`);
		if (enginesFailed.length > 0) {
			lines.push(`- **Engines failed:** ${enginesFailed.join(", ")}`);
		}
		lines.push(`- **Top source consensus:** ${consensusScore}/3 engines`);
		lines.push(`- **Total unique sources:** ${confidence.sourcesCount || 0}`);
		lines.push("");
	}

	// Per-engine answers
	lines.push("## Findings\n");
	for (const engine of ["perplexity", "bing", "google"]) {
		const r = data[engine] as Record<string, unknown> | undefined;
		if (!r) continue;
		lines.push(`### ${engine.charAt(0).toUpperCase() + engine.slice(1)}`);
		if (r.error) {
			lines.push(`⚠️ Error: ${r.error}`);
		} else if (r.answer) {
			lines.push(String(r.answer).slice(0, 2000));
		}
		lines.push("");
	}

	// Synthesis
	const synthesis = data._synthesis as Record<string, unknown> | undefined;
	if (synthesis?.answer) {
		lines.push("## Synthesized Answer\n");
		lines.push(String(synthesis.answer));
		lines.push("");
	}

	// Deduplicated sources by consensus
	if (dedupedSources && dedupedSources.length > 0) {
		lines.push("## Sources (Ranked by Consensus)\n");
		for (const s of dedupedSources) {
			const engines = (s.engines as string[]) || [];
			const consensus = engines.length;
			lines.push(`- **[${consensus}/3]** [${s.title || "Untitled"}](${s.url})`);
		}
		lines.push("");
	}

	// Fetched source content
	if (fetchedSources && fetchedSources.length > 0) {
		lines.push("## Source Content (Top Matches)\n");
		for (const fs of fetchedSources) {
			lines.push(`### ${fs.title || fs.url}`);
			lines.push(`*Source: ${fs.url}*`);
			lines.push("");
			if (fs.content) {
				lines.push(String(fs.content).slice(0, 3000));
			} else if (fs.error) {
				lines.push(`⚠️ Could not fetch: ${fs.error}`);
			}
			lines.push("\n---\n");
		}
	}

	return lines.join("\n").trim();
}

function formatCodingTask(data: Record<string, unknown> | Record<string, Record<string, unknown>>): string {
	const lines: string[] = [];

	// Check if it's multi-engine result
	const hasMultipleEngines = "gemini" in data || "copilot" in data;
	
	if (hasMultipleEngines) {
		// Multi-engine result
		for (const [engineName, result] of Object.entries(data)) {
			const r = result as Record<string, unknown>;
			lines.push(`## ${engineName.charAt(0).toUpperCase() + engineName.slice(1)}\n`);
			
			if (r.error) {
				lines.push(`⚠️ Error: ${r.error}\n`);
			} else {
				if (r.explanation) lines.push(String(r.explanation));
				if (Array.isArray(r.code) && r.code.length > 0) {
					for (const block of r.code) {
						const b = block as { language: string; code: string };
						lines.push(`\n\`\`\`${b.language}\n${b.code}\n\`\`\`\n`);
					}
				}
				if (r.url) lines.push(`*Source: ${r.url}*`);
			}
			lines.push("");
		}
	} else {
		// Single engine result
		const r = data as Record<string, unknown>;
		if (r.explanation) lines.push(String(r.explanation));
		if (Array.isArray(r.code) && r.code.length > 0) {
			for (const block of r.code) {
				const b = block as { language: string; code: string };
				lines.push(`\n\`\`\`${b.language}\n${b.code}\n\`\`\`\n`);
			}
		}
		if (r.url) lines.push(`*Source: ${r.url}*`);
	}

	return lines.join("\n").trim();
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
			"Search the web using AI-powered engines (Perplexity, Bing Copilot, Google AI) in parallel. " +
			"Optionally synthesize results with Gemini — deduplicates sources by consensus and returns one grounded answer. " +
			"Reports streaming progress as each engine completes. " +
			"Use for current information, library docs, error messages, best practices, or any question where training data may be stale.",
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
					description: 'Engine to use. "all" fans out to Perplexity, Bing, and Google in parallel (default).',
					default: "all",
				},
			),
			synthesize: Type.Optional(Type.Boolean({
				description: 'When true and engine is "all", deduplicates sources across engines and feeds them to Gemini for a single grounded synthesis. Adds ~30s but saves tokens and improves answer quality.',
				default: false,
			})),
			fullAnswer: Type.Optional(Type.Boolean({
				description: 'When true, returns the complete answer instead of a truncated preview (default: false, answers are shortened to ~300 chars to save tokens).',
				default: false,
			})),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query, engine = "all", synthesize = false, fullAnswer = false } = params as {
				query: string; engine: string; synthesize?: boolean; fullAnswer?: boolean;
			};

			if (!cdpAvailable()) {
				return {
					content: [{ type: "text", text: "cdp.mjs missing — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi" }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const flags: string[] = [];
			if (fullAnswer) flags.push("--full");
			if (synthesize && engine === "all") flags.push("--synthesize");

			// Track progress for "all" engine mode
			const completed = new Set<string>();

			const onProgress = (eng: string, status: "done" | "error") => {
				completed.add(eng);
				const parts: string[] = [];
				for (const e of ALL_ENGINES) {
					if (completed.has(e)) parts.push(`✅ ${e} done`);
					else parts.push(`⏳ ${e}`);
				}
				if (synthesize && completed.size >= 3) parts.push("🔄 synthesizing");

				onUpdate?.({
					content: [{ type: "text", text: `**Searching...** ${parts.join(" · ")}` }],
					details: { _progress: true },
				} as any);
			};

			try {
				const data = await runSearch(engine, query, flags, signal, engine === "all" ? onProgress : undefined);
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
		label: "Deep Research",
		description:
			"Comprehensive multi-engine research with source fetching and synthesis. " +
			"Runs Perplexity, Bing Copilot, and Google AI in parallel with full answers, " +
			"deduplicates and ranks sources by consensus, fetches content from top sources, " +
			"and synthesizes via Gemini. Returns a structured research document with confidence scores. " +
			"Use for architecture decisions, library comparisons, best practices, or any research where the answer matters.",
		promptSnippet: "Deep multi-engine research with source deduplication and synthesis",
		parameters: Type.Object({
			query: Type.String({ description: "The research question" }),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { query } = params as { query: string };

			if (!cdpAvailable()) {
				return {
					content: [{ type: "text", text: "cdp.mjs missing — try reinstalling." }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const completed = new Set<string>();

			const onProgress = (eng: string, status: "done" | "error") => {
				completed.add(eng);
				const parts: string[] = [];
				for (const e of ALL_ENGINES) {
					if (completed.has(e)) parts.push(`✅ ${e}`);
					else parts.push(`⏳ ${e}`);
				}
				if (completed.size >= 3) parts.push("🔄 synthesizing");

				onUpdate?.({
					content: [{ type: "text", text: `**Researching...** ${parts.join(" · ")}` }],
					details: { _progress: true },
				} as any);
			};

			try {
				// Run deep research (includes full answers, synthesis, and source fetching)
				const data = await runSearch("all", query, ["--deep-research"], signal, onProgress);
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
				[
					Type.Literal("all"),
					Type.Literal("gemini"),
					Type.Literal("copilot"),
				],
				{
					description: 'Engine to use. "all" runs both Gemini and Copilot in parallel.',
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
					description: "Task mode: code (default), review (code review), plan (architect review), test (write tests), debug (root cause analysis)",
					default: "code",
				},
			),
			context: Type.Optional(Type.String({
				description: "Optional code context/snippet to include with the task",
			})),
		}),
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const { task, engine = "gemini", mode = "code", context } = params as {
				task: string; engine: string; mode: string; context?: string;
			};

			if (!cdpAvailable()) {
				return {
					content: [{ type: "text", text: "cdp.mjs missing — try reinstalling." }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const flags: string[] = ["--engine", engine, "--mode", mode];
			if (context) flags.push("--context", context);

			try {
				onUpdate?.({
					content: [{ type: "text", text: `**Coding task...** 🔄 ${engine === "all" ? "Gemini + Copilot" : engine} (${mode} mode)` }],
					details: { _progress: true },
				} as any);

				const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
					const proc = spawn("node", [__dir + "/coding-task.mjs", task, ...flags], {
						stdio: ["ignore", "pipe", "pipe"],
					});
					let out = "";
					let err = "";

					const onAbort = () => { proc.kill("SIGTERM"); reject(new Error("Aborted")); };
					signal?.addEventListener("abort", onAbort, { once: true });

					proc.stdout.on("data", (d: Buffer) => (out += d));
					proc.stderr.on("data", (d: Buffer) => { err += d; });
					proc.on("close", (code: number) => {
						signal?.removeEventListener("abort", onAbort);
						if (code !== 0) {
							reject(new Error(err.trim() || `coding-task.mjs exited with code ${code}`));
						} else {
							try {
								resolve(JSON.parse(out.trim()));
							} catch {
								reject(new Error(`Invalid JSON from coding-task.mjs: ${out.slice(0, 200)}`));
							}
						}
					});

					// Timeout after 3 minutes
					setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("Coding task timed out after 180s")); }, 180000);
				});

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

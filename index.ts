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

function formatEngineName(engine: string): string {
	if (engine === "bing") return "Bing Copilot";
	if (engine === "google") return "Google AI";
	return engine.charAt(0).toUpperCase() + engine.slice(1);
}

function humanizeSourceType(sourceType: string): string {
	if (!sourceType) return "";
	if (sourceType === "official-docs") return "official docs";
	return sourceType.replace(/-/g, " ");
}

function sourceUrl(source: Record<string, unknown>): string {
	return String(source.displayUrl || source.canonicalUrl || source.url || "");
}

function sourceLabel(source: Record<string, unknown>): string {
	return String(
		source.title || source.domain || sourceUrl(source) || "Untitled source",
	);
}

function sourceConsensus(source: Record<string, unknown>): number {
	if (typeof source.engineCount === "number") return source.engineCount;
	const engines = Array.isArray(source.engines)
		? (source.engines as string[])
		: [];
	return engines.length;
}

function formatAgreementLevel(level: string): string {
	if (!level) return "Mixed";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

function getSourceMap(
	sources: Array<Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
	return new Map(
		sources
			.map((source) => [String(source.id || ""), source] as const)
			.filter(([id]) => id),
	);
}

function formatSourceLine(source: Record<string, unknown>): string {
	const id = String(source.id || "?");
	const url = sourceUrl(source);
	const title = sourceLabel(source);
	const domain = String(source.domain || "");
	const engines = Array.isArray(source.engines)
		? (source.engines as string[])
		: [];
	const consensus = sourceConsensus(source);
	const typeLabel = humanizeSourceType(String(source.sourceType || ""));
	const fetch = source.fetch as Record<string, unknown> | undefined;
	const fetchStatus = fetch?.ok
		? `fetched ${fetch.status || 200}`
		: fetch?.attempted
			? "fetch failed"
			: "";
	const pieces = [
		`${id} - [${title}](${url})`,
		domain,
		typeLabel,
		engines.length
			? `cited by ${engines.map(formatEngineName).join(", ")} (${consensus}/3)`
			: `${consensus}/3`,
		fetchStatus,
	].filter(Boolean);
	return `- ${pieces.join(" - ")}`;
}

function renderSourceEvidence(
	lines: string[],
	source: Record<string, unknown>,
): void {
	const fetch = source.fetch as Record<string, unknown> | undefined;
	if (!fetch?.attempted) return;

	const snippet = String(fetch.snippet || "").trim();
	const lastModified = String(fetch.lastModified || "").trim();
	if (snippet) lines.push(`  Evidence: ${snippet}`);
	if (lastModified) lines.push(`  Last-Modified: ${lastModified}`);
	if (fetch.error) lines.push(`  Fetch error: ${String(fetch.error)}`);
}

function pickSources(
	sources: Array<Record<string, unknown>>,
	recommendedIds: string[] = [],
	max = 6,
): Array<Record<string, unknown>> {
	if (!sources.length) return [];
	const sourceMap = getSourceMap(sources);
	const recommended = recommendedIds
		.map((id) => sourceMap.get(id))
		.filter((source): source is Record<string, unknown> => Boolean(source));
	if (recommended.length > 0) return recommended.slice(0, max);
	return sources.slice(0, max);
}

function renderSynthesis(
	lines: string[],
	synthesis: Record<string, unknown>,
	sources: Array<Record<string, unknown>>,
	maxSources = 6,
): void {
	if (synthesis.answer) {
		lines.push("## Answer");
		lines.push(String(synthesis.answer));
		lines.push("");
	}

	const agreement = synthesis.agreement as Record<string, unknown> | undefined;
	const agreementSummary = String(agreement?.summary || "").trim();
	const agreementLevel = String(agreement?.level || "").trim();
	if (agreementSummary || agreementLevel) {
		lines.push("## Consensus");
		lines.push(
			`- ${formatAgreementLevel(agreementLevel)}${agreementSummary ? ` - ${agreementSummary}` : ""}`,
		);
		lines.push("");
	}

	const differences = Array.isArray(synthesis.differences)
		? (synthesis.differences as string[])
		: [];
	if (differences.length > 0) {
		lines.push("## Where Engines Differ");
		for (const difference of differences) lines.push(`- ${difference}`);
		lines.push("");
	}

	const caveats = Array.isArray(synthesis.caveats)
		? (synthesis.caveats as string[])
		: [];
	if (caveats.length > 0) {
		lines.push("## Caveats");
		for (const caveat of caveats) lines.push(`- ${caveat}`);
		lines.push("");
	}

	const claims = Array.isArray(synthesis.claims)
		? (synthesis.claims as Array<Record<string, unknown>>)
		: [];
	if (claims.length > 0) {
		lines.push("## Key Claims");
		for (const claim of claims) {
			const sourceIds = Array.isArray(claim.sourceIds)
				? (claim.sourceIds as string[])
				: [];
			const support = String(claim.support || "moderate");
			lines.push(
				`- ${String(claim.claim || "")} [${support}${sourceIds.length ? `; ${sourceIds.join(", ")}` : ""}]`,
			);
		}
		lines.push("");
	}

	const recommendedIds = Array.isArray(synthesis.recommendedSources)
		? (synthesis.recommendedSources as string[])
		: [];
	const topSources = pickSources(sources, recommendedIds, maxSources);
	if (topSources.length > 0) {
		lines.push("## Top Sources");
		for (const source of topSources) lines.push(formatSourceLine(source));
		lines.push("");
	}
}

function formatResults(engine: string, data: Record<string, unknown>): string {
	const lines: string[] = [];

	if (engine === "all") {
		const synthesis = data._synthesis as Record<string, unknown> | undefined;
		const dedupedSources = data._sources as
			| Array<Record<string, unknown>>
			| undefined;
		if (synthesis?.answer) {
			renderSynthesis(lines, synthesis, dedupedSources || [], 6);
			lines.push(
				"*Synthesized from Perplexity, Bing Copilot, and Google AI*\n",
			);
			return lines.join("\n").trim();
		}

		for (const [eng, result] of Object.entries(data)) {
			if (eng.startsWith("_")) continue;
			lines.push(`\n## ${formatEngineName(eng)}`);
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
	const dedupedSources = data._sources as
		| Array<Record<string, unknown>>
		| undefined;
	const synthesis = data._synthesis as Record<string, unknown> | undefined;

	lines.push("# Deep Research Report\n");

	if (confidence) {
		const enginesResponded = (confidence.enginesResponded as string[]) || [];
		const enginesFailed = (confidence.enginesFailed as string[]) || [];
		const agreementLevel = String(confidence.agreementLevel || "mixed");
		const firstPartySourceCount = Number(confidence.firstPartySourceCount || 0);
		const sourceTypeBreakdown = confidence.sourceTypeBreakdown as
			| Record<string, number>
			| undefined;

		lines.push("## Confidence\n");
		lines.push(`- Agreement: ${formatAgreementLevel(agreementLevel)}`);
		lines.push(
			`- Engines responded: ${enginesResponded.map(formatEngineName).join(", ") || "none"}`,
		);
		if (enginesFailed.length > 0) {
			lines.push(
				`- Engines failed: ${enginesFailed.map(formatEngineName).join(", ")}`,
			);
		}
		lines.push(
			`- Top source consensus: ${confidence.topSourceConsensus || 0}/3 engines`,
		);
		lines.push(`- Total unique sources: ${confidence.sourcesCount || 0}`);
		lines.push(`- Official sources: ${confidence.officialSourceCount || 0}`);
		lines.push(`- First-party sources: ${firstPartySourceCount}`);
		lines.push(
			`- Fetch success rate: ${confidence.fetchedSourceSuccessRate || 0}`,
		);
		if (sourceTypeBreakdown && Object.keys(sourceTypeBreakdown).length > 0) {
			lines.push(
				`- Source mix: ${Object.entries(sourceTypeBreakdown)
					.map(([type, count]) => `${humanizeSourceType(type)} ${count}`)
					.join(", ")}`,
			);
		}
		lines.push("");
	}

	if (synthesis?.answer)
		renderSynthesis(lines, synthesis, dedupedSources || [], 8);

	lines.push("## Engine Perspectives\n");
	for (const engine of ["perplexity", "bing", "google"]) {
		const r = data[engine] as Record<string, unknown> | undefined;
		if (!r) continue;
		lines.push(`### ${formatEngineName(engine)}`);
		if (r.error) {
			lines.push(`⚠️ Error: ${r.error}`);
		} else if (r.answer) {
			lines.push(String(r.answer).slice(0, 2000));
		}
		lines.push("");
	}

	if (dedupedSources && dedupedSources.length > 0) {
		lines.push("## Source Registry\n");
		for (const source of dedupedSources) {
			lines.push(formatSourceLine(source));
			renderSourceEvidence(lines, source);
		}
		lines.push("");
	}

	return lines.join("\n").trim();
}

function formatCodingTask(
	data: Record<string, unknown> | Record<string, Record<string, unknown>>,
): string {
	const lines: string[] = [];

	// Check if it's multi-engine result
	const hasMultipleEngines = "gemini" in data || "copilot" in data;

	if (hasMultipleEngines) {
		// Multi-engine result
		for (const [engineName, result] of Object.entries(data)) {
			const r = result as Record<string, unknown>;
			lines.push(
				`## ${engineName.charAt(0).toUpperCase() + engineName.slice(1)}\n`,
			);

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
				fullAnswer = false,
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
			if (fullAnswer) flags.push("--full");
			// Map depth to CLI flags
			if (depth === "deep") flags.push("--deep");
			else if (depth === "standard" && engine === "all")
				flags.push("--synthesize");
			// For "fast" depth with "all" engine, we run 3 engines but no synthesis (just pick first result)

			// Track progress for "all" engine mode
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
	// DEPRECATED: Use greedy_search with depth: "deep" instead.
	// Kept for backward compatibility — aliases to greedy_search.
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
				// Delegate to greedy_search with depth: "deep"
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

/**
 * GreedySearch Pi Extension
 *
 * Adds a `greedy_search` tool to Pi that fans out queries to Perplexity,
 * Bing Copilot, and Google AI in parallel, returning synthesized AI answers.
 *
 * Requires Chrome to be running (or it auto-launches a dedicated instance).
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const __dir = dirname(fileURLToPath(import.meta.url));

function cdpAvailable(): boolean {
	return existsSync(join(__dir, "cdp.mjs"));
}

function runSearch(engine: string, query: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const proc = spawn("node", [__dir + "/search.mjs", engine, query], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		proc.stdout.on("data", (d: Buffer) => (out += d));
		proc.stderr.on("data", (d: Buffer) => (err += d));
		proc.on("close", (code: number) => {
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
			"Returns synthesized AI answers with sources. Use for current information, library docs, " +
			"error messages, best practices, or any question where training data may be stale.",
		parameters: Type.Object({
			query: Type.String({ description: "The search query" }),
			engine: Type.Union(
				[
					Type.Literal("all"),
					Type.Literal("perplexity"),
					Type.Literal("bing"),
					Type.Literal("google"),
				],
				{
					description: 'Engine to use. "all" fans out to all three in parallel (default).',
					default: "all",
				},
			),
		}),
		execute: async (_toolCallId, params) => {
			const { query, engine = "all" } = params as { query: string; engine: string };

			if (!cdpAvailable()) {
				return {
					content: [{ type: "text", text: "cdp.mjs missing — try reinstalling: pi install git:github.com/apmantza/GreedySearch-pi" }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			let data: Record<string, unknown>;
			try {
				data = await runSearch(engine, query);
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return {
					content: [{ type: "text", text: `Search failed: ${msg}` }],
					details: {} as { raw?: Record<string, unknown> },
				};
			}

			const text = formatResults(engine, data);
			return {
				content: [{ type: "text", text: text || "No results returned." }],
				details: { raw: data } as { raw?: Record<string, unknown> },
			};
		},
	});
}

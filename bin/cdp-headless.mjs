#!/usr/bin/env node
// cdp-headless.mjs — safe CDP wrapper for headless GreedySearch Chrome only.

import { spawn } from "node:child_process";

const cdpGreedyBin = new URL(
	"./cdp-greedy.mjs",
	import.meta.url,
).pathname.replace(/^\/([A-Z]:)/, "$1");

const proc = spawn(
	process.execPath,
	[cdpGreedyBin, "--mode", "headless", ...process.argv.slice(2)],
	{ stdio: "inherit" },
);
proc.on("close", (code) => process.exit(code ?? 0));

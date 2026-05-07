#!/usr/bin/env node
// cdp-greedy.mjs — safe CDP wrapper for the dedicated GreedySearch Chrome.
//
// This ALWAYS sets CDP_PROFILE_DIR to the GreedySearch profile so it never
// falls back to the user's main Chrome DevToolsActivePort.
//
// Usage:
//   node bin/cdp-greedy.mjs list
//   node bin/cdp-greedy.mjs --mode visible list
//   node bin/cdp-greedy.mjs --mode headless snap <tab>

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const tmp = tmpdir().replaceAll("\\", "/");
const PROFILE_DIR = `${tmp}/greedysearch-chrome-profile`;
const ACTIVE_PORT = `${PROFILE_DIR}/DevToolsActivePort`;
const MODE_FILE = `${tmp}/greedysearch-chrome-mode`;

const args = process.argv.slice(2);
let desiredMode = null;
const modeIdx = args.indexOf("--mode");
if (modeIdx !== -1) {
	desiredMode = args[modeIdx + 1] || null;
	args.splice(modeIdx, 2);
}

if (desiredMode && !["visible", "headless"].includes(desiredMode)) {
	console.error(`Invalid --mode ${desiredMode}. Use visible or headless.`);
	process.exit(2);
}

if (!existsSync(ACTIVE_PORT)) {
	console.error(
		`GreedySearch Chrome is not running (missing ${ACTIVE_PORT}). Launch with bin/visible.mjs or bin/launch.mjs.`,
	);
	process.exit(1);
}

if (desiredMode) {
	const actualMode = existsSync(MODE_FILE)
		? readFileSync(MODE_FILE, "utf8").trim()
		: "unknown";
	if (actualMode !== desiredMode) {
		console.error(
			`GreedySearch Chrome is ${actualMode}, not ${desiredMode}. Refusing to attach.`,
		);
		process.exit(1);
	}
}

const cdpBin = new URL("./cdp.mjs", import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	"$1",
);

const proc = spawn(process.execPath, [cdpBin, ...args], {
	stdio: "inherit",
	env: { ...process.env, CDP_PROFILE_DIR: PROFILE_DIR },
});
proc.on("close", (code) => process.exit(code ?? 0));

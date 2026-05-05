#!/usr/bin/env node
// visible.mjs — launch GreedySearch Chrome in visible mode (no headless)
//
// Usage:
//   node bin/visible.mjs              — kill headless, launch visible Chrome
//   node bin/visible.mjs --kill       — stop any GreedySearch Chrome
//   node bin/visible.mjs --status     — check if running
//
// Use this when engines get blocked by bot detection and you need
// to solve a CAPTCHA or establish cookies manually.

import { spawn } from "node:child_process";

const launchBin = new URL("./launch.mjs", import.meta.url).pathname.replace(
	/^\/([A-Z]:)/,
	"$1",
);

const flag = process.argv[2] || "";

if (flag === "--kill") {
	const proc = spawn(process.execPath, [launchBin, "--kill"], {
		stdio: "inherit",
	});
	proc.on("close", (code) => {
		if (code === 0) console.log("✅ Chrome killed.");
		process.exit(code ?? 0);
	});
} else if (flag === "--status") {
	const proc = spawn(process.execPath, [launchBin, "--status"], {
		stdio: "inherit",
	});
	proc.on("close", (code) => process.exit(code ?? 0));
} else {
	// Kill any existing headless Chrome, then launch visible
	console.log("🔄 Killing headless Chrome (if running)...");
	await new Promise((resolve) => {
		const killProc = spawn(process.execPath, [launchBin, "--kill"], {
			stdio: "inherit",
		});
		killProc.on("close", resolve);
	});

	console.log("🚀 Launching visible Chrome...");
	const proc = spawn(process.execPath, [launchBin], {
		stdio: "inherit",
		env: { ...process.env, GREEDY_SEARCH_VISIBLE: "1" },
	});
	proc.on("close", (code) => process.exit(code ?? 0));
}

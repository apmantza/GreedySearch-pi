#!/usr/bin/env node
// kill-visible.mjs — force-stop any visible GreedySearch Chrome on port 9222.
// Uses launch-visible.mjs because it has the strongest PID + port cleanup path.

import { spawn } from "node:child_process";

const launchVisibleBin = new URL(
	"./launch-visible.mjs",
	import.meta.url,
).pathname.replace(/^\/([A-Z]:)/, "$1");

const proc = spawn(process.execPath, [launchVisibleBin, "--kill"], {
	stdio: "inherit",
});
proc.on("close", (code) => process.exit(code ?? 0));

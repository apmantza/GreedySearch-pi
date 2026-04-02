#!/usr/bin/env node
// launch.mjs — start a dedicated Chrome instance for GreedySearch
//
// This Chrome instance uses --disable-features=DevToolsPrivacyUI which suppresses
// the "Allow remote debugging?" dialog entirely. It runs on port 9222 so it doesn't
// conflict with your main Chrome session (which may use port 9223).
//
// search.mjs passes CDP_PROFILE_DIR so cdp.mjs targets this dedicated Chrome
// without ever touching the user's main Chrome DevToolsActivePort file.
//
// Usage:
//   node launch.mjs          — launch (or report if already running)
//   node launch.mjs --kill   — stop and restore original DevToolsActivePort
//   node launch.mjs --status — check if running

import { execSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9222;
const PROFILE_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const ACTIVE_PORT = join(PROFILE_DIR, "DevToolsActivePort");
const PID_FILE = join(tmpdir(), "greedysearch-chrome.pid");

function findChrome() {
	const os = platform();
	const candidates =
		os === "win32"
			? [
					"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
					"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
				]
			: os === "darwin"
				? [
						"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
						"/Applications/Chromium.app/Contents/MacOS/Chromium",
					]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium-browser",
						"/usr/bin/chromium",
						"/snap/bin/chromium",
					];
	return candidates.find(existsSync) || null;
}

const CHROME_FLAGS = [
	`--remote-debugging-port=${PORT}`,
	"--disable-features=DevToolsPrivacyUI", // suppresses "Allow remote debugging?" dialog
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-default-apps",
	`--user-data-dir=${PROFILE_DIR}`,
	"--profile-directory=Default",
	"about:blank",
];

// ---------------------------------------------------------------------------

function isRunning() {
	if (!existsSync(PID_FILE)) return false;
	const pid = parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return false;
	}
}

// Get the PID of the process listening on a port (Windows + Unix)
function getPortPid(port) {
	try {
		const os = platform();
		if (os === "win32") {
			// Windows: netstat -ano returns PID in last column
			const out = execSync(`netstat -ano -p TCP 2>nul`, { encoding: "utf8" });
			// Match lines like: TCP    127.0.0.1:9222    0.0.0.0:0    LISTENING    12345
			const regex = new RegExp(
				`TCP\\s+[^\\s]*:${port}\\s+[^\\s]*:0\\s+LISTENING\\s+(\\d+)`,
				"i",
			);
			const match = out.match(regex);
			return match ? parseInt(match[1], 10) : null;
		} else {
			// Unix: use lsof or ss
			try {
				const out = execSync(`lsof -i :${port} -t 2>/dev/null`, {
					encoding: "utf8",
				}).trim();
				return out ? parseInt(out.split("\n")[0], 10) : null;
			} catch {
				const out = execSync(`ss -tlnp 2>/dev/null | grep :${port}`, {
					encoding: "utf8",
				});
				const match = out.match(/pid=(\d+)/);
				return match ? parseInt(match[1], 10) : null;
			}
		}
	} catch {
		return null;
	}
}

// Kill a process by PID (with Windows/Unix compatibility)
function killProcess(pid) {
	try {
		if (platform() === "win32") {
			execSync(`taskkill //F //PID ${pid}`, { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGTERM");
		}
		return true;
	} catch {
		return false;
	}
}

// Clean up ghost Chrome on port 9222 that isn't tracked by our PID file
function cleanupGhostChrome() {
	const portPid = getPortPid(PORT);
	if (!portPid) return; // Nothing on port 9222, all good

	const trackedPid = isRunning();

	if (trackedPid && portPid === trackedPid) {
		return; // Port 9222 is our Chrome, all good
	}

	// Ghost Chrome detected — something on 9222 that isn't ours
	if (trackedPid && portPid !== trackedPid) {
		console.log(
			`Ghost Chrome detected: port ${PORT} has pid ${portPid}, but our PID file says ${trackedPid}.`,
		);
	} else if (!trackedPid) {
		console.log(
			`Ghost Chrome detected: unknown process ${portPid} on port ${PORT} (no PID file).`,
		);
	}

	console.log(`Killing ghost Chrome (pid ${portPid})...`);
	killProcess(portPid);

	// Clean up stale files
	try {
		unlinkSync(PID_FILE);
	} catch {}
	try {
		unlinkSync(ACTIVE_PORT);
	} catch {}
	console.log("Cleaned up stale Chrome files.");
}

function httpGet(url, timeoutMs = 1000) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => resolve({ ok: res.statusCode === 200, body }));
		});
		req.on("error", () => resolve({ ok: false }));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve({ ok: false });
		});
	});
}

async function writePortFile(timeoutMs = 15000) {
	// Chrome on Windows doesn't write DevToolsActivePort — we build it from the HTTP API.
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { ok, body } = await httpGet(
			`http://localhost:${PORT}/json/version`,
			1500,
		);
		if (ok) {
			try {
				const { webSocketDebuggerUrl } = JSON.parse(body);
				// webSocketDebuggerUrl = "ws://localhost:9223/devtools/browser/..."
				const wsPath = new URL(webSocketDebuggerUrl).pathname;
				// Write in DevToolsActivePort format: port on line 1, path on line 2
				const content = `${PORT}\n${wsPath}`;
				writeFileSync(ACTIVE_PORT, content, "utf8");
				return true;
			} catch {
				/* malformed response, retry */
			}
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

// ---------------------------------------------------------------------------

async function main() {
	const arg = process.argv[2];

	// Clean up any ghost Chrome on port 9222 before doing anything else
	cleanupGhostChrome();

	if (arg === "--kill") {
		const pid = isRunning();
		if (pid) {
			const ok = killProcess(pid);
			if (ok) console.log(`Stopped Chrome (pid ${pid}).`);
			else console.error(`Failed to stop pid ${pid}.`);
		} else {
			console.log("GreedySearch Chrome is not running.");
		}
		return;
	}

	if (arg === "--status") {
		const pid = isRunning();
		if (pid)
			console.log(
				`Running — pid ${pid}, port ${PORT}, DevToolsActivePort redirected.`,
			);
		else console.log("Not running.");
		return;
	}

	// Already running?
	const existing = isRunning();
	if (existing) {
		const ready = await writePortFile(5000);
		if (ready) {
			console.log(
				`GreedySearch Chrome already running (pid ${existing}, port ${PORT}).`,
			);
			console.log("Dedicated GreedySearch DevToolsActivePort is ready.");
			return;
		}
		// Stale PID — process alive but not Chrome on port 9223. Fall through to fresh launch.
		console.log(
			`Stale PID ${existing} detected (not Chrome on port ${PORT}) — launching fresh.`,
		);
		try {
			unlinkSync(PID_FILE);
		} catch {}
	}

	const CHROME_EXE = process.env.CHROME_PATH || findChrome();
	if (!CHROME_EXE) {
		console.error("Chrome not found. Tried standard paths for your OS.");
		console.error(
			"Set the CHROME_PATH environment variable to point to your Chrome binary.",
		);
		process.exit(1);
	}

	mkdirSync(PROFILE_DIR, { recursive: true });

	console.log(`Launching GreedySearch Chrome on port ${PORT}...`);
	const proc = spawn(CHROME_EXE, CHROME_FLAGS, {
		detached: true,
		stdio: "ignore",
		windowsHide: false,
	});
	proc.unref();
	writeFileSync(PID_FILE, String(proc.pid));

	// Wait for Chrome HTTP endpoint and build the dedicated DevToolsActivePort file
	const portFileReady = await writePortFile();
	if (!portFileReady) {
		console.error("Chrome did not become ready within 15s.");
		process.exit(1);
	}

	console.log(`Ready. No more "Allow remote debugging?" dialogs.`);
	console.log(
		"GreedySearch now uses its own isolated DevToolsActivePort file.",
	);
}

main();

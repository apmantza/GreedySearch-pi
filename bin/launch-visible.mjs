#!/usr/bin/env node
// launch-visible.mjs — launch GreedySearch Chrome in VISIBLE mode (window shown).
// No headless, no mode switching, no ghost cleanup complexity.
//
// Usage:
//   node bin/launch-visible.mjs          — launch visible Chrome
//   node bin/launch-visible.mjs --kill   — stop Chrome
//   node bin/launch-visible.mjs --status — check if running

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
const MODE_FILE = join(tmpdir(), "greedysearch-chrome-mode");

// ─── Helpers ──────────────────────────────────────────────────────

function findChrome() {
	const os = platform();
	const candidates =
		os === "win32"
			? [
					"C:/Program Files/Google/Chrome/Application/chrome.exe",
					"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
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
					];
	return candidates.find(existsSync) || null;
}

function isRunning() {
	if (!existsSync(PID_FILE)) return false;
	const pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10);
	if (!pid) return false;
	try {
		process.kill(pid, 0);
		return pid;
	} catch {
		return false;
	}
}

function getPortPid(port) {
	try {
		const os = platform();
		if (os === "win32") {
			const out = execSync(`netstat -ano -p TCP 2>nul`, { encoding: "utf8" });
			const regex = new RegExp(
				String.raw`TCP\s+[^\s]*:${port}\s+[^\s]*:0\s+LISTENING\s+(\d+)`,
				"i",
			);
			const match = out.match(regex);
			return match ? Number.parseInt(match[1], 10) : null;
		}
	} catch {
		return null;
	}
}

function killProcess(pid) {
	try {
		if (platform() === "win32") {
			execSync(`taskkill /F /PID ${pid} /T`, { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGKILL");
		}
		return true;
	} catch {
		return false;
	}
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

async function waitForPort(timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const { ok, body } = await httpGet(
			`http://localhost:${PORT}/json/version`,
			1500,
		);
		if (ok) {
			try {
				const { webSocketDebuggerUrl } = JSON.parse(body);
				const wsPath = new URL(webSocketDebuggerUrl).pathname;
				writeFileSync(ACTIVE_PORT, `${PORT}\n${wsPath}`, "utf8");
				return true;
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

// ─── Nuke any Chrome holding port 9222 ────────────────────────────

function nukePort() {
	// Kill by PID file
	const pid = isRunning();
	if (pid) killProcess(pid);

	// Kill by port (ghost)
	const portPid = getPortPid(PORT);
	if (portPid && portPid !== pid) killProcess(portPid);

	// Clean up files
	try {
		unlinkSync(PID_FILE);
	} catch {}
	try {
		unlinkSync(ACTIVE_PORT);
	} catch {}
	try {
		unlinkSync(MODE_FILE);
	} catch {}

	// Wait for port to free
	return new Promise((resolve) => {
		const start = Date.now();
		const check = () => {
			const p = getPortPid(PORT);
			if (!p) return resolve(true);
			if (Date.now() - start > 5000) return resolve(false);
			killProcess(p);
			setTimeout(check, 500);
		};
		check();
	});
}

// ─── Main ─────────────────────────────────────────────────────────

async function main() {
	const arg = process.argv[2];

	if (arg === "--kill") {
		await nukePort();
		console.log("Chrome stopped.");
		return;
	}

	if (arg === "--status") {
		const pid = isRunning() || getPortPid(PORT);
		if (pid) {
			console.log(`Running — pid ${pid}, port ${PORT}`);
		} else {
			console.log("Not running.");
		}
		return;
	}

	// Nuke anything on the port before launching
	console.log("Stopping any existing Chrome on port 9222...");
	await nukePort();

	const CHROME_EXE = process.env.CHROME_PATH || findChrome();
	if (!CHROME_EXE) {
		console.error("Chrome not found. Set CHROME_PATH env var.");
		process.exit(1);
	}

	mkdirSync(PROFILE_DIR, { recursive: true });

	// Visible-only flags — NO --headless
	const flags = [
		`--remote-debugging-port=${PORT}`,
		"--disable-features=DevToolsPrivacyUI",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-default-apps",
		`--user-data-dir=${PROFILE_DIR}`,
		"--profile-directory=Default",
		"--new-window",
		"about:blank",
	];

	console.log("Launching visible Chrome...");
	const proc = spawn(CHROME_EXE, flags, {
		detached: true,
		stdio: "ignore",
	});
	proc.unref();

	const chromePid = proc.pid;
	writeFileSync(PID_FILE, String(chromePid));
	writeFileSync(MODE_FILE, "visible", "utf8");
	console.log(`Chrome PID: ${chromePid}`);

	const ready = await waitForPort();
	if (!ready) {
		console.error("Chrome did not become ready within 15s.");
		process.exit(1);
	}

	console.log("Visible Chrome ready on port 9222.");
	console.log("Keep this terminal open to keep Chrome alive.");
}

main();

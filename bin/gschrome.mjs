#!/usr/bin/env node
// bin/gschrome.mjs — GreedySearch Chrome lifecycle manager
//
// Usage:
//   node bin/gschrome.mjs launch-headless   Start headless Chrome (port 9222)
//   node bin/gschrome.mjs launch-visible    Start visible Chrome (port 9222)
//   node bin/gschrome.mjs kill              Kill Chrome on port 9222
//   node bin/gschrome.mjs status            Show running status
//
// A single Chrome instance on port 9222 is either headless OR visible.
// The mode marker file determines which.
// Profile (cookies, cache) at %TMP%/greedysearch-chrome-profile is shared.

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

const TMP = tmpdir().replaceAll("\\", "/");
const PORT = 9222;
const PROFILE_DIR = join(tmpdir(), "greedysearch-chrome-profile");
const PID_FILE = `${TMP}/greedysearch-chrome.pid`;
const MODE_FILE = `${TMP}/greedysearch-chrome-mode`;

// ─── Helpers ──────────────────────────────────────────────────────────────

function findChrome() {
	const os = platform();
	const candidates =
		os === "win32"
			? [
					"C:/Program Files/Google/Chrome/Application/chrome.exe",
					"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
				]
			: os === "darwin"
				? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
				: [
						"/usr/bin/google-chrome",
						"/usr/bin/google-chrome-stable",
						"/usr/bin/chromium-browser",
						"/usr/bin/chromium",
					];
	return candidates.find(existsSync) || null;
}

function probe() {
	return new Promise((resolve) => {
		const req = http.get(`http://localhost:${PORT}/json/version`, (res) => {
			let b = "";
			res.on("data", (d) => (b += d));
			res.on("end", () => resolve({ ok: true, body: b }));
		});
		req.on("error", () => resolve({ ok: false }));
		req.setTimeout(2000, () => {
			req.destroy();
			resolve({ ok: false });
		});
	});
}

function getPortPid(port) {
	try {
		if (platform() === "win32") {
			const out = execSync(`netstat -ano -p TCP 2>nul`, { encoding: "utf8" });
			const re = new RegExp(
				String.raw`TCP\s+\S+:${port}\s+\S+:0\s+LISTENING\s+(\d+)`,
				"i",
			);
			return (out.match(re) || [])[1] ? parseInt(out.match(re)[1]) : null;
		}
		const out = execSync(
			`lsof -i :${port} -t 2>/dev/null || ss -tlnp 2>/dev/null | grep :${port} | grep -oP 'pid=\\K\\d+'`,
			{ encoding: "utf8" },
		).trim();
		return out ? parseInt(out.split("\n")[0]) : null;
	} catch {
		return null;
	}
}

function forceKillPort() {
	const pid = getPortPid(PORT);
	if (!pid) return false;
	try {
		if (platform() === "win32")
			execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
		else process.kill(pid, "SIGKILL");
		return true;
	} catch {
		return false;
	}
}

function cleanup() {
	for (const f of [PID_FILE, MODE_FILE]) {
		try {
			unlinkSync(f);
		} catch {}
	}
}

// ─── Commands ─────────────────────────────────────────────────────────────

async function cmdStatus() {
	const { ok, body } = await probe();
	if (!ok) {
		console.log("Not running.");
		return;
	}
	const mode = existsSync(MODE_FILE)
		? readFileSync(MODE_FILE, "utf8").trim()
		: "unknown";
	const trackedPid = existsSync(PID_FILE)
		? readFileSync(PID_FILE, "utf8").trim()
		: "none";
	const actualPid = getPortPid(PORT) || "unknown";
	const { Browser } = JSON.parse(body);
	console.log(`Running: ${Browser}`);
	console.log(`  Mode:      ${mode}`);
	console.log(`  Port:      ${PORT}`);
	console.log(`  PID file:  ${trackedPid}`);
	console.log(`  PID actual:${actualPid}`);
}

async function cmdKill() {
	const { ok } = await probe();
	if (!ok) {
		console.log("Not running — nothing to kill.");
		cleanup();
		return;
	}
	console.log("Killing Chrome on port 9222...");
	forceKillPort();
	cleanup();
	await new Promise((r) => setTimeout(r, 1500));
	// Verify dead
	const { ok: still } = await probe();
	console.log(still ? "FAILED — still running." : "Killed.");
}

async function cmdLaunch(mode) {
	const { ok } = await probe();
	if (ok) {
		const currentMode = existsSync(MODE_FILE)
			? readFileSync(MODE_FILE, "utf8").trim()
			: "unknown";
		if (currentMode === mode) {
			console.log(`Already running in ${mode} mode.`);
			return;
		}
		console.log(
			`${currentMode} Chrome running — killing to switch to ${mode}...`,
		);
		forceKillPort();
		cleanup();
		await new Promise((r) => setTimeout(r, 1500));
	}

	const chromeExe = process.env.CHROME_PATH || findChrome();
	if (!chromeExe) {
		console.error("Chrome not found.");
		process.exit(1);
	}

	const isHeadless = mode === "headless";
	const flags = [
		`--remote-debugging-port=${PORT}`,
		"--disable-features=DevToolsPrivacyUI",
		"--no-first-run",
		"--no-default-browser-check",
		"--disable-default-apps",
		"--disable-blink-features=AutomationControlled",
		"--window-size=1920,1080",
		`--user-data-dir=${PROFILE_DIR}`,
		"--profile-directory=Default",
	];

	if (isHeadless) {
		flags.push(
			"--headless=new",
			"--disable-gpu",
			"--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		);
		if (platform() === "win32") flags.push("--disable-software-rasterizer");
	}
	flags.push("about:blank");

	mkdirSync(PROFILE_DIR, { recursive: true });
	console.log(`Launching ${mode} Chrome on port ${PORT}...`);

	const proc = spawn(chromeExe, flags, { detached: true, stdio: "ignore" });
	proc.unref();
	writeFileSync(PID_FILE, String(proc.pid));
	writeFileSync(MODE_FILE, mode);

	// Wait for ready
	for (let i = 0; i < 30; i++) {
		await new Promise((r) => setTimeout(r, 500));
		const { ok: ready } = await probe();
		if (ready) {
			// Write DevToolsActivePort
			try {
				const { body } = await probe();
				const { webSocketDebuggerUrl } = JSON.parse(body);
				const wsPath = new URL(webSocketDebuggerUrl).pathname;
				writeFileSync(
					`${PROFILE_DIR}/DevToolsActivePort`,
					`${PORT}\n${wsPath}`,
				);
			} catch {}
			console.log("Ready.");
			return;
		}
	}
	console.error("Timeout — Chrome did not become ready.");
	process.exit(1);
}

// ─── CLI ──────────────────────────────────────────────────────────────────

const cmd = process.argv[2];
switch (cmd) {
	case "launch-headless":
		await cmdLaunch("headless");
		break;
	case "launch-visible":
		await cmdLaunch("visible");
		break;
	case "kill":
		await cmdKill();
		break;
	case "status":
		await cmdStatus();
		break;
	default:
		console.log(`Usage: node bin/gschrome.mjs <command>

Commands:
  launch-headless   Start headless Chrome on port 9222
  launch-visible    Start visible Chrome on port 9222
  kill              Kill Chrome on port 9222 (headless or visible)
  status            Show running status
`);
		process.exit(1);
}

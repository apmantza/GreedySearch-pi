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
//   node launch.mjs --headless — launch in headless mode (no GUI window)
//   node launch.mjs --kill   — stop and restore original DevToolsActivePort
//   node launch.mjs --status — check if running
//
// Environment:
//   GREEDY_SEARCH_VISIBLE=1  — Show Chrome window (disables headless mode)
//   CHROME_PATH              — Path to Chrome executable

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
						"/snap/bin/chromium",
					];
	return candidates.find(existsSync) || null;
}

const isHeadless = () => process.env.GREEDY_SEARCH_VISIBLE !== "1";

const BASE_CHROME_FLAGS = [
	`--remote-debugging-port=${PORT}`,
	"--disable-features=DevToolsPrivacyUI",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-default-apps",
	`--user-data-dir=${PROFILE_DIR}`,
	"--profile-directory=Default",
];

function buildChromeFlags() {
	const flags = [...BASE_CHROME_FLAGS];
	if (isHeadless()) {
		flags.push("--headless=new");
		flags.push("--disable-gpu");
		flags.push("--disable-blink-features=AutomationControlled");
		flags.push("--window-size=1920,1080");
		flags.push(
			"--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
		);
		if (platform() === "win32") flags.push("--disable-software-rasterizer");
	}
	flags.push("about:blank");
	return flags;
}

const isVisible = () => process.env.GREEDY_SEARCH_VISIBLE === "1";

/** Check if the running Chrome was launched headless from the mode marker file */
function isModeFileHeadless() {
	try {
		if (!existsSync(MODE_FILE)) return true; // default: assume headless
		return readFileSync(MODE_FILE, "utf8").trim() === "headless";
	} catch {
		return true;
	}
}

// ---------------------------------------------------------------------------
// CDP Window Minimization
// ---------------------------------------------------------------------------

async function minimizeViaCDP() {
	if (isVisible()) return;

	// Wait for Chrome to be ready
	await new Promise((r) => setTimeout(r, 1000));

	try {
		// Get browser WebSocket URL
		const version = await new Promise((resolve, reject) => {
			http
				.get(`http://localhost:${PORT}/json/version`, (res) => {
					let body = "";
					res.on("data", (d) => (body += d));
					res.on("end", () => resolve(JSON.parse(body)));
				})
				.on("error", reject);
		});

		const wsUrl = version.webSocketDebuggerUrl;

		const WebSocket = globalThis.WebSocket;
		if (!WebSocket) return;

		const ws = new WebSocket(wsUrl);
		let requestId = 0;
		const pending = new Map();

		ws.onopen = () => {
			// Step 1: Get targets
			const id = ++requestId;
			pending.set(id, {
				resolve: (result) => {
					const targets = result.targetInfos || [];
					const pageTarget = targets.find((t) => t.type === "page");
					if (!pageTarget) {
						ws.close();
						return;
					}

					// Step 2: Get windowId for target
					const winId = ++requestId;
					pending.set(winId, {
						resolve: (winResult) => {
							const windowId = winResult.windowId;
							// Step 3: Minimize window
							const minId = ++requestId;
							pending.set(minId, { resolve: () => {}, reject: () => {} });
							ws.send(
								JSON.stringify({
									id: minId,
									method: "Browser.setWindowBounds",
									params: { windowId, bounds: { windowState: "minimized" } },
								}),
							);
							setTimeout(() => ws.close(), 500);
						},
						reject: () => ws.close(),
					});
					ws.send(
						JSON.stringify({
							id: winId,
							method: "Browser.getWindowForTarget",
							params: { targetId: pageTarget.targetId },
						}),
					);
				},
				reject: () => ws.close(),
			});
			ws.send(JSON.stringify({ id, method: "Target.getTargets", params: {} }));
		};

		ws.onmessage = (event) => {
			const msg = JSON.parse(event.data);
			if (msg.id && pending.has(msg.id)) {
				const { resolve, reject } = pending.get(msg.id);
				pending.delete(msg.id);
				if (msg.error) reject?.(msg.error);
				else resolve?.(msg.result);
			}
		};

		setTimeout(() => ws.close(), 5000);
	} catch {
		// Best-effort
	}
}

// ---------------------------------------------------------------------------
// Chrome process management
// ---------------------------------------------------------------------------

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
		const out = execSync(
			String.raw`lsof -i :${port} -t 2>/dev/null || ss -tlnp 2>/dev/null | grep :${port} | grep -oP 'pid=\K\d+'`,
			{
				encoding: "utf8",
			},
		).trim();
		return out ? Number.parseInt(out.split("\n")[0], 10) : null;
	} catch {
		return null;
	}
}

function killProcess(pid) {
	try {
		if (platform() === "win32") {
			execSync(`taskkill //F //T //PID ${pid}`, { stdio: "ignore" });
		} else {
			process.kill(pid, "SIGTERM");
		}
		return true;
	} catch {
		return false;
	}
}

function cleanupGhostChrome() {
	const portPid = getPortPid(PORT);
	if (!portPid) return;

	const trackedPid = isRunning();
	if (trackedPid && portPid === trackedPid) return;

	console.log(`Ghost Chrome on port ${PORT} (pid ${portPid}) — cleaning up...`);
	killProcess(portPid);
	try {
		unlinkSync(PID_FILE);
	} catch {}
	try {
		unlinkSync(ACTIVE_PORT);
	} catch {}
	try {
		unlinkSync(MODE_FILE);
	} catch {}
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
			} catch {
				/* ignore */
			}
		}
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const arg = process.argv[2];

	cleanupGhostChrome();

	if (arg === "--kill") {
		const pid = isRunning();
		if (pid) {
			const ok = killProcess(pid);
			console.log(
				ok ? `Stopped Chrome (pid ${pid}).` : `Failed to stop pid ${pid}.`,
			);
		} else {
			console.log("GreedySearch Chrome is not running.");
		}
		// Clean up mode marker
		try {
			unlinkSync(MODE_FILE);
		} catch {}
		return;
	}

	if (arg === "--status") {
		const pid = isRunning();
		if (pid) {
			console.log(`Running — pid ${pid}, port ${PORT}`);
		} else {
			console.log("Not running.");
		}
		return;
	}

	const existing = isRunning();
	if (existing) {
		// Mode check: if caller wants visible but Chrome is headless, kill and relaunch
		const isWantingVisible =
			process.env.GREEDY_SEARCH_VISIBLE === "1" &&
			!process.argv.includes("--headless");
		if (isWantingVisible && isModeFileHeadless()) {
			console.log(
				`Headless Chrome running (pid ${existing}) but visible requested — killing...`,
			);
			killProcess(existing);
			try {
				unlinkSync(PID_FILE);
			} catch {}
			try {
				unlinkSync(MODE_FILE);
			} catch {}
			// Fall through to fresh launch below
		} else {
			const ready = await writePortFile(5000);
			if (ready) {
				console.log(`GreedySearch Chrome already running (pid ${existing}).`);
				return;
			}
			console.log(`Stale PID ${existing} — launching fresh.`);
			try {
				unlinkSync(PID_FILE);
			} catch {}
		}
	}

	const CHROME_EXE = process.env.CHROME_PATH || findChrome();
	if (!CHROME_EXE) {
		console.error("Chrome not found. Set CHROME_PATH env var.");
		process.exit(1);
	}

	mkdirSync(PROFILE_DIR, { recursive: true });

	console.log(`Launching GreedySearch Chrome on port ${PORT}...`);
	if (isHeadless()) {
		console.log("Headless mode — no window will be shown");
	} else if (!isVisible()) {
		console.log("Window will be minimized");
	}

	const proc = spawn(CHROME_EXE, buildChromeFlags(), {
		detached: true,
		stdio: "ignore",
	});
	proc.unref();
	writeFileSync(PID_FILE, String(proc.pid));
	// Write mode marker so ensureChrome() can detect headless vs visible
	writeFileSync(MODE_FILE, isHeadless() ? "headless" : "visible", "utf8");

	const portFileReady = await writePortFile();
	if (!portFileReady) {
		console.error("Chrome did not become ready within 15s.");
		process.exit(1);
	}

	if (isHeadless()) {
		// No window to minimize in headless mode
		console.log("Ready (headless).");
	} else {
		// Minimize window via CDP
		await minimizeViaCDP();
		console.log("Ready.");
	}
}

main();

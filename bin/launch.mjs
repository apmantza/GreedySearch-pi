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
//
// Environment:
//   GREEDY_SEARCH_VISIBLE=1  — Show Chrome window instead of minimizing
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

const CHROME_FLAGS = [
	`--remote-debugging-port=${PORT}`,
	"--disable-features=DevToolsPrivacyUI",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-default-apps",
	`--user-data-dir=${PROFILE_DIR}`,
	"--profile-directory=Default",
	"about:blank",
];

const isVisible = () => process.env.GREEDY_SEARCH_VISIBLE === "1";

// ---------------------------------------------------------------------------
// CDP Window Minimization
// ---------------------------------------------------------------------------

async function minimizeViaCDP() {
	if (isVisible()) return;
	console.log("[minimize] Starting...");

	// Wait for Chrome to be ready
	await new Promise((r) => setTimeout(r, 1000));

	try {
		// Get browser WebSocket URL
		console.log("[minimize] Getting version info...");
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
		console.log("[minimize] WebSocket URL received");

		const WebSocket = globalThis.WebSocket;
		if (!WebSocket) {
			console.log("[minimize] WebSocket not available");
			return;
		}

		const ws = new WebSocket(wsUrl);
		let requestId = 0;
		const pending = new Map();

		ws.onopen = () => {
			console.log("[minimize] Connected, getting targets...");
			// Step 1: Get targets
			const id = ++requestId;
			pending.set(id, {
				resolve: (result) => {
					const targets = result.targetInfos || [];
					console.log(`[minimize] Found ${targets.length} targets`);
					const pageTarget = targets.find((t) => t.type === "page");
					if (!pageTarget) {
						console.log("[minimize] No page target, closing");
						ws.close();
						return;
					}

					console.log(`[minimize] Using target: ${pageTarget.targetId}`);
					// Step 2: Get windowId for target
					const winId = ++requestId;
					pending.set(winId, {
						resolve: (winResult) => {
							const windowId = winResult.windowId;
							console.log(
								`[minimize] Got windowId: ${windowId}, minimizing...`,
							);
							// Step 3: Minimize window
							const minId = ++requestId;
							pending.set(minId, {
								resolve: () =>
									console.log("[minimize] Window minimized successfully"),
								reject: (err) =>
									console.log("[minimize] Minimize failed:", err),
							});
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
			execSync(`taskkill //F //PID ${pid}`, { stdio: "ignore" });
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

	const CHROME_EXE = process.env.CHROME_PATH || findChrome();
	if (!CHROME_EXE) {
		console.error("Chrome not found. Set CHROME_PATH env var.");
		process.exit(1);
	}

	mkdirSync(PROFILE_DIR, { recursive: true });

	console.log(`Launching GreedySearch Chrome on port ${PORT}...`);
	if (!isVisible()) {
		console.log("Window will be minimized");
	}

	const proc = spawn(CHROME_EXE, CHROME_FLAGS, {
		detached: true,
		stdio: "ignore",
	});
	proc.unref();
	writeFileSync(PID_FILE, String(proc.pid));

	const portFileReady = await writePortFile();
	if (!portFileReady) {
		console.error("Chrome did not become ready within 15s.");
		process.exit(1);
	}

	// Minimize window via CDP
	await minimizeViaCDP();

	console.log("Ready.");
}

main();

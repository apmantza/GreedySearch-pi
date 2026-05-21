// src/search/chrome.mjs — Chrome launch, probe, port file management, and CDP wrapper
//
// Extracted from search.mjs to reduce file complexity.
//
// cdp() is re-exported from extractors/common.mjs to avoid duplication.
//
// Idle timeout: mode-specific — headless Chrome is auto-killed after
// GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES (default 5). Visible Chrome (explicitly
// launched for captcha/cookie setup) uses GREEDY_SEARCH_VISIBLE_IDLE_TIMEOUT_MINUTES
// (default 60) because restarting it wastes the user's investment in solving captchas.
// Set either to 0 to disable idle cleanup for that mode.

import { spawn, execSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import {
	cdp as _cdp,
	injectHeadlessStealth,
} from "../../extractors/common.mjs";
import { resolveSystemCmd } from "../utils/system-cmds.mjs";
import {
	ACTIVE_PORT_FILE,
	CHROME_MODE_FILE,
	GREEDY_PORT,
	PAGES_CACHE,
} from "./constants.mjs";
import {
	readMetadata,
	touchActivity as touchActivityBL,
	acquireLaunchLock,
	cleanupStaleSessions,
	registerClient,
} from "./browser-lifecycle.mjs";

const __dir =
	import.meta.dirname ||
	new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

// ─── Mode-specific idle timeouts ─────────────────────────────────────
// Headless: cheap to restart, aggressive cleanup after short idle.
// Visible: user invested time in captcha/cookies — long grace period.

const _tmp = tmpdir().replaceAll("\\", "/");
const PID_FILE = `${_tmp}/greedysearch-chrome.pid`;
const ACTIVITY_FILE = `${_tmp}/greedysearch-chrome-last-activity`;

/** Headless idle timeout (default 5 min). Set to 0 to disable. */
const HEADLESS_IDLE_TIMEOUT_MINUTES =
	Number.parseInt(process.env.GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES || "5", 10) ||
	5;

/** Visible idle timeout (default 60 min). Much longer — captcha/cookie investment. */
const VISIBLE_IDLE_TIMEOUT_MINUTES =
	Number.parseInt(
		process.env.GREEDY_SEARCH_VISIBLE_IDLE_TIMEOUT_MINUTES || "60",
		10,
	) || 60;

/** Check if the running Chrome was launched in headless mode */
export function isChromeHeadless() {
	try {
		if (!existsSync(CHROME_MODE_FILE)) return true; // default: headless
		return readFileSync(CHROME_MODE_FILE, "utf8").trim() === "headless";
	} catch {
		return true;
	}
}

/** Record that Chrome was just used / is active right now */
export function touchActivity() {
	try {
		writeFileSync(ACTIVITY_FILE, String(Date.now()), "utf8");
	} catch {}
	// Also update structured metadata if it exists
	try {
		const md = readMetadata();
		if (md) touchActivityBL(md);
	} catch {}
}

/**
 * Find the PID of the process listening on GREEDY_PORT via OS tools.
 * Falls back to the PID file if netstat/lsof isn't available.
 */
function getPortPid() {
	try {
		if (platform() === "win32") {
			const out = execSync(`${resolveSystemCmd("netstat")} -ano -p TCP 2>nul`, {
				encoding: "utf8",
			});
			const re = new RegExp(
				String.raw`TCP\s+\S+:${GREEDY_PORT}\s+\S+:0\s+LISTENING\s+(\d+)`,
				"i",
			);
			const m = out.match(re);
			return m ? Number.parseInt(m[1], 10) : null;
		}
		const out = execSync(
			`${resolveSystemCmd("lsof")} -i :${GREEDY_PORT} -t 2>/dev/null || ${resolveSystemCmd("ss")} -tlnp 2>/dev/null | ${resolveSystemCmd("grep")} :${GREEDY_PORT} | ${resolveSystemCmd("grep")} -oP 'pid=\\K\\d+'`,
			{ encoding: "utf8" },
		).trim();
		return out ? Number.parseInt(out.split("\n")[0], 10) : null;
	} catch {
		return null;
	}
}

/**
 * Send Browser.close via CDP WebSocket so Chrome flushes its cookie DB to disk
 * before we force-kill it. Gives the process up to `graceMs` to exit on its own.
 * Falls back to force-kill if Chrome is still running after the grace period.
 * Returns true if the process is gone after the call.
 */
async function gracefulCloseChrome(graceMs = 1500) {
	try {
		const version = await new Promise((resolve, reject) => {
			const req = http.get(
				`http://localhost:${GREEDY_PORT}/json/version`,
				(res) => {
					let body = "";
					res.on("data", (d) => (body += d));
					res.on("end", () => {
						try {
							resolve(JSON.parse(body));
						} catch {
							reject(new Error("bad JSON"));
						}
					});
				},
			);
			req.on("error", reject);
			req.setTimeout(1000, () => {
				req.destroy();
				reject(new Error("timeout"));
			});
		});

		const ws = new globalThis.WebSocket(version.webSocketDebuggerUrl);
		await new Promise((resolve) => {
			ws.onopen = () => {
				ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
				// Give Chrome a moment to receive the command before we close the socket
				setTimeout(() => {
					ws.close();
					resolve();
				}, 200);
			};
			ws.onerror = () => resolve();
			setTimeout(resolve, 1000);
		});
	} catch {
		// Chrome not reachable — skip to force-kill
	}

	// Wait for Chrome to exit gracefully (flushes SQLite cookie DB)
	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		const pid = getPortPid();
		if (!pid) return true; // already gone
		await new Promise((r) => setTimeout(r, 150));
	}

	// Still running — force-kill
	return killProcessOnPort();
}

/**
 * Force-kill whatever process is listening on GREEDY_PORT.
 * Uses OS tools to find the PID (not the PID file — handles ghost processes).
 * Never touches the user's main Chrome (which runs on different ports).
 */
function killProcessOnPort() {
	try {
		let pid = getPortPid();
		if (!pid && existsSync(PID_FILE)) {
			pid = Number.parseInt(readFileSync(PID_FILE, "utf8").trim(), 10) || null;
		}
		if (!pid) return false;

		if (platform() === "win32") {
			execSync(`${resolveSystemCmd("taskkill")} /F /PID ${pid}`, {
				stdio: "ignore",
			});
		} else {
			process.kill(pid, "SIGKILL");
		}
		return true;
	} catch {
		return false;
	}
}

/**
 * Kill the Chrome on GREEDY_PORT (headless or visible).
 * Uses port-based detection (handles stale PID files / ghost processes).
 */
export async function killChrome() {
	const ready = await probeGreedyChrome(500);
	if (!ready) {
		// Chrome not running — just clean up tracking files
		try {
			unlinkSync(PID_FILE);
		} catch {}
		try {
			unlinkSync(ACTIVITY_FILE);
		} catch {}
		try {
			unlinkSync(CHROME_MODE_FILE);
		} catch {}
		return false;
	}

	// Graceful close: sends Browser.close so Chrome flushes its cookie DB,
	// then force-kills if it doesn't exit within the grace period.
	const killed = await gracefulCloseChrome(1500);

	// Clean up tracking files regardless of kill success
	try {
		unlinkSync(PID_FILE);
	} catch {}
	try {
		unlinkSync(ACTIVITY_FILE);
	} catch {}
	try {
		unlinkSync(CHROME_MODE_FILE);
	} catch {}

	if (killed) {
		process.stderr.write(
			`[greedysearch] Killed Chrome on port ${GREEDY_PORT}.\n`,
		);
	}
	return killed;
}

// Backward-compat alias
export const killHeadlessChrome = killChrome;

/**
 * Check if Chrome has been idle too long and kill if so.
 * Uses mode-specific timeouts: headless → 5 min, visible → 60 min (defaults).
 * Visible Chrome has a much longer grace period because the user explicitly
 * launched it and invested time in captcha/cookie setup.
 * Returns true if Chrome was killed (caller should re-launch).
 */
export async function checkAndKillIdle() {
	const headless = isChromeHeadless();
	const timeoutMinutes = headless
		? HEADLESS_IDLE_TIMEOUT_MINUTES
		: VISIBLE_IDLE_TIMEOUT_MINUTES;

	// Disable idle cleanup for this mode
	if (timeoutMinutes <= 0) return false;

	if (!existsSync(ACTIVITY_FILE)) {
		touchActivity();
		return false;
	}

	try {
		const lastActivity = Number.parseInt(
			readFileSync(ACTIVITY_FILE, "utf8").trim(),
			10,
		);
		if (!lastActivity) return false;

		const idleMs = Date.now() - lastActivity;
		const idleMinutes = idleMs / 60000;

		if (idleMinutes >= timeoutMinutes) {
			return killChrome();
		}
	} catch {}

	return false;
}

/** Re-export cdp() from the canonical location in extractors/common.mjs */
export const cdp = _cdp;

export async function getAnyTab() {
	const list = await cdp(["list"]);
	const first = list.split("\n")[0];
	if (!first) throw new Error("No Chrome tabs found");
	return first.slice(0, 8);
}

export async function openNewTab(url = "about:blank") {
	const anchor = await getAnyTab();
	const hostname = new URL(url).hostname;
	const needsStealth =
		hostname === "copilot.microsoft.com" ||
		hostname === "www.perplexity.ai" ||
		hostname === "perplexity.ai" ||
		hostname.endsWith(".perplexity.ai");

	if (needsStealth) {
		// Bing Copilot / Perplexity: create blank tab, inject stealth, return.
		// The extractor handles its own navigation, and Page.addScriptToEvaluateOnNewDocument
		// runs the stealth script before any page scripts.
		//
		// For Bing: stealth is awaited (Cloudflare blocks headless without it).
		// For Perplexity: stealth is fire-and-forget (Perplexity's anti-bot detects
		// the aggressive canvas/console patches, so we don't block on the CDP response).
		const raw = await cdp([
			"evalraw",
			anchor,
			"Target.createTarget",
			JSON.stringify({ url: "about:blank" }),
		]);
		const { targetId } = JSON.parse(raw);
		const tid = targetId.slice(0, 8);
		await cdp(["list"]).catch(() => null);

		if (hostname === "copilot.microsoft.com") {
			await injectHeadlessStealth(tid);
		} else {
			// Perplexity: fire-and-forget (Perplexity's anti-bot detects awaited patches)
			injectHeadlessStealth(tid).catch(() => {});
		}

		await cdp(["list"]).catch(() => null);
		return targetId;
	}

	// Google / other engines: pre-seed with URL directly.  Target.createTarget
	// navigation is less detectable than CDP Page.navigate.
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		JSON.stringify({ url }),
	]);
	const { targetId } = JSON.parse(raw);
	await cdp(["list"]).catch(() => null);
	return targetId;
}

export async function activateTab(targetId) {
	try {
		const anchor = await getAnyTab();
		await cdp([
			"evalraw",
			anchor,
			"Target.activateTarget",
			JSON.stringify({ targetId }),
		]);
	} catch {
		// best-effort
	}
}

export async function closeTab(targetId) {
	try {
		const anchor = await getAnyTab();
		await cdp([
			"evalraw",
			anchor,
			"Target.closeTarget",
			JSON.stringify({ targetId }),
		]);
	} catch {
		/* best-effort */
	}
}

export async function closeTabs(targetIds = []) {
	await Promise.all(
		targetIds.filter(Boolean).map((tid) => closeTab(tid).catch(() => {})),
	);
	if (targetIds.length > 0) {
		await cdp(["list"]).catch(() => null);
	}
}

export function getFullTabFromCache(engine, engineDomains) {
	try {
		if (!existsSync(PAGES_CACHE)) return null;
		const pages = JSON.parse(readFileSync(PAGES_CACHE, "utf8"));
		const found = pages.find((p) => p.url.includes(engineDomains[engine]));
		return found ? found.targetId : null;
	} catch {
		return null;
	}
}

export function probeGreedyChrome(timeoutMs = 3000) {
	return new Promise((resolve) => {
		const req = http.get(
			`http://localhost:${GREEDY_PORT}/json/version`,
			(res) => {
				res.resume();
				resolve(res.statusCode === 200);
			},
		);
		req.on("error", () => resolve(false));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve(false);
		});
	});
}

export async function refreshPortFile() {
	const LOCK_FILE = `${ACTIVE_PORT_FILE}.lock`;
	const TEMP_FILE = `${ACTIVE_PORT_FILE}.tmp`;
	const LOCK_STALE_MS = 5000;
	const LOCK_WAIT_MS = 1000;

	// File-based lock with exclusive create + stale lock recovery
	const lockAcquired = await new Promise((resolve) => {
		const start = Date.now();
		const tryLock = () => {
			try {
				const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
				writeFileSync(LOCK_FILE, payload, { encoding: "utf8", flag: "wx" });
				resolve(true);
			} catch (e) {
				if (e?.code !== "EEXIST") {
					if (Date.now() - start < LOCK_WAIT_MS) {
						setTimeout(tryLock, 50);
					} else {
						resolve(false);
					}
					return;
				}

				try {
					const lockRaw = readFileSync(LOCK_FILE, "utf8").trim();
					const parsed = lockRaw.startsWith("{")
						? JSON.parse(lockRaw)
						: { ts: Number(lockRaw) };
					const lockTime = Number(parsed?.ts) || 0;

					if (lockTime > 0 && Date.now() - lockTime > LOCK_STALE_MS) {
						try {
							unlinkSync(LOCK_FILE);
						} catch {}
					}

					if (Date.now() - start < LOCK_WAIT_MS) {
						setTimeout(tryLock, 50);
					} else {
						resolve(false);
					}
				} catch {
					if (Date.now() - start < LOCK_WAIT_MS) {
						setTimeout(tryLock, 50);
					} else {
						resolve(false);
					}
				}
			}
		};
		tryLock();
	});

	try {
		const body = await new Promise((res, rej) => {
			const req = http.get(
				`http://localhost:${GREEDY_PORT}/json/version`,
				(r) => {
					let b = "";
					r.on("data", (d) => (b += d));
					r.on("end", () => res(b));
				},
			);
			req.on("error", rej);
			req.setTimeout(3000, () => {
				req.destroy();
				rej(new Error("timeout"));
			});
		});
		const { webSocketDebuggerUrl } = JSON.parse(body);
		const wsPath = new URL(webSocketDebuggerUrl).pathname;

		// Atomic write: write to temp file, then rename
		if (lockAcquired) {
			writeFileSync(TEMP_FILE, `${GREEDY_PORT}\n${wsPath}`, "utf8");
			try {
				unlinkSync(ACTIVE_PORT_FILE);
			} catch {}
			renameSync(TEMP_FILE, ACTIVE_PORT_FILE);
		}
	} catch {
		/* best-effort — launch.mjs already wrote the file on first start */
	} finally {
		if (lockAcquired) {
			try {
				unlinkSync(LOCK_FILE);
			} catch {}
		}
	}
}

export async function ensureChrome() {
	// ── Stale session cleanup (once per process) + mode-specific idle check ──
	cleanupStaleSessions();
	const wasKilled = await checkAndKillIdle();

	const ready = wasKilled ? false : await probeGreedyChrome();
	// If Chrome is running but in wrong mode, kill it so we relaunch in the correct mode.
	let forceRelaunch = false;
	if (ready) {
		const headless = isChromeHeadless();
		const wantsVisible = process.env.GREEDY_SEARCH_VISIBLE === "1";

		if (!wantsVisible && !headless) {
			// Headless requested (default) but visible Chrome is running — switch back
			process.stderr.write(
				"[greedysearch] Visible Chrome detected — switching to headless mode...\n",
			);
			await killHeadlessChrome();
			await new Promise((r) => setTimeout(r, 1000));
			forceRelaunch = true;
		} else if (wantsVisible && headless) {
			// Visible requested but headless Chrome is running — switch
			process.stderr.write(
				"[greedysearch] Headless Chrome detected — switching to visible mode...\n",
			);
			await killHeadlessChrome();
			await new Promise((r) => setTimeout(r, 1000));
			forceRelaunch = true;
		}
	}

	const readyAfterModeCheck = forceRelaunch ? false : await probeGreedyChrome();
	if (readyAfterModeCheck) {
		// Chrome already running in correct mode — refresh port file, touch activity, register client
		await refreshPortFile();
		try {
			const md = readMetadata();
			if (md) {
				touchActivityBL(md);
				registerClient(md);
			}
		} catch {}
		return;
	}

	// ── Cross-process launch lock: prevent race between concurrent ensureChrome calls ──
	const lock = acquireLaunchLock();
	if (!lock.acquired) {
		// Another process is launching Chrome — wait and re-probe
		await new Promise((r) => setTimeout(r, 3000));
		const reReady = await probeGreedyChrome(5000);
		if (reReady) {
			await refreshPortFile();
			return;
		}
		// Still not ready — launch ourselves (the other launcher may have crashed)
	}

	try {
		// Double-check after acquiring lock (other process may have finished)
		const reCheck = await probeGreedyChrome(1000);
		if (reCheck) {
			await refreshPortFile();
			return;
		}

		process.stderr.write(
			`GreedySearch Chrome not running on port ${GREEDY_PORT} — auto-launching...\n`,
		);
		const launchArgs = [join(__dir, "..", "..", "bin", "launch.mjs")];
		// Headless is the default unless GREEDY_SEARCH_VISIBLE=1
		if (process.env.GREEDY_SEARCH_VISIBLE !== "1")
			launchArgs.push("--headless");
		await new Promise((resolve, reject) => {
			// Use process.execPath instead of bare "node" so we are not relying on PATH
			// (SonarCloud S4036).
			const proc = spawn(process.execPath, launchArgs, {
				stdio: ["ignore", process.stderr, process.stderr],
			});
			proc.on("close", (code) =>
				code === 0 ? resolve() : reject(new Error("launch.mjs failed")),
			);
		});
	} finally {
		lock.release();
	}
}

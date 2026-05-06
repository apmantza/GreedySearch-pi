// src/search/chrome.mjs — Chrome launch, probe, port file management, and CDP wrapper
//
// Extracted from search.mjs to reduce file complexity.
//
// cdp() is re-exported from extractors/common.mjs to avoid duplication.
//
// Headless cleanup: when GREEDY_SEARCH_HEADLESS=1, idle Chrome is auto-killed
// after GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES (default 5). Only the tracked
// headless instance (PID file + port 9222) is killed — never the main session.

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
import {
	ACTIVE_PORT_FILE,
	CHROME_MODE_FILE,
	GREEDY_PORT,
	PAGES_CACHE,
} from "./constants.mjs";

const __dir =
	import.meta.dirname ||
	new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

// ─── Chrome idle cleanup & lifecycle ──────────────────────────────────
// Applies to BOTH headless and visible Chrome.  Idle timeout (default 5 min)
// configurable via GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES.  Set to 0 to disable.

const _tmp = tmpdir().replaceAll("\\", "/");
const PID_FILE = `${_tmp}/greedysearch-chrome.pid`;
const ACTIVITY_FILE = `${_tmp}/greedysearch-chrome-last-activity`;
const IDLE_TIMEOUT_MINUTES =
	Number.parseInt(process.env.GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES || "5", 10) ||
	5;

/** Check if the running Chrome was launched in headless mode by reading the mode marker file */
export function isChromeHeadless() {
	try {
		if (!existsSync(CHROME_MODE_FILE)) return true; // default: headless
		return readFileSync(CHROME_MODE_FILE, "utf8").trim() === "headless";
	} catch {
		return true;
	}
}

/** Record that the Chrome was just used / is active right now */
export function touchActivity() {
	try {
		writeFileSync(ACTIVITY_FILE, String(Date.now()), "utf8");
	} catch {}
}

/**
 * Find the PID of the process listening on GREEDY_PORT via OS tools.
 * Falls back to the PID file if netstat/lsof isn't available.
 */
function getPortPid() {
	try {
		if (platform() === "win32") {
			const out = execSync("netstat -ano -p TCP 2>nul", {
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
			`lsof -i :${GREEDY_PORT} -t 2>/dev/null || ss -tlnp 2>/dev/null | grep :${GREEDY_PORT} | grep -oP 'pid=\\K\\d+'`,
			{ encoding: "utf8" },
		).trim();
		return out ? Number.parseInt(out.split("\n")[0], 10) : null;
	} catch {
		return null;
	}
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
			execSync(`taskkill /F /PID ${pid}`, { stdio: "ignore" });
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

	const killed = killProcessOnPort();

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
 * Applies to BOTH headless and visible Chrome.
 * Returns true if Chrome was killed (caller should re-launch).
 */
export async function checkAndKillIdle() {
	// Disable idle cleanup via GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES=0
	if (IDLE_TIMEOUT_MINUTES <= 0) return false;

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

		if (idleMinutes >= IDLE_TIMEOUT_MINUTES) {
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
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		JSON.stringify({ url }),
	]);
	const { targetId } = JSON.parse(raw);
	// Inject stealth patches when headless (visible Chrome doesn't need them —
	// the AutomationControlled flag is disabled at launch and navigator.webdriver
	// is naturally undefined in headed mode).  Still inject for extra coverage.
	const tid = targetId.slice(0, 8);
	injectHeadlessStealth(tid).catch(() => {});
	// Refresh the pages cache so cdp.mjs can discover the new tab immediately
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
	// ── Headless idle cleanup: kill if timed out ──
	const wasKilled = await checkAndKillIdle();

	const ready = wasKilled ? false : await probeGreedyChrome();
	// If Chrome is running but in wrong mode (visible requested, headless running),
	// kill it so we relaunch in the correct mode.
	let forceRelaunch = false;
	if (
		ready &&
		process.env.GREEDY_SEARCH_VISIBLE === "1" &&
		isChromeHeadless()
	) {
		process.stderr.write(
			"[greedysearch] Headless Chrome detected — switching to visible mode...\n",
		);
		await killHeadlessChrome();
		// Wait a moment for the port to free up
		await new Promise((r) => setTimeout(r, 1000));
		forceRelaunch = true; // always relaunch when switching modes
	}

	const readyAfterModeCheck = forceRelaunch ? false : await probeGreedyChrome();
	if (readyAfterModeCheck) {
		// Chrome already running in correct mode — refresh the port file
		await refreshPortFile();
	} else {
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
	}
}

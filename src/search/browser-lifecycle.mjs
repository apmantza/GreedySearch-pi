// src/search/browser-lifecycle.mjs — Centralized browser lifecycle management
//
// Patterns adopted from open-websearch's robust cross-process browser management:
//   1. Structured JSON metadata (browserPid, debugPort, tempDir, clientPids, sessionMode)
//   2. Process command-line verification (not just PID alive)
//   3. Cross-process file lock during Chrome launch
//   4. Stale session cleanup on startup (orphan detection)
//   5. Client PID tracking for multi-process sharing
//
// GreedySearch-pi uses a single dedicated Chrome on port 9222, so the
// cross-process reuse model is simpler than open-websearch's multi-browser
// domain-key system. We still get the robustness benefits.

import { execFileSync, execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { platform, tmpdir } from "node:os";
import { GREEDY_PORT, GREEDY_PROFILE_DIR } from "./constants.mjs";
import { resolveSystemCmd } from "../utils/system-cmds.mjs";

const _tmp = tmpdir().replaceAll("\\", "/");

// ─── Paths ───────────────────────────────────────────────────────────

/** Single JSON metadata file replacing scattered PID/mode/activity files */
export const METADATA_FILE = `${_tmp}/greedysearch-chrome-metadata.json`;

/** Lock file for Chrome launch mutual exclusion */
const LAUNCH_LOCK_FILE = `${_tmp}/greedysearch-chrome-launch.lock`;

/** How long before a launch lock is considered stale */
const LOCK_STALE_MS = 15000;

// Legacy file paths (kept for backward compat during migration)
const LEGACY_PID_FILE = `${_tmp}/greedysearch-chrome.pid`;
const LEGACY_MODE_FILE = `${_tmp}/greedysearch-chrome-mode`;
const LEGACY_ACTIVITY_FILE = `${_tmp}/greedysearch-chrome-last-activity`;

// ─── Types ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} BrowserMetadata
 * @property {number} [browserPid] - PID of the Chrome browser process
 * @property {number} debugPort - CDP debug port (always 9222)
 * @property {string} tempDir - Chrome profile directory
 * @property {number[]} clientPids - PIDs of processes sharing this browser
 * @property {"headless"|"visible"} sessionMode
 * @property {number} lastActivity - timestamp of last activity
 * @property {number} launchedAt - timestamp when Chrome was launched
 */

// ─── Process verification ────────────────────────────────────────────

/**
 * Check if a process exists by PID using process.kill(pid, 0).
 * @param {number} pid
 * @returns {boolean}
 */
function processExists(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Get the command line of a process by PID.
 * Uses PowerShell on Windows, ps on Unix.
 * @param {number} pid
 * @returns {string|null} command line or null if unavailable
 */
function getProcessCommandLine(pid) {
	if (!processExists(pid)) return null;
	try {
		if (platform() === "win32") {
			const output = execFileSync(
				resolveSystemCmd("powershell"),
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					`(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`,
				],
				{ encoding: "utf8", windowsHide: true, timeout: 5000 },
			);
			return output.trim() || null;
		}
		const output = execFileSync(
			resolveSystemCmd("ps"),
			["-p", String(pid), "-o", "command="],
			{
				encoding: "utf8",
				timeout: 5000,
			},
		);
		return output.trim() || null;
	} catch {
		return null;
	}
}

/**
 * Verify that a PID actually belongs to the GreedySearch Chrome by
 * checking its command line contains both the profile dir and debug port.
 * This catches cases where a different process reuses the same PID.
 * @param {number} pid
 * @param {string} tempDir - expected Chrome profile directory
 * @param {number} debugPort - expected debug port
 * @returns {boolean}
 */
export function verifyBrowserProcess(pid, tempDir, debugPort = GREEDY_PORT) {
	const cmdLine = getProcessCommandLine(pid);
	if (!cmdLine) return false;
	return (
		cmdLine.includes(tempDir) &&
		cmdLine.includes(`--remote-debugging-port=${debugPort}`) &&
		!cmdLine.includes("--type=")
	);
}

// ─── PID resolution via port ────────────────────────────────────────

/**
 * Find the PID of the process listening on a port via OS tools.
 * @param {number} port
 * @returns {number|null}
 */
function getPortPid(port = GREEDY_PORT) {
	try {
		if (platform() === "win32") {
			const out = execSync(`${resolveSystemCmd("netstat")} -ano -p TCP 2>nul`, {
				encoding: "utf8",
			});
			const re = new RegExp(
				String.raw`TCP\s+\S+:${port}\s+\S+:0\s+LISTENING\s+(\d+)`,
				"i",
			);
			const m = out.match(re);
			return m ? Number.parseInt(m[1], 10) : null;
		}
		const out = execSync(
			`${resolveSystemCmd("lsof")} -i :${port} -t 2>/dev/null || ${resolveSystemCmd("ss")} -tlnp 2>/dev/null | ${resolveSystemCmd("grep")} :${port} | ${resolveSystemCmd("grep")} -oP 'pid=\\K\\d+'`,
			{ encoding: "utf8" },
		).trim();
		return out ? Number.parseInt(out.split("\n")[0], 10) : null;
	} catch {
		return null;
	}
}

// ─── Force-kill ──────────────────────────────────────────────────────

/**
 * Force-kill a process by PID (and its children on Windows via /T).
 * @param {number} pid
 * @returns {boolean} true if kill was attempted
 */
function forceKillProcess(pid) {
	try {
		if (platform() === "win32") {
			execSync(`${resolveSystemCmd("taskkill")} /F /T /PID ${pid}`, {
				stdio: "ignore",
			});
		} else {
			try {
				process.kill(-pid, "SIGKILL"); // process group
			} catch {}
			try {
				process.kill(pid, "SIGKILL");
			} catch {}
		}
		return true;
	} catch {
		return false;
	}
}

// ─── Metadata file operations ────────────────────────────────────────

/**
 * Read browser metadata, falling back to legacy files.
 * @returns {BrowserMetadata|null}
 */
export function readMetadata() {
	// Try JSON metadata first
	try {
		if (existsSync(METADATA_FILE)) {
			const raw = readFileSync(METADATA_FILE, "utf8");
			const parsed = JSON.parse(raw);
			if (
				parsed &&
				typeof parsed.tempDir === "string" &&
				typeof parsed.debugPort === "number"
			) {
				return {
					browserPid: Number.isInteger(parsed.browserPid)
						? parsed.browserPid
						: undefined,
					debugPort: parsed.debugPort,
					tempDir: parsed.tempDir,
					clientPids: Array.isArray(parsed.clientPids)
						? parsed.clientPids.filter((p) => Number.isInteger(p) && p > 0)
						: [],
					sessionMode:
						parsed.sessionMode === "visible" ? "visible" : "headless",
					lastActivity: Number.isFinite(parsed.lastActivity)
						? parsed.lastActivity
						: 0,
					launchedAt: Number.isFinite(parsed.launchedAt)
						? parsed.launchedAt
						: 0,
				};
			}
		}
	} catch {
		// Parse failure — fall through to legacy
	}

	// Legacy fallback: read old PID/mode/activity files
	try {
		const browserPid = existsSync(LEGACY_PID_FILE)
			? Number.parseInt(readFileSync(LEGACY_PID_FILE, "utf8").trim(), 10) ||
				undefined
			: undefined;

		const sessionMode = existsSync(LEGACY_MODE_FILE)
			? readFileSync(LEGACY_MODE_FILE, "utf8").trim() === "visible"
				? "visible"
				: "headless"
			: "headless";

		const lastActivity = existsSync(LEGACY_ACTIVITY_FILE)
			? Number.parseInt(
					readFileSync(LEGACY_ACTIVITY_FILE, "utf8").trim(),
					10,
				) || 0
			: 0;

		return {
			browserPid,
			debugPort: GREEDY_PORT,
			tempDir: GREEDY_PROFILE_DIR,
			clientPids: browserPid ? [browserPid] : [],
			sessionMode,
			lastActivity,
			launchedAt: 0,
		};
	} catch {
		return null;
	}
}

/**
 * Write browser metadata to the JSON file.
 * Also writes legacy files for backward compatibility.
 * @param {BrowserMetadata} metadata
 */
export function writeMetadata(metadata) {
	try {
		writeFileSync(
			METADATA_FILE,
			JSON.stringify(
				{
					browserPid: metadata.browserPid,
					debugPort: metadata.debugPort,
					tempDir: metadata.tempDir,
					clientPids: [...new Set(metadata.clientPids.filter((p) => p > 0))],
					sessionMode: metadata.sessionMode,
					lastActivity: metadata.lastActivity,
					launchedAt: metadata.launchedAt,
				},
				null,
				2,
			),
			"utf8",
		);
	} catch {
		// Best-effort
	}

	// Backward-compat legacy files
	try {
		if (metadata.browserPid)
			writeFileSync(LEGACY_PID_FILE, String(metadata.browserPid), "utf8");
	} catch {}
	try {
		writeFileSync(LEGACY_MODE_FILE, metadata.sessionMode, "utf8");
	} catch {}
	try {
		writeFileSync(LEGACY_ACTIVITY_FILE, String(metadata.lastActivity), "utf8");
	} catch {}
}

/**
 * Delete metadata file and legacy files.
 */
export function clearMetadata() {
	try {
		unlinkSync(METADATA_FILE);
	} catch {}
	try {
		unlinkSync(LEGACY_PID_FILE);
	} catch {}
	try {
		unlinkSync(LEGACY_MODE_FILE);
	} catch {}
	try {
		unlinkSync(LEGACY_ACTIVITY_FILE);
	} catch {}
}

// ─── Client PID tracking ─────────────────────────────────────────────

/**
 * Register the current process as a client of the browser.
 * @param {BrowserMetadata} metadata
 * @returns {BrowserMetadata} updated metadata
 */
export function registerClient(metadata) {
	if (!metadata) return metadata;
	const updated = {
		...metadata,
		clientPids: [
			...new Set(
				[...metadata.clientPids, process.pid].filter(
					(p) => processExists(p) || p === process.pid,
				),
			),
		],
	};
	writeMetadata(updated);
	return updated;
}

/**
 * Unregister the current process as a client of the browser.
 * @param {BrowserMetadata} metadata
 * @returns {BrowserMetadata} updated metadata
 */
export function unregisterClient(metadata) {
	if (!metadata) return metadata;
	const updated = {
		...metadata,
		clientPids: metadata.clientPids
			.filter((p) => p !== process.pid)
			.filter((p) => processExists(p)),
	};
	writeMetadata(updated);
	return updated;
}

// ─── Activity tracking ───────────────────────────────────────────────

/**
 * Record current timestamp as last activity.
 * @param {BrowserMetadata} [metadata] - if provided, updates and writes
 */
export function touchActivity(metadata) {
	const ts = Date.now();
	try {
		if (metadata) {
			writeMetadata({ ...metadata, lastActivity: ts });
		} else {
			writeFileSync(LEGACY_ACTIVITY_FILE, String(ts), "utf8");
		}
	} catch {}
}

// ─── Idle check ──────────────────────────────────────────────────────

const IDLE_TIMEOUT_MINUTES =
	Number.parseInt(process.env.GREEDY_SEARCH_IDLE_TIMEOUT_MINUTES || "5", 10) ||
	5;

/**
 * Check if the browser has been idle long enough to kill.
 * @param {BrowserMetadata} metadata
 * @returns {boolean} true if browser should be killed
 */
export function isIdleExpired(metadata) {
	if (IDLE_TIMEOUT_MINUTES <= 0) return false;
	if (!metadata || !metadata.lastActivity) return false;
	const idleMs = Date.now() - metadata.lastActivity;
	return idleMs / 60000 >= IDLE_TIMEOUT_MINUTES;
}

// ─── Stale session cleanup ───────────────────────────────────────────

let _staleCleanupPerformed = false;

/**
 * Scan for orphaned Chrome processes from crashed sessions.
 * Uses metadata to find and verify browser processes, force-killing
 * any that are dead or don't match the expected profile/port.
 *
 * Pattern adopted from open-websearch's cleanupStaleLocalBrowserSessions().
 *
 * Called once on first use (idempotent via _staleCleanupPerformed flag).
 */
export function cleanupStaleSessions() {
	if (_staleCleanupPerformed) return;
	_staleCleanupPerformed = true;

	const metadata = readMetadata();
	if (!metadata) return;

	// Check PID from metadata
	if (metadata.browserPid) {
		const alive = processExists(metadata.browserPid);

		if (!alive) {
			// Dead PID in metadata — clean up
			forceKillProcess(metadata.browserPid);
			clearMetadata();
			return;
		}

		// Alive — verify it's actually our Chrome
		const verified = verifyBrowserProcess(
			metadata.browserPid,
			metadata.tempDir,
			metadata.debugPort,
		);

		if (!verified) {
			// Wrong process at this PID — probably a PID collision
			// Only kill if we can confirm it's a stale Chrome (command line doesn't match)
			clearMetadata();
		} else {
			// Fresh client PIDs (remove dead ones)
			writeMetadata({
				...metadata,
				clientPids: metadata.clientPids.filter((p) => processExists(p)),
			});
		}
	}

	// Check for ghost processes on our port
	const portPid = getPortPid();
	if (portPid && portPid !== metadata.browserPid) {
		// Something else is on our port
		const verified = verifyBrowserProcess(
			portPid,
			GREEDY_PROFILE_DIR,
			GREEDY_PORT,
		);
		if (verified) {
			// It's a GreedySearch Chrome that lost its metadata — reclaim it
			writeMetadata({
				browserPid: portPid,
				debugPort: GREEDY_PORT,
				tempDir: GREEDY_PROFILE_DIR,
				clientPids: [portPid],
				sessionMode: metadata.sessionMode,
				lastActivity: Date.now(),
				launchedAt: Date.now(),
			});
		} else {
			// Ghost process on our port that isn't ours — attempt cleanup
			forceKillProcess(portPid);
		}
	}
}

// ─── Cross-process launch lock ───────────────────────────────────────

/**
 * Acquire an exclusive lock for Chrome launch operations.
 * Uses wx (exclusive create) on a lock file — if creation fails,
 * the file already exists and we check for staleness.
 *
 * Returns a release function. Call it when the launch is complete.
 * @returns {{ release: () => void, acquired: boolean }}
 */
export function acquireLaunchLock() {
	mkdirSync(tmpdir(), { recursive: true });

	// Try exclusive create
	try {
		const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
		writeFileSync(LAUNCH_LOCK_FILE, payload, { encoding: "utf8", flag: "wx" });
		return {
			acquired: true,
			release: () => {
				try {
					// Only delete if we wrote it
					const raw = readFileSync(LAUNCH_LOCK_FILE, "utf8");
					const parsed = JSON.parse(raw);
					if (parsed.pid === process.pid) {
						unlinkSync(LAUNCH_LOCK_FILE);
					}
				} catch {}
			},
		};
	} catch (e) {
		if (e?.code !== "EEXIST") {
			return { acquired: false, release: () => {} };
		}
	}

	// Lock file exists — check if stale
	try {
		const raw = readFileSync(LAUNCH_LOCK_FILE, "utf8");
		const parsed = JSON.parse(raw);
		const lockAge = Date.now() - (parsed.ts || 0);
		const lockPidAlive = processExists(parsed.pid);

		if (!lockPidAlive || lockAge > LOCK_STALE_MS) {
			// Stale lock — take it over
			try {
				unlinkSync(LAUNCH_LOCK_FILE);
			} catch {}
			try {
				const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
				writeFileSync(LAUNCH_LOCK_FILE, payload, {
					encoding: "utf8",
					flag: "wx",
				});
				return {
					acquired: true,
					release: () => {
						try {
							unlinkSync(LAUNCH_LOCK_FILE);
						} catch {}
					},
				};
			} catch {
				return { acquired: false, release: () => {} };
			}
		}
	} catch {}

	// Another process holds the lock and is alive
	return { acquired: false, release: () => {} };
}

// ─── High-level lifecycle ────────────────────────────────────────────

/**
 * Check if GreedySearch Chrome is running, verified by process command line.
 * @returns {{ running: boolean, pid: number|null, metadata: BrowserMetadata|null }}
 */
export function checkRunning() {
	const metadata = readMetadata();
	if (!metadata || !metadata.browserPid) {
		// Check port as fallback
		const portPid = getPortPid();
		if (
			portPid &&
			verifyBrowserProcess(portPid, GREEDY_PROFILE_DIR, GREEDY_PORT)
		) {
			return { running: true, pid: portPid, metadata };
		}
		return { running: false, pid: null, metadata: null };
	}

	const alive = processExists(metadata.browserPid);
	if (!alive) {
		return { running: false, pid: null, metadata };
	}

	const verified = verifyBrowserProcess(
		metadata.browserPid,
		metadata.tempDir,
		metadata.debugPort,
	);

	if (!verified) {
		// PID exists but isn't our Chrome — check port
		const portPid = getPortPid();
		if (
			portPid &&
			verifyBrowserProcess(portPid, GREEDY_PROFILE_DIR, GREEDY_PORT)
		) {
			return { running: true, pid: portPid, metadata };
		}
		return { running: false, pid: null, metadata };
	}

	return { running: true, pid: metadata.browserPid, metadata };
}

/**
 * Kill the GreedySearch Chrome, cleaning up metadata and legacy files.
 * @returns {boolean} true if Chrome was killed
 */
export function killChrome() {
	const { running, pid } = checkRunning();
	if (!running || !pid) {
		clearMetadata();
		return false;
	}

	const killed = forceKillProcess(pid);
	clearMetadata();
	return killed;
}

/**
 * Perform a full cleanup of stale/orphaned sessions and return whether
 * Chrome is ready. If Chrome is dead but metadata exists, cleanup happens.
 * @returns {Promise<{ running: boolean, pid: number|null, metadata: BrowserMetadata|null }>}
 */
export async function ensureCleanSession() {
	cleanupStaleSessions();
	return checkRunning();
}

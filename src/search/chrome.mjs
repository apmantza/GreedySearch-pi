// src/search/chrome.mjs — Chrome launch, probe, port file management, and CDP wrapper
//
// Extracted from search.mjs to reduce file complexity.
// Also used by coding-task.mjs (via import).
//
// cdp() is re-exported from extractors/common.mjs to avoid duplication.

import { spawn } from "node:child_process";
import {
	existsSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { join } from "node:path";

import { GREEDY_PORT, ACTIVE_PORT_FILE, PAGES_CACHE } from "./constants.mjs";
import { cdp as _cdp } from "../../extractors/common.mjs";

const __dir = import.meta.dirname || new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");

/** Re-export cdp() from the canonical location in extractors/common.mjs */
export const cdp = _cdp;

export async function getAnyTab() {
	const list = await cdp(["list"]);
	const first = list.split("\n")[0];
	if (!first) throw new Error("No Chrome tabs found");
	return first.slice(0, 8);
}

export async function openNewTab() {
	const anchor = await getAnyTab();
	const raw = await cdp([
		"evalraw",
		anchor,
		"Target.createTarget",
		'{"url":"about:blank"}',
	]);
	const { targetId } = JSON.parse(raw);
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
	for (const tid of targetIds) {
		if (!tid) continue;
		await closeTab(tid);
	}
	if (targetIds.length > 0) {
		await new Promise((r) => setTimeout(r, 300));
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
	const ready = await probeGreedyChrome();
	if (!ready) {
		process.stderr.write(
			`GreedySearch Chrome not running on port ${GREEDY_PORT} — auto-launching...\n`,
		);
		await new Promise((resolve, reject) => {
			const proc = spawn("node", [join(__dir, "..", "..", "bin", "launch.mjs")], {
				stdio: ["ignore", process.stderr, process.stderr],
			});
			proc.on("close", (code) =>
				code === 0 ? resolve() : reject(new Error("launch.mjs failed")),
			);
		});
	} else {
		// Chrome already running — refresh the port file
		await refreshPortFile();
	}
}
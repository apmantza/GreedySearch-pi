// src/utils/system-cmds.mjs — Resolve system utilities to absolute paths
//
// Using absolute paths for system commands prevents PATH-injection risks
// and satisfies SonarCloud security hotspot requirements.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

/**
 * Resolve the absolute path of a system utility.
 * On Windows, checks System32. On Unix, checks standard bin/sbin paths.
 * Falls back to the bare command name if no absolute path is found
 * (last resort — will still trigger SonarCloud but prevents breakage).
 *
 * @param {string} cmd - Command name (e.g. "netstat", "powershell")
 * @returns {string} Absolute path or bare command name as fallback
 */
export function resolveSystemCmd(cmd) {
	const isWin = platform() === "win32";
	const systemRoot = process.env.SystemRoot || "C:\\Windows";

	const knownPaths = {
		win32: {
			powershell: join(
				systemRoot,
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell.exe",
			),
			powershell_ise: join(
				systemRoot,
				"System32",
				"WindowsPowerShell",
				"v1.0",
				"powershell_ise.exe",
			),
			netstat: join(systemRoot, "System32", "netstat.exe"),
			taskkill: join(systemRoot, "System32", "taskkill.exe"),
			tasklist: join(systemRoot, "System32", "tasklist.exe"),
			cmd: join(systemRoot, "System32", "cmd.exe"),
		},
		unix: {
			ps: "/usr/bin/ps",
			lsof: "/usr/bin/lsof",
			ss: "/usr/sbin/ss",
			grep: "/usr/bin/grep",
			kill: "/usr/bin/kill",
		},
	};

	const paths = isWin ? knownPaths.win32 : knownPaths.unix;
	const lower = cmd.toLowerCase();

	if (paths[lower] && existsSync(paths[lower])) {
		return paths[lower];
	}

	// Try alternative: maybe cmd.exe with /c
	if (isWin && lower === "netstat") {
		const altPath = join(systemRoot, "Sysnative", "netstat.exe");
		if (existsSync(altPath)) return altPath;
	}

	// For Unix shell pipelines (lsof ... || ss ...), the commands are run
	// via shell so we can't easily replace them. Use PATH validation instead.
	return cmd;
}

/**
 * Check whether PATH environment variable contains only system directories.
 * Returns true if PATH is safe or cannot be determined.
 */
export function isPathSafe() {
	const pathEnv = process.env.PATH || "";
	if (!pathEnv) return true; // empty PATH, unlikely
	const dirs = pathEnv.split(platform() === "win32" ? ";" : ":");
	for (const dir of dirs) {
		if (!dir) continue;
		try {
			const stat = existsSync(dir);
			if (!stat) continue; // non-existent dir in PATH is harmless
			// Check if the directory exists — on Windows we can't easily
			// check permissions without extra deps
			if (platform() !== "win32") {
				// On Unix, check if the dir is world-writeable
				const mode = execSync(`stat -c '%a' "${dir}" 2>/dev/null || echo 755`, {
					encoding: "utf8",
					timeout: 1000,
				}).trim();
				const perms = Number.parseInt(mode, 8);
				if (perms & 0o002) return false; // world-writeable dir in PATH
			}
		} catch {
			// skip unreadable dirs
		}
	}
	return true;
}

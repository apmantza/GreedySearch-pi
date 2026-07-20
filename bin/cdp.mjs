#!/usr/bin/env node

// cdp - thin CLI wrapper around the reusable in-process daemon client.

import {
	cdpCommand,
	CdpCommandError,
	runDaemon,
	USAGE,
} from "../src/search/cdp-client.mjs";

async function readStdin() {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => (data += chunk));
		process.stdin.on("end", () => resolve(data));
		if (process.stdin.isTTY) resolve("");
	});
}

async function main() {
	const [cmd, ...args] = process.argv.slice(2);
	if (cmd === "_daemon") {
		await runDaemon(args[0]);
		return;
	}

	// Preserve the CLI's --stdin contract before handing normalized argv to
	// cdpCommand. In-process callers use cdpWithInput instead.
	if (cmd === "type" && args[1] === "--stdin") args[1] = await readStdin();

	try {
		const result = await cdpCommand(
			cmd === undefined ? [] : [cmd, ...args],
		);
		if (result) process.stdout.write(`${result}\n`);
	} catch (error) {
		if (error instanceof CdpCommandError) {
			if (error.stdout) process.stdout.write(error.stdout);
			if (error.stderr) process.stderr.write(error.stderr);
			process.exitCode = error.exitCode;
		} else {
			process.stderr.write(`${error.message}\n`);
			process.exitCode = 1;
		}
	}
}

// cdpCommand handles normal help aliases; avoid validating an empty argv for
// the no-argument CLI invocation.
if (process.argv.length === 2) {
	process.stdout.write(USAGE);
} else {
	main().catch((error) => {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = 1;
	});
}

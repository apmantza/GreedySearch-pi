// test_cdp.mjs - test CDP connection

import { tmpdir } from "node:os";
import { cdp } from "./extractors/common.mjs";

// Set CDP_PROFILE_DIR like coding-task.mjs does
const GREEDY_PROFILE_DIR = `${tmpdir().replace(/\\/g, "/")}/greedysearch-chrome-profile`;
process.env.CDP_PROFILE_DIR = GREEDY_PROFILE_DIR;

console.log("CDP_PROFILE_DIR set to:", process.env.CDP_PROFILE_DIR);

try {
	const list = await cdp(["list"]);
	console.log("SUCCESS! Got list:", list.substring(0, 100));
} catch (e) {
	console.log("ERROR:", e.message);
}

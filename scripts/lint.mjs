#!/usr/bin/env node
// scripts/lint.mjs — cross-platform syntax check for all .mjs files in the repo.
// Uses `node --check` (syntax-only, no module resolution) so it works on
// every OS without depending on `find`.
//
// Usage:  npm run lint
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SKIP_DIRS = new Set([
  "node_modules",
  "results",
  ".pi",
  ".git",
  "coverage",
  "dist",
  "out",
]);
const SKIP_FILES = new Set([join("scripts", "lint.mjs")]); // self-check is redundant
const EXT = ".mjs";

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith(EXT) && !SKIP_FILES.has(full)) {
      yield full;
    }
  }
}

const files = [...walk(ROOT)];
if (!files.length) {
  console.log("No .mjs files found");
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  const rel = relative(ROOT, file).split(sep).join("/");
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
    console.log(`OK: ${rel}`);
  } catch (err) {
    failed++;
    console.error(`FAIL: ${rel}`);
    const stderr = err.stderr?.toString() || err.message;
    for (const line of stderr.split("\n").filter(Boolean)) {
      console.error(`  ${line}`);
    }
  }
}

if (failed) {
  console.error(`\n${failed} of ${files.length} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`\nAll ${files.length} .mjs file(s) passed syntax check`);

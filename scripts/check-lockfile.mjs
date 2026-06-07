#!/usr/bin/env node
// scripts/check-lockfile.mjs — verify package.json and package-lock.json are in sync.
// CI fails the lint-and-lockfile job if a dep version is listed in package.json
// without a matching entry in package-lock.json, or vice versa.
//
// Usage:  npm run check:lockfile
import { readFileSync, existsSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (!existsSync("package-lock.json")) {
  console.error("package-lock.json not found. Run `npm install` first.");
  process.exit(1);
}
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const root = lock.packages?.[""] || {};

let issues = 0;
const check = (section, name, ver, lockVer) => {
  if (lockVer !== ver) {
    console.error(
      `MISMATCH (${section}): ${name} — package.json: ${ver ?? "(absent)"}, lock: ${lockVer ?? "(absent)"}`,
    );
    issues++;
  }
};

for (const [name, ver] of Object.entries(pkg.dependencies || {})) {
  check("dep", name, ver, root.dependencies?.[name]);
}
for (const [name, ver] of Object.entries(pkg.devDependencies || {})) {
  check("devDep", name, ver, root.devDependencies?.[name]);
}

if (issues) {
  console.error(
    `\n${issues} lockfile mismatch(es). Run \`npm install\` to update.`,
  );
  process.exit(1);
}
const depCount =
  Object.keys(pkg.dependencies || {}).length +
  Object.keys(pkg.devDependencies || {}).length;
console.log(
  `Lockfile in sync with package.json (${depCount} ${depCount === 1 ? "dep" : "deps"})`,
);

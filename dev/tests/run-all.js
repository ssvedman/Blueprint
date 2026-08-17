#!/usr/bin/env node
/* Runs every suite in order and exits non-zero if any fails.
   Usage:  node tests/run-all.js                                             */
const { execFileSync } = require("child_process");
const path = require("path");

const suites = ["core.test.js", "mock.test.js", "ui.test.js", "secrets.test.js"];
let failed = 0;

for (const s of suites) {
  console.log("\n" + "═".repeat(64));
  console.log("  " + s);
  console.log("═".repeat(64));
  try {
    execFileSync(process.execPath, [path.join(__dirname, s)], { stdio: "inherit" });
  } catch (_) {
    failed++;
  }
}

console.log("\n" + "═".repeat(64));
if (failed) {
  console.log("  " + failed + " of " + suites.length + " suites FAILED");
  process.exit(1);
}
console.log("  ✓ all " + suites.length + " suites passed");

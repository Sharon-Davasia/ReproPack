#!/usr/bin/env node
/**
 * Build a loadable Firefox add-on into dist/firefox/.
 *
 *   node scripts/build-firefox.js
 *   → dist/firefox/{manifest.json + runtime files}
 *
 * ReproPack runs from source in Chrome (Load unpacked). Firefox needs one
 * manifest change (event page instead of a service worker) plus an add-on id,
 * which is exactly what lib/manifest-variants.js produces.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const M = require("../lib/manifest-variants.js");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "dist", "firefox");

const INCLUDE = [
  "background.js",
  "content.js",
  "offscreen.html",
  "offscreen.js",
  "options.html",
  "options.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "share/index.html",
  "share/manifest.webmanifest",
  "share/share.js",
  "share/sw.js",
  "lib/report.js",
  "lib/ai.js",
  "lib/timeline.js",
  "lib/har.js",
  "lib/triage.js",
  "lib/dupes.js",
  "lib/filing.js",
  "lib/manifest-variants.js",
  "icons/icon16.png",
  "icons/icon48.png",
  "icons/icon128.png",
  "icons/icon.svg"
];

function copyFile(rel) {
  const from = path.join(root, rel);
  const to = path.join(outDir, rel);
  if (!fs.existsSync(from)) {
    console.warn("skip (missing): " + rel);
    return false;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return true;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const firefox = M.toFirefoxManifest(manifest);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let copied = 0;
  INCLUDE.forEach((rel) => { if (copyFile(rel)) copied++; });

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(firefox, null, 2) + "\n");

  const problems = M.validateManifest(firefox, (p) => fs.existsSync(path.join(outDir, p)));
  const errors = problems.filter((p) => p.level === "error");

  console.log("Firefox build → " + path.relative(root, outDir));
  console.log("  files: " + copied + " + manifest.json");
  console.log("  manifest version: " + firefox.version);
  console.log("  gecko id: " + firefox.browser_specific_settings.gecko.id);
  if (errors.length) {
    console.error("  ✗ validation errors:");
    errors.forEach((e) => console.error("    - " + e.message));
    process.exit(1);
  }
  console.log("  ✓ validation passed");
  console.log("\nLoad it with about:debugging → This Firefox → Load Temporary Add-on → dist/firefox/manifest.json");
  console.log("Package it with: npx web-ext build -s dist/firefox -a dist/");
}

main();

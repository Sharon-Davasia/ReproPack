#!/usr/bin/env node
/**
 * Pre-flight validation for the extension source.
 *
 *   node scripts/validate.js
 *
 * Checks:
 *  • manifest.json is valid MV3 and every referenced file exists
 *  • HTML pages only load scripts that exist
 *  • every JS file parses
 *  • the Firefox variant can be derived and validated
 *  • privacy defaults are on (redact enabled)
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const M = require("../lib/manifest-variants.js");

const root = path.join(__dirname, "..");
const exists = (p) => fs.existsSync(path.join(root, p));
const problems = [];

function check(cond, message, level) {
  if (!cond) problems.push({ level: level || "error", message });
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

M.validateManifest(manifest, exists).forEach((p) => problems.push(p));

// HTML script references
["popup.html", "options.html", "offscreen.html", "share/index.html"].forEach((file) => {
  if (!exists(file)) return problems.push({ level: "error", message: "missing page: " + file });
  const html = fs.readFileSync(path.join(root, file), "utf8");
  for (const m of html.matchAll(/<script src="([^"]+)"/g)) {
    const resolved = path.join(root, path.dirname(file), m[1]);
    check(fs.existsSync(resolved), file + " loads a missing script: " + m[1]);
  }
  for (const m of html.matchAll(/<link[^>]+href="([^"]+)"/g)) {
    if (/^https?:/.test(m[1])) continue;
    const resolved = path.join(root, path.dirname(file), m[1]);
    check(fs.existsSync(resolved), file + " links a missing file: " + m[1]);
  }
});

// JS parse check
const jsFiles = [];
(function walk(dir) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    if (["node_modules", ".git", "dist"].includes(entry.name)) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith(".js")) jsFiles.push(full);
  });
})(root);

jsFiles.forEach((file) => {
  try {
    // Strip a shebang: valid for node, not for new Function.
    const source = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
    new Function(source);
  } catch (err) {
    problems.push({ level: "error", message: "syntax error in " + path.relative(root, file) + ": " + err.message });
  }
});

// Firefox variant
try {
  const ff = M.toFirefoxManifest(manifest);
  M.validateManifest(ff, exists).filter((p) => p.level === "error").forEach((p) => problems.push(p));
} catch (err) {
  problems.push({ level: "error", message: "Firefox variant failed: " + err.message });
}

// Privacy defaults
const bg = fs.readFileSync(path.join(root, "background.js"), "utf8");
check(/redact:\s*true/.test(bg), "background.js should default redact to true");
check(!/eval\s*\(/.test(bg), "background.js must not use eval", "warn");

const errors = problems.filter((p) => p.level === "error");
const warns = problems.filter((p) => p.level === "warn");

console.log("ReproPack validation");
console.log("  files checked: " + (jsFiles.length + 4) + "  |  version: " + manifest.version);
warns.forEach((w) => console.log("  ⚠ " + w.message));
errors.forEach((e) => console.log("  ✗ " + e.message));
if (errors.length) {
  console.log("\n" + errors.length + " error(s).");
  process.exit(1);
}
console.log("  ✓ no errors" + (warns.length ? " (" + warns.length + " warning(s))" : ""));

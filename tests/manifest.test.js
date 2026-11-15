/**
 * Manifest tests — the shipped manifest must be valid MV3, every file it
 * references must exist, and the Firefox variant must be derivable from it.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../lib/manifest-variants.js");

const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const exists = (p) => fs.existsSync(path.join(root, p));

test("manifest.json is valid MV3 with no missing files", () => {
  const problems = M.validateManifest(manifest, exists).filter((p) => p.level === "error");
  assert.deepEqual(problems, [], JSON.stringify(problems, null, 2));
});

test("manifest does not declare default_locale without _locales", () => {
  assert.equal(manifest.default_locale, undefined);
  assert.equal(fs.existsSync(path.join(root, "_locales")), false);
});

test("popup and options reference existing scripts", () => {
  ["popup.html", "options.html", "offscreen.html", "share/index.html"].forEach((file) => {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0, file + " should load scripts");
    srcs.forEach((src) => {
      const resolved = path.join(root, path.dirname(file), src);
      assert.ok(fs.existsSync(resolved), file + " references missing script: " + src);
    });
  });
});

test("every JS file parses", () => {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    });
  })(root);

  files.forEach((file) => {
    // new Function throws a SyntaxError on invalid JavaScript without executing it.
    const source = fs.readFileSync(file, "utf8").replace(/^#!.*\n/, "");
    assert.doesNotThrow(() => new Function(source), "syntax error in " + path.relative(root, file));
  });
});

test("Firefox variant swaps the service worker for an event page", () => {
  const ff = M.toFirefoxManifest(manifest);
  assert.deepEqual(ff.background, { scripts: ["background.js"] });
  assert.equal(ff.browser_specific_settings.gecko.id, M.GECKO_ID);
  assert.equal(ff.browser_specific_settings.gecko.strict_min_version, M.GECKO_MIN);
  assert.ok(ff.optional_permissions.includes("tabCapture"));
  assert.ok(ff.optional_permissions.includes("offscreen"));
  assert.match(ff.description, /Firefox build/);
  // Chrome manifest stays untouched.
  assert.equal(manifest.background.service_worker, "background.js");
});

test("Firefox variant keeps every referenced file present", () => {
  const ff = M.toFirefoxManifest(manifest);
  const problems = M.validateManifest(ff, exists).filter((p) => p.level === "error");
  assert.deepEqual(problems, []);
});

test("validateManifest catches a missing referenced file", () => {
  const problems = M.validateManifest(manifest, () => false);
  assert.ok(problems.some((p) => /missing file/.test(p.message)));
});

test("validateManifest reports a wrong manifest version", () => {
  const problems = M.validateManifest({ manifest_version: 2, name: "x", version: "1" }, () => true);
  assert.ok(problems.some((p) => /manifest_version must be 3/.test(p.message)));
});

test("referencedFiles lists background, popup, options, icons and content scripts", () => {
  const files = M.referencedFiles(manifest);
  ["background.js", "popup.html", "options.html", "content.js", "icons/icon16.png"].forEach((f) => {
    assert.ok(files.includes(f), "expected referenced file: " + f);
  });
});

test("options page makes no network request of its own", () => {
  const js = fs.readFileSync(path.join(root, "options.js"), "utf8");
  assert.doesNotMatch(js, /\bfetch\(/);
});

test("popup only fetches when the user files a report", () => {
  const js = fs.readFileSync(path.join(root, "popup.js"), "utf8");
  const outbound = [...js.matchAll(/await fetch\(payload\.url/g)];
  assert.equal(outbound.length, 1, "popup should have exactly one outbound fetch (filing)");
  // Any other fetch must be a local data: URL (clipboard copy of the screenshot).
  const otherFetches = [...js.matchAll(/await fetch\((?!payload\.url)[^)]+/g)].map((m) => m[0]);
  otherFetches.forEach((call) => assert.match(call, /screenshotDataUrl|data:/));
});

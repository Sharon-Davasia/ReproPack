/**
 * Unit tests for lib/triage.js — severity suggestion from evidence only.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/triage.js");

const checkoutEvidence = {
  url: "https://shop.test/checkout/payment",
  errors: [
    { type: "error", message: "TypeError: Cannot read properties of undefined", source: "app.js:42" }
  ],
  network: [{ url: "https://api.shop.test/pay", method: "POST", status: 500 }]
};

const quietEvidence = {
  url: "https://shop.test/about",
  errors: [],
  network: []
};

test("a blocked checkout with a page error and 5xx suggests Blocker", () => {
  const s = T.suggestSeverity(checkoutEvidence, { whatHappened: "Page went blank", frequency: "Always" });
  assert.equal(s.level.key, "blocker");
  assert.ok(s.confidence >= 0.6 && s.confidence <= 0.9);
});

test("reasons are tied to observable evidence", () => {
  const s = T.suggestSeverity(checkoutEvidence, {});
  const labels = s.reasons.map((r) => r.label).join(" | ");
  assert.match(labels, /Uncaught page error/);
  assert.match(labels, /5xx/);
  assert.match(labels, /critical flow page/);
  // Never a causal claim
  assert.doesNotMatch(labels, /because|caused by|root cause/i);
});

test("no evidence at all suggests a low-confidence Question", () => {
  const s = T.suggestSeverity(quietEvidence, {});
  assert.equal(s.level.key, "question");
  assert.ok(s.confidence <= 0.4);
  assert.equal(s.reasons.some((r) => r.weight < 0), true);
});

test("console-only noise is downgraded", () => {
  const s = T.suggestSeverity({
    url: "https://shop.test/about",
    errors: [{ type: "console.error", message: "Failed to load font" }],
    network: []
  }, {});
  assert.notEqual(s.level.key, "blocker");
  assert.equal(s.reasons.some((r) => /Only console output/.test(r.label)), true);
});

test("server error alone on a non-critical page is Major", () => {
  const s = T.suggestSeverity({
    url: "https://shop.test/about",
    errors: [],
    network: [{ url: "https://api.shop.test/stats", method: "GET", status: 503 }]
  }, {});
  assert.equal(s.level.key, "major");
});

test("a failed write request without a 5xx adds weight", () => {
  const s = T.suggestSeverity({
    url: "https://shop.test/about",
    errors: [],
    network: [{ url: "https://api.shop.test/save", method: "POST", status: 422 }]
  }, {});
  assert.equal(s.reasons.some((r) => /write request/.test(r.label)), true);
});

test("no-response requests are detected", () => {
  const s = T.suggestSeverity({
    url: "https://shop.test/",
    errors: [],
    network: [{ url: "https://api.shop.test/x", method: "GET", status: 0 }]
  }, {});
  assert.equal(s.reasons.some((r) => /no response/i.test(r.label)), true);
});

test("unhandled rejections count, but less than uncaught errors", () => {
  const rejection = T.suggestSeverity({ url: "https://x.test/", errors: [{ type: "unhandledrejection", message: "boom" }], network: [] }, {});
  const uncaught = T.suggestSeverity({ url: "https://x.test/", errors: [{ type: "error", message: "boom" }], network: [] }, {});
  assert.ok(uncaught.score > rejection.score);
});

test("caveat is always present and never diagnostic", () => {
  const s = T.suggestSeverity(checkoutEvidence, {});
  assert.match(s.caveat, /not a diagnosis/i);
  assert.match(s.caveat, /you choose/i);
});

test("suggestion is deterministic", () => {
  const a = T.suggestSeverity(checkoutEvidence, { frequency: "Always" });
  const b = T.suggestSeverity(checkoutEvidence, { frequency: "Always" });
  assert.deepEqual(a, b);
});

test("chipLabel summarises level and confidence", () => {
  const s = T.suggestSeverity(checkoutEvidence, {});
  assert.match(T.chipLabel(s), /^Suggested: (Blocker|Major|Minor|Question) · \d+% confident$/);
});

test("levelFor maps scores to levels", () => {
  assert.equal(T.levelFor(9).key, "blocker");
  assert.equal(T.levelFor(4).key, "major");
  assert.equal(T.levelFor(2).key, "minor");
  assert.equal(T.levelFor(0).key, "question");
});

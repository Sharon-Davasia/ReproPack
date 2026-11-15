/**
 * Unit tests for lib/report.js — run with `npm test` (node --test).
 * Core contract: organize evidence, never invent a cause.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/report.js");

const evidence = {
  url: "https://shop.example.com/checkout?session=abc123",
  title: "Checkout — Shop",
  capturedAt: "2026-11-15T10:00:00.000Z",
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0",
  viewport: "1440×900",
  referrer: "https://shop.example.com/cart",
  errors: [
    { type: "error", message: "Cannot read properties of undefined (reading 'total')", source: "app.js:42:7", time: "2026-11-15T10:00:01.000Z" },
    { type: "console.error", message: "Payment failed for user bob@example.com token=Bearer abcdef1234567890", source: "", time: "2026-11-15T10:00:02.000Z" }
  ],
  network: [{ url: "https://api.example.com/pay", status: 500, method: "POST", time: "2026-11-15T10:00:02.000Z" }],
  screenshotDataUrl: "data:image/png;base64,AAAA",
  screenshotName: "repropack-2026.png",
  pageInfo: { lang: "en", readyState: "complete", focusedElement: "button#pay" }
};

const form = {
  title: "Pay button crashes checkout",
  whatHappened: "Clicking Pay shows a blank page.",
  expected: "Payment should complete and show a confirmation.",
  steps: "Open checkout\nClick Pay now\nPage goes blank",
  severity: "Blocker — cannot proceed",
  frequency: "Always",
  account: "Free plan test user",
  notes: "Happens on desktop Chrome only."
};

test("generateReport includes title, URL, errors and steps", () => {
  const md = R.generateReport(evidence, form, {});
  assert.match(md, /# Bug: Pay button crashes checkout/);
  assert.match(md, /shop\.example\.com\/checkout/);
  assert.match(md, /Cannot read properties of undefined/);
  assert.match(md, /1\. Open checkout/);
  assert.match(md, /POST.*api\.example\.com\/pay.*500/);
  assert.match(md, /repropack-2026\.png/);
  assert.match(md, /organized, cause not invented/);
});

test("generateReport never invents a cause", () => {
  const md = R.generateReport(evidence, form, {});
  // No root-cause language should appear unless the user wrote it.
  assert.doesNotMatch(md, /root cause is/i);
  assert.doesNotMatch(md, /because the database/i);
  assert.doesNotMatch(md, /the bug is in/i);
});

test("stripQueryParams removes session tokens from URLs", () => {
  const md = R.generateReport(evidence, form, { stripQueryParams: true });
  assert.doesNotMatch(md, /session=abc123/);
  assert.match(md, /checkout/);
  assert.equal(R.stripQueryParams("https://x.com/a?b=1#frag"), "https://x.com/a");
});

test("redact masks emails and bearer tokens", () => {
  const md = R.generateReport(evidence, form, { redact: true });
  assert.doesNotMatch(md, /bob@example\.com/);
  assert.doesNotMatch(md, /abcdef1234567890/);
  assert.match(md, /\[EMAIL\]/);
  assert.match(md, /\[REDACTED\]/);
});

test("redact can be disabled", () => {
  const md = R.generateReport(evidence, form, { redact: false });
  assert.match(md, /bob@example\.com/);
});

test("detectMissing flags empty fields", () => {
  const missing = R.detectMissing({}, {});
  const keys = missing.map((m) => m.key);
  for (const k of ["title", "whatHappened", "expected", "steps", "screenshot", "url", "errors", "frequency", "severity", "account", "environment"]) {
    assert.ok(keys.includes(k), "expected missing key: " + k);
  }
});

test("detectMissing is empty when everything is filled", () => {
  const missing = R.detectMissing(evidence, form);
  assert.equal(missing.length, 0);
});

test("empty evidence still produces a usable skeleton report", () => {
  const md = R.generateReport({}, {}, {});
  assert.match(md, /# Bug: Bug report/);
  assert.match(md, /## Summary/);
  assert.match(md, /## Missing information/);
  assert.match(md, /- \[ \]/);
});

test("toJiraWiki converts headings and bold", () => {
  const out = R.toJiraWiki("# Bug: X\n## Summary\n**bold** and `code`");
  assert.match(out, /h1\. Bug: X/);
  assert.match(out, /h2\. Summary/);
  assert.match(out, /\*bold\*/);
  assert.match(out, /\{\{code\}\}/);
});

test("slugify produces safe filenames", () => {
  assert.equal(R.slugify("Pay button crashes! (v2)"), "pay-button-crashes-v2");
  assert.equal(R.slugify(""), "bug-report");
});

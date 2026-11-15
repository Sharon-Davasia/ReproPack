/**
 * Report integration tests for the v0.2 evidence sources:
 * recorded timeline, video clip, HAR-lite summary and the triage suggestion.
 * The core contract still holds: organize evidence, never invent a cause.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const R = require("../lib/report.js");
const Triage = require("../lib/triage.js");

const evidence = {
  url: "https://shop.test/checkout?session=abc123",
  title: "Checkout",
  capturedAt: "2026-11-15T10:00:00.000Z",
  userAgent: "Mozilla/5.0 Chrome/131.0",
  viewport: "1440×900",
  timelineStartedAt: "2026-11-15T10:00:00.000Z",
  timeline: [
    { t: "2026-11-15T10:00:00.000Z", kind: "start", label: "Recording started" },
    { t: "2026-11-15T10:00:01.200Z", kind: "click", label: "Clicked button#pay", detail: "Pay now" },
    { t: "2026-11-15T10:00:02.400Z", kind: "error", label: "Uncaught error", detail: "TypeError: boom" }
  ],
  errors: [{ type: "error", message: "TypeError: boom", source: "app.js:42", time: "2026-11-15T10:00:02.400Z" }],
  network: [
    { url: "https://api.shop.test/pay", method: "POST", status: 500, durationMs: 431 },
    { url: "https://api.shop.test/cart", method: "GET", status: 200, durationMs: 22 }
  ],
  clip: { name: "repropack-clip-2026.webm", durationMs: 4300 },
  harSummary: { total: 2, failed: 1 },
  screenshotDataUrl: "data:image/png;base64,AAAA",
  screenshotName: "shot.png",
  pageInfo: { lang: "en", readyState: "complete", focusedElement: "button#pay" }
};

const form = {
  title: "Pay button crashes checkout",
  whatHappened: "Clicking Pay shows a blank page.",
  expected: "Payment should complete.",
  steps: "Open checkout\nClick Pay now",
  severity: "Blocker — cannot proceed",
  frequency: "Always",
  account: "test user"
};

test("timeline is rendered with relative timestamps", () => {
  const md = R.generateReport(evidence, form, {});
  assert.match(md, /## Timeline \(recorded\)/);
  assert.match(md, /`T\+0\.0s` \*\*Recording started\*\*/);
  assert.match(md, /`T\+1\.2s` \*\*Clicked button#pay\*\* — Pay now/);
  assert.match(md, /Text typed into fields is \*\*not\*\* captured/);
});

test("timeline can be excluded", () => {
  const md = R.generateReport(evidence, form, { includeTimeline: false });
  assert.doesNotMatch(md, /## Timeline \(recorded\)/);
});

test("no timeline means an explicit note, not an invented one", () => {
  const md = R.generateReport({ ...evidence, timeline: [] }, form, {});
  assert.doesNotMatch(md, /## Timeline/);
});

test("clip and HAR-lite appear as attachments", () => {
  const md = R.generateReport(evidence, form, {});
  assert.match(md, /### Attachments/);
  assert.match(md, /repropack-clip-2026\.webm/);
  assert.match(md, /4\.3s/);
  assert.match(md, /HAR-lite:\*\* 2 request\(s\), 1 failed/);
  assert.match(md, /no bodies or headers/);
});

test("network section counts all requests but lists only failures", () => {
  const md = R.generateReport(evidence, form, {});
  assert.match(md, /### Network \(2 requests recorded, 1 failed\)/);
  assert.match(md, /`POST https:\/\/api\.shop\.test\/pay` → \*\*500\*\*/);
  assert.doesNotMatch(md, /api\.shop\.test\/cart\*\*/);
  assert.match(md, /1 other request\(s\) completed without an error status/);
});

test("triage suggestion is included only when provided", () => {
  const suggestion = Triage.suggestSeverity(evidence, form);
  const withTriage = R.generateReport(evidence, form, { triage: suggestion });
  assert.match(withTriage, /## Suggested severity \(heuristic\)/);
  assert.match(withTriage, /confidence \d+%/);
  assert.match(withTriage, /not a diagnosis/);
  assert.match(withTriage, /Uncaught page error/);

  const withoutTriage = R.generateReport(evidence, form, {});
  assert.doesNotMatch(withoutTriage, /## Suggested severity/);
});

test("triage never introduces causal language", () => {
  const suggestion = Triage.suggestSeverity(evidence, form);
  const md = R.generateReport(evidence, form, { triage: suggestion });
  assert.doesNotMatch(md, /root cause is/i);
  assert.doesNotMatch(md, /because the/i);
  assert.doesNotMatch(md, /fix is to/i);
});

test("redaction also applies to the timeline", () => {
  const leaky = {
    ...evidence,
    timeline: [{ t: "2026-11-15T10:00:01.000Z", kind: "console.error", label: "console.error", detail: "auth failed for bob@example.com Bearer abc123def456" }]
  };
  const md = R.generateReport(leaky, form, { redact: true });
  assert.doesNotMatch(md, /bob@example\.com/);
  assert.doesNotMatch(md, /abc123def456/);
});

test("timeline entries without a time field still render", () => {
  const md = R.generateReport({
    ...evidence,
    timeline: [{ kind: "click", label: "Clicked #go", offsetMs: 500 }]
  }, form, {});
  assert.match(md, /`T\+0\.5s` \*\*Clicked #go\*\*/);
});

test("timeline rendering caps long recordings", () => {
  const many = Array.from({ length: 90 }, (_, i) => ({
    t: new Date(Date.parse("2026-11-15T10:00:00.000Z") + i * 1000).toISOString(),
    kind: "click", label: "Click " + i
  }));
  const md = R.generateReport({ ...evidence, timeline: many }, form, { maxTimeline: 5 });
  assert.match(md, /more event\(s\) not shown/);
  assert.equal((md.match(/`T\+\d/g) || []).length >= 5, true);
});

test("detectMissing is unchanged by the new evidence fields", () => {
  assert.equal(R.detectMissing(evidence, form).length, 0);
});

/**
 * Unit tests for lib/timeline.js — recording normalization.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const T = require("../lib/timeline.js");

const raw = [
  { t: "2026-11-15T10:00:00.000Z", kind: "start", label: "Recording started" },
  { t: "2026-11-15T10:00:01.500Z", kind: "click", label: "Clicked button#pay", detail: "Pay now" },
  { t: "2026-11-15T10:00:02.250Z", kind: "nav", label: "Navigation", detail: "https://shop.test/thanks" },
  { t: "2026-11-15T10:00:03.000Z", kind: "error", label: "Uncaught error", detail: "TypeError: boom" }
];

test("relTime formats seconds and minutes", () => {
  assert.equal(T.relTime(0), "T+0.0s");
  assert.equal(T.relTime(1500), "T+1.5s");
  assert.equal(T.relTime(64000), "T+1m04s");
  assert.equal(T.relTime(-5), "T+0.0s");
});

test("normalize computes offsets relative to the first event", () => {
  const entries = T.normalize(raw);
  assert.equal(entries.length, 4);
  assert.equal(entries[0].offsetMs, 0);
  assert.equal(entries[1].offsetMs, 1500);
  assert.equal(entries[1].time, "T+1.5s");
  assert.equal(entries[3].offsetMs, 3000);
  assert.equal(entries[3].label, "Uncaught error");
});

test("normalize sorts out-of-order events and respects startedAt", () => {
  const shuffled = [raw[2], raw[0], raw[3], raw[1]];
  const entries = T.normalize(shuffled, { startedAt: "2026-11-15T10:00:00.000Z" });
  const offsets = entries.map((e) => e.offsetMs);
  assert.deepEqual(offsets, [0, 1500, 2250, 3000]);
});

test("normalize handles raw ms timestamps and missing fields", () => {
  const t0 = 1700000000000;
  const entries = T.normalize([
    { t: t0, kind: "click", selector: "button#go" },
    { t: t0 + 2000, type: "nav", url: "https://x.test/a" }
  ], { startedAt: t0 });
  assert.equal(entries[0].offsetMs, 0);
  assert.equal(entries[0].detail, "button#go");
  assert.equal(entries[1].kind, "nav");
  assert.equal(entries[1].detail, "https://x.test/a");
});

test("normalize collapses detail to a single line and truncates", () => {
  const long = "a".repeat(400);
  const entries = T.normalize([{ t: 1, kind: "click", detail: "line1\nline2   " + long }]);
  assert.ok(entries[0].detail.length <= 260);
  assert.doesNotMatch(entries[0].detail, /\n/);
});

test("normalize caps the number of entries", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ t: i * 100, kind: "click", label: "c" + i }));
  const entries = T.normalize(many, { max: 10 });
  assert.equal(entries.length, 10);
  // Keeps the most recent window.
  assert.equal(entries[9].label, "c49");
});

test("summarize counts each kind", () => {
  const entries = T.normalize(raw);
  const s = T.summarize(entries);
  assert.equal(s.total, 4);
  assert.equal(s.clicks, 1);
  assert.equal(s.navigations, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.durationMs, 3000);
  assert.match(T.summaryLine(entries), /1 click · 1 navigation · 1 error/);
});

test("formatMarkdown renders relative times and a privacy note", () => {
  const md = T.formatMarkdown(T.normalize(raw)).join("\n");
  assert.match(md, /`T\+0\.0s` \*\*Recording started\*\*/);
  assert.match(md, /Clicked button#pay/);
  assert.match(md, /Text typed into fields is intentionally \*\*not\*\* captured/);
});

test("formatMarkdown explains an empty timeline instead of inventing one", () => {
  const md = T.formatMarkdown([]).join("\n");
  assert.match(md, /No recording was taken/);
});

test("summaryLine is honest about an empty recording", () => {
  assert.equal(T.summaryLine([]), "No events recorded yet.");
});

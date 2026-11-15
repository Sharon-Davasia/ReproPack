/**
 * Unit tests for lib/har.js — HAR-lite export.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const H = require("../lib/har.js");

const network = [
  {
    url: "https://api.shop.test/pay?token=secret123&order=42",
    method: "post",
    status: 500,
    statusText: "Internal Server Error",
    time: "2026-11-15T10:00:02.000Z",
    durationMs: 431.4,
    mimeType: "application/json",
    size: 128,
    type: "fetch"
  },
  {
    url: "https://shop.test/assets/app.js",
    method: "GET",
    status: 200,
    time: "2026-11-15T10:00:03.000Z",
    durationMs: 12,
    mimeType: "text/javascript",
    type: "xhr"
  },
  {
    url: "https://api.shop.test/me",
    method: "GET",
    status: 0,
    time: "2026-11-15T10:00:01.000Z",
    durationMs: 3000,
    type: "fetch"
  }
];

test("buildHar produces a HAR 1.2 shaped object", () => {
  const har = H.buildHar(network, { pageUrl: "https://shop.test/checkout", pageTitle: "Checkout" });
  assert.equal(har.log.version, "1.2");
  assert.equal(har.log.creator.name, "ReproPack");
  assert.equal(har.log.entries.length, 3);
  assert.equal(har.log.pages.length, 1);

  const entry = har.log.entries[0];
  for (const key of ["startedDateTime", "time", "request", "response", "cache", "timings"]) {
    assert.ok(key in entry, "missing HAR key: " + key);
  }
  assert.deepEqual(Object.keys(entry.request).sort(), [
    "bodySize", "cookies", "headers", "headersSize", "httpVersion", "method", "queryString", "url"
  ].sort());
});

test("entries are sorted chronologically", () => {
  const har = H.buildHar(network, {});
  const times = har.log.entries.map((e) => new Date(e.startedDateTime).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test("status, duration and size are carried through", () => {
  const har = H.buildHar(network, {});
  const pay = har.log.entries.find((e) => e.request.url.includes("/pay"));
  assert.equal(pay.request.method, "POST");
  assert.equal(pay.response.status, 500);
  assert.equal(pay.response.statusText, "Internal Server Error");
  assert.equal(pay.time, 431.4);
  assert.equal(pay.response.content.size, 128);
  assert.equal(pay._repropack.failed, true);
  assert.equal(pay.pageref, undefined); // no page given
});

test("no-response requests are marked failed with an explanation", () => {
  const har = H.buildHar(network, {});
  const me = har.log.entries.find((e) => e.request.url.includes("/me"));
  assert.equal(me.response.status, 0);
  assert.match(me.response.statusText, /No response/);
  assert.equal(me._repropack.failed, true);
});

test("redaction removes query secrets by default", () => {
  const har = H.buildHar(network, {});
  const pay = har.log.entries.find((e) => e.request.url.includes("/pay"));
  assert.doesNotMatch(pay.request.url, /secret123/);
  assert.match(pay.request.url, /\[REDACTED\]/);
  assert.match(pay.request.url, /order=42/);
});

test("stripQueryParams drops query strings entirely", () => {
  const har = H.buildHar(network, { stripQueryParams: true });
  const pay = har.log.entries.find((e) => e.request.url.includes("/pay"));
  assert.equal(pay.request.url, "https://api.shop.test/pay");
  assert.equal(pay.request.queryString.length, 0);
});

test("redaction can be disabled", () => {
  const har = H.buildHar(network, { redact: false });
  const pay = har.log.entries.find((e) => e.request.url.includes("/pay"));
  assert.match(pay.request.url, /token=secret123/);
});

test("userinfo in URLs is redacted", () => {
  const har = H.buildHar([{ url: "https://user:pass@internal.test/a", method: "GET", status: 200 }], {});
  assert.doesNotMatch(har.log.entries[0].request.url, /pass/);
});

test("empty network still yields valid HAR", () => {
  const har = H.buildHar([], {});
  assert.equal(har.log.entries.length, 0);
  assert.equal(har.log.version, "1.2");
  assert.doesNotThrow(() => JSON.parse(H.toJson(har)));
});

test("toJson is pretty-printed and parseable", () => {
  const json = H.toJson(H.buildHar(network, {}));
  assert.match(json, /\n  "log"/);
  assert.equal(JSON.parse(json).log.entries.length, 3);
});

test("fileName is sanitised and host-based", () => {
  const name = H.fileName("https://api.shop.test:8443/x?y=1", "2026-11-15T10:00:00.000Z");
  assert.match(name, /^repropack-api\.shop\.test-2026-11-15T10-00-00\.har$/);
});

test("summary counts failures", () => {
  const s = H.summary(H.buildHar(network, {}));
  assert.equal(s.total, 3);
  assert.equal(s.failed, 2);
  assert.match(s.text, /3 request\(s\) recorded, 2 failed/);
});

test("isFailure understands explicit failed flag and 0 status", () => {
  assert.equal(H.isFailure({ failed: true }), true);
  assert.equal(H.isFailure({ status: 0 }), true);
  assert.equal(H.isFailure({ status: 404 }), true);
  assert.equal(H.isFailure({ status: 204 }), false);
  assert.equal(H.isFailure({}), false);
});

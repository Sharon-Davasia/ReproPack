/**
 * Unit tests for lib/dupes.js — duplicate detection.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const D = require("../lib/dupes.js");

const evA = {
  url: "https://shop.test/orders/12345?session=abc",
  errors: [{ type: "error", message: "TypeError: Cannot read properties of undefined (reading 'total') at app.js:42:7" }],
  network: [{ url: "https://api.shop.test/orders/12345/pay", method: "POST", status: 500 }]
};
const formA = { title: "Pay button crashes the checkout page" };

const evB = {
  url: "https://shop.test/orders/98765?session=zzz",
  errors: [{ type: "error", message: "TypeError: Cannot read properties of undefined (reading 'total') at app.js:99:3" }],
  network: [{ url: "https://api.shop.test/orders/98765/pay", method: "POST", status: 500 }]
};
const formB = { title: "Checkout page crashes when I press pay" };

const evC = {
  url: "https://shop.test/blog/hello-world",
  errors: [{ type: "console.error", message: "Failed to load font Inter" }],
  network: []
};
const formC = { title: "Blog font looks wrong" };

test("normalizeMessage drops ids, line numbers and quotes", () => {
  const a = D.normalizeMessage("TypeError: Cannot read 'total' at app.js:42:7 id=9f8e7d6c5b4a39281706");
  const b = D.normalizeMessage("TypeError: Cannot read 'total' at app.js:99:3 id=0123456789abcdef0123");
  assert.equal(a, b);
  assert.doesNotMatch(a, /42/);
});

test("urlTemplate collapses volatile segments but keeps query keys", () => {
  assert.equal(D.urlTemplate("https://shop.test/orders/12345?session=abc&x=1"), "shop.test/orders/:id?session&x");
  assert.equal(D.urlTemplate("https://shop.test/orders/9f8e7d6c-1111-2222-3333-444455556666"), "shop.test/orders/:id");
  assert.equal(D.urlTemplate("not a url"), "");
});

test("same bug with different ids yields the same fingerprint", () => {
  const a = D.fingerprint(evA, formA);
  const b = D.fingerprint(evB, formB);
  assert.equal(a.hash, b.hash);
  assert.deepEqual(a.messages, b.messages);
});

test("unrelated reports have different fingerprints", () => {
  const a = D.fingerprint(evA, formA);
  const c = D.fingerprint(evC, formC);
  assert.notEqual(a.hash, c.hash);
});

test("similarity of identical fingerprints is 1", () => {
  const a = D.fingerprint(evA, formA);
  const b = D.fingerprint(evB, formB);
  const sim = D.similarity(a, b);
  assert.equal(sim.score, 1);
  assert.match(sim.reasons[0], /Identical fingerprint/);
});

test("similarity of unrelated reports stays below the duplicate threshold", () => {
  const a = D.fingerprint(evA, formA);
  const c = D.fingerprint(evC, formC);
  assert.ok(D.similarity(a, c).score < 0.45);
});

test("same error text but different page still scores as a likely duplicate", () => {
  const a = D.fingerprint(evA, formA);
  const other = D.fingerprint({ ...evA, url: "https://shop.test/cart" }, { title: "Totally different words here" });
  const sim = D.similarity(a, other);
  assert.ok(sim.score >= 0.45);
  assert.equal(sim.reasons.some((r) => /Same error text/.test(r)), true);
});

test("findDuplicates ranks and filters history", () => {
  const current = D.fingerprint(evA, formA);
  const history = [
    { id: "1", title: "Pay button crashes the checkout page", savedAt: "2026-11-01T10:00:00Z", fingerprint: D.fingerprint(evB, formB) },
    { id: "2", title: "Blog font looks wrong", savedAt: "2026-11-02T10:00:00Z", fingerprint: D.fingerprint(evC, formC) },
    { id: "3", title: "No fingerprint", savedAt: "2026-11-03T10:00:00Z" }
  ];
  const dupes = D.findDuplicates(current, history);
  assert.equal(dupes.length, 1);
  assert.equal(dupes[0].id, "1");
  assert.ok(dupes[0].score >= 0.45);
  assert.ok(dupes[0].reasons.length > 0);
});

test("findDuplicates returns nothing for missing fingerprint or history", () => {
  assert.deepEqual(D.findDuplicates(null, [{ id: "1" }]), []);
  assert.deepEqual(D.findDuplicates(D.fingerprint(evA, formA), null), []);
  assert.deepEqual(D.findDuplicates({ hash: "x", messages: [], url: "", kinds: [], requestFailures: [], tokens: [] }, []), []);
});

test("fingerprint captures failure metadata for the report", () => {
  const fp = D.fingerprint(evA, formA);
  assert.equal(fp.errorCount, 1);
  assert.equal(fp.requestFailures_count, 1);
  assert.match(fp.requestFailures[0], /POST api\.shop\.test\/orders\/:id\/pay/);
  assert.ok(fp.tokens.includes("crash") || fp.tokens.includes("checkout"));
});

test("stableHash is stable and short", () => {
  assert.equal(D.stableHash("abc"), D.stableHash("abc"));
  assert.notEqual(D.stableHash("abc"), D.stableHash("abd"));
  assert.ok(D.stableHash("abc").length <= 8);
});

test("percent formats a score", () => {
  assert.equal(D.percent(0.876), "88%");
  assert.equal(D.percent(0), "0%");
});

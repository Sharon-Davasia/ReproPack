/**
 * Integration smoke tests: load the real popup.html / options.html in jsdom
 * with a stubbed chrome API and drive the actual UI.
 *
 * This catches the class of bug unit tests miss — a renamed element id, a
 * listener on a missing node, a handler that throws before it renders.
 *
 * jsdom is a devDependency; the tests are skipped (not failed) when it is not
 * installed, so `npm test` still works in a bare checkout.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

let JSDOM = null;
try { JSDOM = require("jsdom").JSDOM; } catch (e) { /* optional */ }

const root = path.join(__dirname, "..");
const skip = JSDOM ? false : "jsdom not installed (run: npm install)";

/** Inline local <script src> tags so jsdom never needs the network. */
function inlineScripts(file) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  return html.replace(/<script src="([^"]+)"><\/script>/g, (_m, src) => {
    const code = fs.readFileSync(path.join(root, path.dirname(file), src), "utf8");
    return "<script>\n" + code.replace(/<\/script>/g, "<\\/script>") + "\n</script>";
  });
}

function tick(ms) {
  return new Promise((r) => setTimeout(r, ms == null ? 30 : ms));
}

function makeChrome(store, respond, log) {
  return {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        log.messages.push(msg);
        const resp = respond ? respond(msg) : { ok: true };
        setTimeout(() => cb(resp), 0);
      },
      openOptionsPage() { log.openedOptions = true; },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          setTimeout(() => cb(out), 0);
        },
        set(obj, cb) {
          Object.assign(store, obj);
          setTimeout(() => cb && cb(), 0);
        }
      },
      onChanged: { addListener() {} }
    },
    tabs: {},
    downloads: {},
    action: {}
  };
}

function loadPage(file, opts) {
  opts = opts || {};
  const log = { messages: [], downloads: [], errors: [], clipboard: [] };
  const store = opts.store || {};
  const dom = new JSDOM(inlineScripts(file), {
    url: "https://repropack.test/" + file,
    runScripts: "dangerously",
    virtualConsole: new (require("jsdom").VirtualConsole)(),
    beforeParse(window) {
      window.chrome = makeChrome(store, opts.respond, log);
      window.confirm = () => true;
      window.alert = () => {};
      window.navigator.clipboard = { writeText: (t) => { log.clipboard.push(t); return Promise.resolve(); } };
      window.URL.createObjectURL = () => "blob:repropack";
      window.URL.revokeObjectURL = () => {};
      window.HTMLAnchorElement.prototype.click = function () { log.downloads.push(this.download || this.href); };
      if (opts.fetch) window.fetch = opts.fetch;
      window.addEventListener("error", (ev) => log.errors.push(ev.message || String(ev.error)));
      window.addEventListener("unhandledrejection", (ev) => log.errors.push("rejection: " + ev.reason));
    }
  });
  return { dom, window: dom.window, document: dom.window.document, log, store };
}

const EVIDENCE = {
  ok: true,
  evidence: {
    url: "https://shop.test/checkout?session=abc",
    title: "Checkout",
    capturedAt: "2026-11-15T10:00:00.000Z",
    userAgent: "Mozilla/5.0 Chrome/131.0",
    viewport: "1440×900",
    referrer: "",
    timelineStartedAt: "2026-11-15T10:00:00.000Z",
    timeline: [
      { t: "2026-11-15T10:00:00.000Z", kind: "start", label: "Recording started" },
      { t: "2026-11-15T10:00:01.000Z", kind: "click", label: "Clicked button#pay", detail: "Pay now" }
    ],
    errors: [
      { type: "error", message: "TypeError: boom", source: "app.js:42", time: "2026-11-15T10:00:01.500Z" },
      { type: "console.error", message: "payment failed for bob@example.com", source: "", time: "2026-11-15T10:00:01.600Z" }
    ],
    network: [
      { url: "https://api.shop.test/pay", method: "POST", status: 500, durationMs: 431, time: "2026-11-15T10:00:01.700Z" }
    ],
    pageInfo: { lang: "en", readyState: "complete", focusedElement: "button#pay" }
  }
};

function defaultRespond(msg) {
  switch (msg.type) {
    case "REPROPACK_GET_TAB_EVIDENCE": return EVIDENCE;
    case "REPROPACK_CAPTURE_SCREENSHOT": return { ok: true, dataUrl: "data:image/png;base64,AAAA" };
    case "REPROPACK_START_RECORDING":
    case "REPROPACK_STOP_RECORDING":
      return { ok: true, recording: msg.type === "REPROPACK_START_RECORDING", startedAt: "2026-11-15T10:00:00.000Z", entries: EVIDENCE.evidence.timeline };
    case "REPROPACK_GET_TIMELINE":
      return { ok: true, recording: false, startedAt: "2026-11-15T10:00:00.000Z", entries: EVIDENCE.evidence.timeline };
    case "REPROPACK_CLIP_STATE": return { ok: true, active: false };
    case "REPROPACK_CLEAR_BUFFER": return { ok: true };
    default: return { ok: true };
  }
}

test("popup boots without errors and shows its defaults", { skip }, async () => {
  const page = loadPage("popup.html", { respond: defaultRespond });
  await tick(60);

  assert.deepEqual(page.log.errors, [], "no runtime errors on load");
  assert.equal(page.document.getElementById("history-count").textContent, "0");
  assert.equal(page.document.getElementById("chk-redact").checked, true);
  assert.equal(page.document.getElementById("chk-include-timeline").checked, true);
  assert.match(page.document.getElementById("gen-note").textContent, /offline organizer/);
  page.window.close();
});

test("capture populates the evidence summary and error list", { skip }, async () => {
  const page = loadPage("popup.html", { respond: defaultRespond });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-capture").click();
  await tick(80);

  assert.equal(doc.getElementById("ev-url").textContent, "https://shop.test/checkout?session=abc");
  assert.equal(doc.getElementById("ev-errors").textContent, "2");
  assert.equal(doc.getElementById("ev-network").textContent, "1");
  assert.equal(doc.querySelectorAll("#errors-list li").length, 2);
  assert.equal(doc.getElementById("shot-wrap").classList.contains("hidden"), false);
  assert.equal(doc.getElementById("capture-status").textContent, "Captured ✓");
  assert.equal(doc.getElementById("f-title").value, "Checkout");
  assert.equal(doc.querySelectorAll("#timeline-list li").length, 2);
  assert.deepEqual(page.log.errors, []);
  page.window.close();
});

test("recording controls start, poll and stop the timeline", { skip }, async () => {
  const page = loadPage("popup.html", { respond: defaultRespond });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-record-start").click();
  await tick(60);
  assert.match(doc.getElementById("rec-status").textContent, /Recording/);
  assert.equal(doc.getElementById("btn-record-stop").disabled, false);

  doc.getElementById("btn-record-stop").click();
  await tick(60);
  assert.match(doc.getElementById("rec-status").textContent, /Stopped · 2 events/);
  assert.deepEqual(page.log.errors, []);
  page.window.close();
});

test("drafting steps from the recording writes editable steps", { skip }, async () => {
  const page = loadPage("popup.html", { respond: defaultRespond });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-timeline-refresh").click();
  await tick(60);
  doc.getElementById("btn-steps-from-timeline").click();
  await tick(20);

  const steps = doc.getElementById("f-steps").value;
  assert.match(steps, /^1\. Click button#pay/);
  assert.match(doc.getElementById("copy-feedback").textContent, /Drafted 1 step/);
  page.window.close();
});

test("generate produces a report, triage suggestion and duplicates", { skip }, async () => {
  const store = {
    repropack_history: [{
      id: "old1",
      title: "Pay button crashes the checkout page",
      url: "https://shop.test/checkout",
      savedAt: "2026-11-01T10:00:00.000Z",
      markdown: "# old report",
      fingerprint: {
        hash: "x",
        messages: ["typeerror: boom"],
        url: "shop.test/checkout?session",
        kinds: ["error"],
        requestFailures: ["POST api.shop.test/pay"],
        tokens: ["pay", "crashes", "checkout"],
        errorCount: 1,
        requestFailures_count: 1
      }
    }]
  };
  const page = loadPage("popup.html", { respond: defaultRespond, store });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-capture").click();
  await tick(80);
  doc.getElementById("f-title").value = "Pay button crashes checkout";
  doc.getElementById("f-what").value = "Clicking Pay shows a blank page.";
  doc.getElementById("f-expected").value = "Payment should complete.";
  doc.getElementById("f-steps").value = "Open checkout\nClick Pay";
  doc.getElementById("f-frequency").value = "Always";
  doc.getElementById("f-severity").value = "Blocker — cannot proceed";

  doc.getElementById("btn-generate").click();
  await tick(120);

  const md = doc.getElementById("report-out").value;
  assert.match(md, /# Bug: Pay button crashes checkout/);
  assert.match(md, /## Timeline \(recorded\)/);
  assert.match(md, /## Suggested severity \(heuristic\)/);
  assert.match(md, /## Missing information/);
  assert.match(md, /not a diagnosis/);
  assert.equal(doc.getElementById("tab-report").classList.contains("active"), true);
  assert.equal(doc.getElementById("triage-box").classList.contains("hidden"), false);
  assert.match(doc.getElementById("triage-reasons").textContent, /Uncaught page error/);
  // Duplicate detection against the saved report in storage.
  assert.equal(doc.getElementById("dupes-box").classList.contains("hidden"), false);
  assert.match(doc.getElementById("dupes-list").textContent, /Pay button crashes the checkout page/);
  assert.deepEqual(page.log.errors, []);
  page.window.close();
});

test("HAR-lite export downloads a .har file", { skip }, async () => {
  const page = loadPage("popup.html", { respond: defaultRespond });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-capture").click();
  await tick(80);
  doc.getElementById("btn-download-har").click();
  await tick(40);

  assert.equal(page.log.downloads.some((n) => /\.har$/.test(n)), true);
  assert.match(doc.getElementById("har-note").textContent, /1 request\(s\) recorded, 1 failed/);
  page.window.close();
});

test("saving a report stores it with a fingerprint", { skip }, async () => {
  const page = loadPage("popup.html", { respond: defaultRespond });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-capture").click();
  await tick(80);
  doc.getElementById("f-title").value = "Pay crashes";
  doc.getElementById("btn-generate").click();
  await tick(120);
  doc.getElementById("btn-save").click();
  await tick(80);

  const hist = page.store.repropack_history;
  assert.equal(hist.length, 1);
  assert.equal(hist[0].title, "Pay crashes");
  assert.ok(hist[0].fingerprint && hist[0].fingerprint.hash, "fingerprint stored for duplicate detection");
  assert.equal(doc.getElementById("history-count").textContent, "1");
  page.window.close();
});

test("filing validates config and sends a GitHub issue", { skip }, async () => {
  const calls = [];
  const page = loadPage("popup.html", {
    respond: defaultRespond,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 201, text: async () => JSON.stringify({ number: 7, html_url: "https://github.com/acme/web/issues/7" }) };
    }
  });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-capture").click();
  await tick(80);
  doc.getElementById("f-title").value = "Pay crashes";
  doc.getElementById("btn-generate").click();
  await tick(120);

  doc.querySelector('[data-tab="file"]').click();
  await tick(40);
  doc.getElementById("file-target").value = "github";
  doc.getElementById("file-target").dispatchEvent(new page.window.Event("change"));
  await tick(20);

  // Missing config → clear message, no request.
  doc.getElementById("btn-file").click();
  await tick(40);
  assert.match(doc.getElementById("file-status").textContent, /Still needed/);
  assert.equal(calls.length, 0);

  doc.getElementById("fg-token").value = "ghp_test";
  doc.getElementById("fg-repo").value = "acme/web";
  doc.getElementById("btn-save-filing").click();
  await tick(40);
  assert.equal(page.store.repropack_settings.filing.github.repo, "acme/web");
  assert.match(doc.getElementById("file-target-status").textContent, /Ready/);

  doc.getElementById("btn-file").click();
  await tick(120);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.github.com/repos/acme/web/issues");
  assert.equal(calls[0].init.headers.Authorization, "Bearer ghp_test");
  assert.match(JSON.parse(calls[0].init.body).body, /# Bug: Pay crashes/);
  assert.match(doc.getElementById("file-status").textContent, /Issue #7 created/);
  assert.equal(doc.getElementById("file-link").getAttribute("href"), "https://github.com/acme/web/issues/7");
  assert.equal(page.store.repropack_history.length, 1, "filed report is saved to history");
  assert.deepEqual(page.log.errors, []);
  page.window.close();
});

test("filing surfaces an actionable error for a bad token", { skip }, async () => {
  const page = loadPage("popup.html", {
    respond: defaultRespond,
    store: { repropack_settings: { filing: { github: { token: "bad", repo: "acme/web" } } } },
    fetch: async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: "Bad credentials" }) })
  });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-capture").click();
  await tick(80);
  doc.getElementById("btn-generate").click();
  await tick(120);
  doc.querySelector('[data-tab="file"]').click();
  await tick(40);

  doc.getElementById("btn-file").click();
  await tick(120);

  const status = doc.getElementById("file-status").textContent;
  assert.match(status, /Token rejected/);
  assert.match(status, /Bad credentials/);
  assert.equal(doc.getElementById("file-status").classList.contains("is-error"), true);
  page.window.close();
});

test("options page loads, saves and reflects capabilities", { skip }, async () => {
  const page = loadPage("options.html", { respond: defaultRespond });
  await tick(60);
  const doc = page.document;

  assert.deepEqual(page.log.errors, []);
  assert.equal(doc.getElementById("opt-redact").checked, true);
  assert.equal(doc.getElementById("opt-timeline").checked, true);
  assert.ok(doc.querySelectorAll("#caps .cap").length >= 5);

  doc.getElementById("opt-gh-repo").value = "acme/web";
  doc.getElementById("opt-gh-token").value = "ghp_x";
  doc.getElementById("opt-jira-project").value = "ENG";
  doc.getElementById("opt-slack-webhook").value = "https://hooks.slack.com/services/x";
  doc.getElementById("btn-save").click();
  await tick(80);

  const s = page.store.repropack_settings;
  assert.equal(s.filing.github.repo, "acme/web");
  assert.equal(s.filing.jira.projectKey, "ENG");
  assert.equal(s.filing.slack.webhookUrl, "https://hooks.slack.com/services/x");
  assert.equal(doc.getElementById("save-status").textContent, "Saved ✓");
  page.window.close();
});

test("demo page records interactions and generates a report", { skip }, async () => {
  const page = loadPage("demo/index.html", { respond: defaultRespond });
  await tick(40);
  const doc = page.document;

  doc.getElementById("btn-rec").click();
  doc.getElementById("demo-pay").click();
  doc.getElementById("demo-cart").click();
  await tick(20);
  assert.ok(doc.querySelectorAll("#tl li").length >= 3);

  doc.getElementById("btn-capture").click();
  await tick(20);
  doc.getElementById("btn-generate").click();
  await tick(40);

  const md = doc.getElementById("demo-out").value;
  assert.match(md, /## Timeline \(recorded\)/);
  assert.match(md, /Uncaught error/);
  assert.match(md, /## Suggested severity \(heuristic\)/);
  assert.match(md, /TypeError: Cannot read properties of undefined/);

  doc.getElementById("btn-save-hist").click();
  doc.getElementById("btn-generate").click();
  await tick(20);
  assert.equal(doc.getElementById("dupes").style.display, "block");

  doc.getElementById("btn-payload").click();
  await tick(20);
  assert.match(doc.getElementById("demo-out").value, /"method": "POST"/);
  page.window.close();
});

test("share page generates a report from a shared link", { skip }, async () => {
  const html = inlineScripts("share/index.html");
  const dom = new JSDOM(html, {
    url: "https://repropack.test/share/?title=Checkout&text=Pay%20does%20nothing&url=https%3A%2F%2Fshop.test%2Fcheckout",
    runScripts: "dangerously",
    virtualConsole: new (require("jsdom").VirtualConsole)(),
    beforeParse(window) {
      window.navigator.clipboard = { writeText: () => Promise.resolve() };
      window.URL.createObjectURL = () => "blob:x";
      window.addEventListener("error", (ev) => { throw new Error("share page error: " + ev.message); });
    }
  });
  await tick(40);
  const doc = dom.window.document;

  assert.equal(doc.getElementById("f-url").value, "https://shop.test/checkout");
  assert.equal(doc.getElementById("f-title").value, "Checkout");
  assert.equal(doc.getElementById("shared-box").style.display, "block");

  doc.getElementById("btn-generate").click();
  await tick(20);
  const out = doc.getElementById("out").value;
  assert.match(out, /# Bug: Checkout/);
  assert.match(out, /https:\/\/shop\.test\/checkout/);
  assert.match(out, /## Missing information/);
  dom.window.close();
});

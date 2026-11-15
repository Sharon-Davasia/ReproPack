/**
 * ReproPack content script — runs at document_start on every page.
 *
 * Two jobs:
 *  1. Buffer evidence: runtime errors, unhandled rejections, console.error,
 *     failed resource loads, and every fetch()/XHR request (metadata only).
 *  2. Record a timeline on request: clicks, navigations, submits, shortcut
 *     keys and the errors that happen between them, with millisecond offsets.
 *
 * It never sends data anywhere; it only answers messages from the extension.
 * Typed text is deliberately NOT recorded — only which key was pressed when
 * that key is a navigation/shortcut key.
 */
(function () {
  "use strict";

  var MAX_ERRORS = 60;
  var MAX_NETWORK = 120;
  var MAX_TIMELINE = 300;

  var SS_TIMELINE = "__repropack_tl_v1";
  var SS_NETWORK = "__repropack_net_v1";
  var SS_ERRORS = "__repropack_err_v1";
  var SS_REC = "__repropack_rec_v1";

  var buffer = [];
  var network = [];
  var timeline = [];
  var recording = false;
  var recStart = 0;

  // ------------------------------------------------------------ storage
  // sessionStorage survives reloads in the same tab, which matters a lot when
  // reproducing a bug. It is page-visible by design (no extension-only store is
  // available from a content script without extra permissions).

  function ssGet(key, fallback) {
    try {
      var raw = sessionStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      return val == null ? fallback : val;
    } catch (e) { return fallback; }
  }
  function ssSet(key, val) {
    try { sessionStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function ssDel(key) {
    try { sessionStorage.removeItem(key); } catch (e) {}
  }

  // ------------------------------------------------------------ buffers

  function pushError(entry) {
    entry.time = new Date().toISOString();
    buffer.push(entry);
    if (buffer.length > MAX_ERRORS) buffer.splice(0, buffer.length - MAX_ERRORS);
    if (recording) record("error", labelForError(entry), entry.message || "");
    persistErrors();
  }

  function persistErrors() {
    if (recording) ssSet(SS_ERRORS, buffer.slice(-MAX_ERRORS));
  }

  function labelForError(e) {
    var t = e && e.type ? String(e.type) : "error";
    if (t === "error") return "Uncaught error";
    if (t === "unhandledrejection") return "Unhandled rejection";
    if (t === "console.error") return "console.error";
    if (t === "resource") return "Resource failed to load";
    if (t === "network") return "Request failed";
    return t;
  }

  function pushNetwork(entry) {
    network.push(entry);
    if (network.length > MAX_NETWORK) network.splice(0, network.length - MAX_NETWORK);
    if (recording) {
      var s = Number(entry.status);
      if (s === 0 || s >= 400) {
        record("network", "Request failed", (entry.method || "GET") + " " + (entry.url || "") + " → " + (s === 0 ? "no response" : s));
      }
    }
    if (recording) ssSet(SS_NETWORK, network.slice(-MAX_NETWORK));
  }

  // ------------------------------------------------------------ timeline

  function record(kind, label, detail) {
    if (!recording) return;
    var now = Date.now();
    timeline.push({
      t: now,
      offsetMs: now - recStart,
      kind: kind,
      label: label || kind,
      detail: detail || ""
    });
    if (timeline.length > MAX_TIMELINE) timeline.splice(0, timeline.length - MAX_TIMELINE);
    ssSet(SS_TIMELINE, { start: recStart, entries: timeline.slice(-MAX_TIMELINE) });
  }

  function startRecording() {
    if (!recording) {
      recording = true;
      recStart = Date.now();
      timeline = [{ t: recStart, offsetMs: 0, kind: "start", label: "Recording started", detail: location.href }];
      ssSet(SS_REC, "1");
      ssSet(SS_TIMELINE, { start: recStart, entries: timeline });
      ssSet(SS_NETWORK, network.slice(-MAX_NETWORK));
      ssSet(SS_ERRORS, buffer.slice(-MAX_ERRORS));
    }
    return timelineState();
  }

  function stopRecording() {
    if (recording) {
      record("stop", "Recording stopped", "");
      recording = false;
      ssDel(SS_REC);
      ssSet(SS_TIMELINE, { start: recStart, entries: timeline.slice(-MAX_TIMELINE) });
    }
    return timelineState();
  }

  function timelineState() {
    return {
      ok: true,
      recording: recording,
      startedAt: recStart ? new Date(recStart).toISOString() : null,
      entries: timeline.slice(),
      pageUrl: location.href
    };
  }

  // Restore after a reload mid-recording.
  try {
    if (ssGet(SS_REC, "") === "1") {
      var saved = ssGet(SS_TIMELINE, null);
      if (saved && saved.start) {
        recording = true;
        recStart = saved.start;
        timeline = Array.isArray(saved.entries) ? saved.entries.slice() : [];
        network = ssGet(SS_NETWORK, []) || [];
        buffer = ssGet(SS_ERRORS, []) || [];
        record("nav", "Page reloaded while recording", location.href);
      }
    }
  } catch (e) {}

  // ------------------------------------------------------------ element description

  function describeElement(el) {
    if (!el || el.nodeType !== 1) return "";
    var tag = (el.tagName || "").toLowerCase();
    var out = tag;
    if (el.id) out += "#" + el.id;
    var testid = el.getAttribute && (el.getAttribute("data-testid") || el.getAttribute("data-test-id") || el.getAttribute("data-test"));
    var name = el.getAttribute && el.getAttribute("name");
    var role = el.getAttribute && el.getAttribute("role");
    var aria = el.getAttribute && el.getAttribute("aria-label");
    var type = el.getAttribute && el.getAttribute("type");
    if (name) out += "[name=" + name + "]";
    if (type && tag === "input") out += "[type=" + type + "]";
    if (role) out += "[role=" + role + "]";
    if (aria) out += " aria-label=\"" + oneLine(aria, 40) + "\"";
    if (testid) out += " (testid=" + testid + ")";
    var text = "";
    try {
      text = oneLine(el.innerText || el.textContent || el.value || "", 40);
    } catch (e) {}
    if (text && tag !== "input" && tag !== "textarea" && tag !== "select") out += " \"" + text + "\"";
    return out;
  }

  function oneLine(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  // ------------------------------------------------------------ error capture

  window.addEventListener("error", function (ev) {
    // Resource load failures (img/script/link) arrive with no message.
    if (!ev.message && ev.target && ev.target !== window) {
      var t = ev.target;
      var src = t.currentSrc || t.src || t.href || "";
      if (src) {
        pushError({ type: "resource", message: "Failed to load: " + src, source: src });
        return;
      }
    }
    pushError({
      type: "error",
      message: ev.message || "Unknown error",
      source: ev.filename ? ev.filename + ":" + (ev.lineno || "?") + ":" + (ev.colno || "?") : "",
      stack: ev.error && ev.error.stack ? String(ev.error.stack) : ""
    });
  }, true);

  window.addEventListener("unhandledrejection", function (ev) {
    var reason = ev.reason;
    var msg = reason && reason.message ? reason.message : String(reason || "Unhandled rejection");
    pushError({
      type: "unhandledrejection",
      message: msg,
      source: "",
      stack: reason && reason.stack ? String(reason.stack) : ""
    });
  });

  // Capture console.error without breaking the page.
  try {
    var origError = console.error.bind(console);
    console.error = function () {
      try {
        var parts = [];
        for (var i = 0; i < arguments.length; i++) {
          var a = arguments[i];
          parts.push(typeof a === "string" ? a : (a && a.message ? a.message : String(a)));
        }
        var text = parts.join(" ").trim();
        if (text) pushError({ type: "console.error", message: text.slice(0, 500), source: "" });
      } catch (e) {}
      return origError.apply(null, arguments);
    };
  } catch (e) {}

  // ------------------------------------------------------------ network capture

  var fetchWrapped = false;
  try {
    var origFetch = window.fetch;
    if (typeof origFetch === "function" && !window.__repropack_fetch_wrapped) {
      window.__repropack_fetch_wrapped = true;
      window.__repropack_fetch_wrapped_by_ext = true;
      fetchWrapped = true;
      window.fetch = function () {
        var args = arguments;
        var url = "";
        try { url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || ""; } catch (e) {}
        var method = "GET";
        try { method = (args[1] && args[1].method) || (args[0] && args[0].method) || "GET"; } catch (e) {}
        var startedAt = Date.now();
        var finished = function (status, extra) {
          pushNetwork(Object.assign({
            url: absolute(url),
            method: String(method).toUpperCase(),
            status: status,
            time: new Date(startedAt).toISOString(),
            durationMs: Date.now() - startedAt,
            type: "fetch"
          }, extra || {}));
        };
        return origFetch.apply(this, args).then(function (res) {
          try {
            finished(res ? res.status : 0, {
              statusText: res && res.statusText ? String(res.statusText).slice(0, 60) : "",
              mimeType: res && res.headers && res.headers.get ? (res.headers.get("content-type") || "") : "",
              size: res && res.headers && res.headers.get ? headerInt(res.headers.get("content-length")) : null
            });
          } catch (e) {}
          return res;
        }, function (err) {
          try { finished(0, { statusText: "fetch rejected: " + (err && err.message ? err.message : "unknown") }); } catch (e) {}
          throw err;
        });
      };
    }
  } catch (e) {}

  function headerInt(v) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }

  function absolute(u) {
    try { return new URL(String(u || ""), location.href).toString(); } catch (e) { return String(u || ""); }
  }

  // XHR capture (metadata only — response bodies are never read).
  if (!window.__repropack_xhr_wrapped) {
    window.__repropack_xhr_wrapped = true;
    try {
      var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (XP) {
        var origOpen = XP.open;
        var origSend = XP.send;
        XP.open = function (method, url) {
          try {
            this.__rp = { method: String(method || "GET").toUpperCase(), url: absolute(url), startedAt: Date.now() };
          } catch (e) {}
          return origOpen.apply(this, arguments);
        };
        XP.send = function () {
          var xhr = this;
          try {
            if (xhr.__rp) {
              xhr.addEventListener("loadend", function () {
                var meta = xhr.__rp || {};
                var status = 0;
                var text = "";
                var mime = "";
                try {
                  status = xhr.status;
                  text = xhr.statusText || "";
                  mime = xhr.getResponseHeader("content-type") || "";
                } catch (e) {}
                pushNetwork({
                  url: meta.url || "",
                  method: meta.method || "GET",
                  status: status,
                  statusText: text.slice(0, 60),
                  mimeType: mime,
                  time: new Date(meta.startedAt || Date.now()).toISOString(),
                  durationMs: Date.now() - (meta.startedAt || Date.now()),
                  type: "xhr"
                });
              });
            }
          } catch (e) {}
          return origSend.apply(this, arguments);
        };
      }
    } catch (e) {}
  }

  // ------------------------------------------------------------ interaction recording

  try {
    document.addEventListener("click", function (ev) {
      if (!recording) return;
      var el = ev.target;
      if (ev.isTrusted === false && el && el.closest && el.closest("[data-repropack]")) return;
      record("click", "Clicked " + (describeElement(el) || "element"), "");
    }, true);
  } catch (e) {}

  try {
    document.addEventListener("submit", function (ev) {
      if (!recording) return;
      var form = ev.target;
      var action = form && form.getAttribute ? (form.getAttribute("action") || "") : "";
      record("submit", "Submitted form" + (form && form.id ? "#" + form.id : ""), action || "(no action attribute)");
    }, true);
  } catch (e) {}

  try {
    document.addEventListener("keydown", function (ev) {
      if (!recording) return;
      var k = ev.key || "";
      var parts = [];
      if (ev.ctrlKey) parts.push("Ctrl");
      if (ev.metaKey) parts.push("Meta");
      if (ev.altKey) parts.push("Alt");
      if (ev.shiftKey && parts.length) parts.push("Shift");
      var isNavKey = /^(Enter|Tab|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|F5)$/.test(k);
      var isShortcut = parts.length > 0 && k.length === 1;
      if (!isNavKey && !isShortcut) return; // never record typed characters
      parts.push(k.length === 1 ? k.toUpperCase() : k);
      record("key", "Pressed " + parts.join("+"), "");
    }, true);
  } catch (e) {}

  try {
    document.addEventListener("visibilitychange", function () {
      if (!recording) return;
      record("visibility", "Tab became " + (document.hidden ? "hidden" : "visible"), "");
    }, true);
  } catch (e) {}

  // SPA navigation: patch history once, plus popstate/hashchange.
  try {
    if (!window.__repropack_history_wrapped) {
      window.__repropack_history_wrapped = true;
      ["pushState", "replaceState"].forEach(function (fn) {
        var orig = history[fn];
        if (typeof orig !== "function") return;
        history[fn] = function () {
          var res = orig.apply(this, arguments);
          try {
            if (recording) record("nav", fn === "pushState" ? "Navigated (pushState)" : "Navigated (replaceState)", location.href);
          } catch (e) {}
          return res;
        };
      });
      window.addEventListener("popstate", function () {
        if (recording) record("nav", "Navigated back/forward", location.href);
      });
      window.addEventListener("hashchange", function () {
        if (recording) record("nav", "Hash changed", location.href);
      });
    }
  } catch (e) {}

  // ------------------------------------------------------------ page info

  function snapshotPageInfo() {
    var focused = "";
    try {
      var el = document.activeElement;
      if (el && el !== document.body) {
        focused = (el.tagName || "").toLowerCase() + (el.id ? "#" + el.id : "") + (el.name ? "[name=" + el.name + "]" : "");
      }
    } catch (e) {}
    var bodyText = 0;
    try {
      bodyText = document.body ? String(document.body.innerText || document.body.textContent || "").trim().length : 0;
    } catch (e) {}
    var images = 0;
    try { images = document.images ? document.images.length : 0; } catch (e) {}
    return {
      lang: document.documentElement ? document.documentElement.lang || "" : "",
      readyState: document.readyState || "",
      focusedElement: focused,
      title: document.title || "",
      bodyTextLength: bodyText,
      imageCount: images,
      // A blank-looking page is an observation, not a diagnosis.
      blankLooking: bodyText < 25 && images === 0
    };
  }

  function getEvidence() {
    return {
      url: location.href,
      title: document.title || "",
      userAgent: navigator.userAgent || "",
      viewport: window.innerWidth + "×" + window.innerHeight,
      referrer: document.referrer || "",
      errors: buffer.slice(),
      network: network.slice(),
      timeline: timeline.slice(),
      timelineStartedAt: recStart ? new Date(recStart).toISOString() : null,
      timelineRecording: recording,
      pageInfo: snapshotPageInfo(),
      capturedAt: new Date().toISOString()
    };
  }

  // ------------------------------------------------------------ messaging

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type === "REPROPACK_GET_EVIDENCE") {
      sendResponse({ ok: true, evidence: getEvidence() });
      return true;
    }
    if (msg.type === "REPROPACK_START_RECORDING") {
      sendResponse(startRecording());
      return true;
    }
    if (msg.type === "REPROPACK_STOP_RECORDING") {
      sendResponse(stopRecording());
      return true;
    }
    if (msg.type === "REPROPACK_GET_TIMELINE") {
      sendResponse(timelineState());
      return true;
    }
    if (msg.type === "REPROPACK_ADD_NOTE") {
      if (recording) record("note", "User note", oneLine(msg.text || "", 200));
      sendResponse(timelineState());
      return true;
    }
    if (msg.type === "REPROPACK_CLEAR_BUFFER") {
      buffer.length = 0;
      network.length = 0;
      timeline.length = 0;
      recording = false;
      recStart = 0;
      ssDel(SS_TIMELINE); ssDel(SS_NETWORK); ssDel(SS_ERRORS); ssDel(SS_REC);
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "REPROPACK_PING") {
      sendResponse({ ok: true, recording: recording, fetchWrapped: fetchWrapped });
      return true;
    }
    return false;
  });
})();

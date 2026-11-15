/**
 * ReproPack — duplicate detection.
 *
 * Before you file, ReproPack checks the reports you already saved: same error
 * signature? same page? similar title? It surfaces "looks like these" with the
 * reasons — it never merges, deletes or auto-closes anything.
 *
 * Pure functions, deterministic, no crypto/browser APIs. Fingerprints are
 * built from normalized evidence so ids, timestamps and query params do not
 * make two copies of the same bug look different.
 */

(function (global) {
  "use strict";

  var STOPWORDS = ("the a an and or but if then than that this these those is are was were be been being " +
    "to of in on at for with without from by as it its it's i we you they he she my our your their " +
    "not no do does did doing have has had can could should would will just only also very really " +
    "when where while after before again there here what which who whom why how all any both each " +
    "more most other some such own same so too s t don now").split(/\s+/);

  var STOP = Object.create(null);
  STOPWORDS.forEach(function (w) { STOP[w] = true; });

  function stableHash(str) {
    var h = 5381;
    var s = String(str || "");
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    // unsigned + base36 keeps it short and stable across runs
    return (h >>> 0).toString(36);
  }

  /** Lowercase, drop volatile numbers/ids/hex, collapse whitespace. */
  function normalizeMessage(message) {
    var t = String(message == null ? "" : message).toLowerCase();
    t = t.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, "<uuid>");
    t = t.replace(/https?:\/\/[^\s'"<>)]+/g, function (m) { return guessHost(m) || "<url>"; });
    t = t.replace(/\b[0-9a-f]{16,}\b/g, "<hex>");           // long hashes / object ids
    t = t.replace(/\b\d+(?:\.\d+)?\b/g, "<n>");              // numbers / line numbers
    t = t.replace(/'[^']{0,80}'/g, "'<str>'");               // quoted literals
    t = t.replace(/"[^"]{0,80}"/g, '"<str>"');
    t = t.replace(/\s+/g, " ").trim();
    return t.slice(0, 240);
  }

  function guessHost(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ""; }
  }

  /**
   * Collapse a URL into a stable template: host + path with volatile segments
   * replaced by :id, plus the sorted set of query KEYS (values dropped).
   */
  function urlTemplate(url) {
    var u;
    try { u = new URL(String(url || "")); } catch (e) { return ""; }
    var segments = u.pathname.split("/").map(function (seg) {
      if (!seg) return "";
      if (/^\d+$/.test(seg)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ":id";
      if (/^[0-9a-f]{16,}$/i.test(seg)) return ":id";
      if (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /\d/.test(seg)) return ":id";
      return seg.toLowerCase();
    });
    var keys = [];
    u.searchParams.forEach(function (_v, k) { keys.push(k.toLowerCase()); });
    keys.sort();
    return u.hostname.toLowerCase() + segments.join("/") + (keys.length ? "?" + keys.join("&") : "");
  }

  function titleTokens(title) {
    return String(title == null ? "" : title)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/[\s-]+/)
      .filter(function (w) { return w && w.length > 2 && !STOP[w]; });
  }

  function unique(arr) {
    var seen = Object.create(null), out = [];
    arr.forEach(function (x) { if (x && !seen[x]) { seen[x] = 1; out.push(x); } });
    return out;
  }

  /**
   * Build a fingerprint from evidence + form.
   * { hash, messages: [], url: template, kinds: [], tokens: [], errorCount, requestFailures }
   */
  function fingerprint(evidence, form) {
    evidence = evidence || {};
    form = form || {};

    var messages = unique((evidence.errors || [])
      .filter(function (e) { return e && e.message; })
      .map(function (e) { return normalizeMessage(e.message); }))
      .slice(0, 6);

    var kinds = unique((evidence.errors || []).map(function (e) { return e && e.type ? e.type : "error" })).sort();

    var failed = (evidence.network || []).filter(function (n) {
      if (!n) return false;
      if (n.failed === true) return true;
      if (n.status == null) return false;
      var s = Number(n.status);
      return s === 0 || s >= 400;
    });
    var requestFailures = unique(failed.map(function (n) {
      return String(n.method || "GET").toUpperCase() + " " + urlTemplate(n.url || "");
    })).slice(0, 6);

    var tokens = unique(titleTokens(form.title)).sort();
    var tpl = urlTemplate(evidence.url || "");

    // The hash identifies the FAILURE SIGNATURE (error text + page pattern +
    // failing endpoints). Title wording is scored separately in similarity(),
    // so two reports of the same bug hash the same even if worded differently.
    var basis = [messages.join("|"), kinds.join(","), tpl, requestFailures.join("|")].join("::");

    return {
      hash: stableHash(basis),
      messages: messages,
      url: tpl,
      kinds: kinds,
      requestFailures: requestFailures,
      tokens: tokens,
      errorCount: (evidence.errors || []).length,
      requestFailures_count: failed.length
    };
  }

  function jaccard(a, b) {
    if (!a || !b || !a.length || !b.length) return 0;
    var setB = Object.create(null);
    b.forEach(function (x) { setB[x] = 1; });
    var inter = 0, union = new Set(a.concat(b));
    a.forEach(function (x) { if (setB[x]) inter++; });
    return inter / union.size;
  }

  /**
   * Compare two fingerprints.
   * → { score 0..1, reasons: [string] }
   */
  function similarity(a, b) {
    if (!a || !b) return { score: 0, reasons: [] };
    var reasons = [];
    var score = 0;

    var aSignal = (a.messages && a.messages.length) || (a.requestFailures && a.requestFailures.length);
    var bSignal = (b.messages && b.messages.length) || (b.requestFailures && b.requestFailures.length);
    if (a.hash && b.hash && a.hash === b.hash && aSignal && bSignal) {
      score = 1;
      reasons.push("Identical fingerprint (same error signature, page pattern and title)");
      return { score: 1, reasons: reasons };
    }

    // Same normalized error message is the strongest signal.
    var msgOverlap = jaccard(a.messages || [], b.messages || []);
    if (msgOverlap >= 0.5) {
      score += 0.55 * msgOverlap;
      reasons.push("Same error text (" + Math.round(msgOverlap * 100) + "% overlap)");
    } else if (msgOverlap > 0) {
      score += 0.25 * msgOverlap;
      reasons.push("Partially similar error text");
    }

    // Same page pattern (…/orders/:id).
    if (a.url && b.url && a.url === b.url) {
      score += 0.2;
      reasons.push("Same page pattern: " + a.url);
    }

    // Same failing endpoint + method.
    var reqOverlap = jaccard(a.requestFailures || [], b.requestFailures || []);
    if (reqOverlap > 0) {
      score += 0.15 * reqOverlap;
      reasons.push("Same failing request pattern");
    }

    // Similar title wording.
    var titleSim = jaccard(a.tokens || [], b.tokens || []);
    if (titleSim >= 0.5) {
      score += 0.12;
      reasons.push("Very similar title wording");
    } else if (titleSim >= 0.25) {
      score += 0.06;
      reasons.push("Some shared words in the title");
    }

    // Same error kind bucket (e.g. both unhandledrejection).
    if (a.kinds && b.kinds && a.kinds.length && b.kinds.length) {
      var sameKinds = a.kinds.every(function (k) { return b.kinds.indexOf(k) !== -1; });
      if (sameKinds) {
        score += 0.05;
        reasons.push("Same error kind(s): " + a.kinds.join(", "));
      }
    }

    return { score: Math.min(1, Math.round(score * 100) / 100), reasons: reasons };
  }

  /**
   * Find likely duplicates of `current` among previously saved reports.
   * history: [{ id, title, savedAt, fingerprint? }]
   * → [{ id, title, savedAt, score, reasons }] sorted, score >= threshold
   */
  function findDuplicates(current, history, threshold) {
    var min = typeof threshold === "number" ? threshold : 0.45;
    if (!current || !Array.isArray(history)) return [];
    var out = [];
    history.forEach(function (item) {
      if (!item || !item.fingerprint) return;
      var sim = similarity(current, item.fingerprint);
      if (sim.score >= min) {
        out.push({
          id: item.id,
          title: item.title || "Untitled report",
          savedAt: item.savedAt || "",
          score: sim.score,
          reasons: sim.reasons
        });
      }
    });
    out.sort(function (x, y) { return y.score - x.score; });
    return out.slice(0, 5);
  }

  function percent(score) {
    return Math.round((score || 0) * 100) + "%";
  }

  var api = {
    stableHash: stableHash,
    normalizeMessage: normalizeMessage,
    urlTemplate: urlTemplate,
    titleTokens: titleTokens,
    fingerprint: fingerprint,
    similarity: similarity,
    findDuplicates: findDuplicates,
    jaccard: jaccard,
    percent: percent
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackDupes = api;
})(typeof self !== "undefined" ? self : this);

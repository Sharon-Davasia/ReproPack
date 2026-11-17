/**
 * ReproPack — timeline normalization.
 *
 * Pure functions, no browser APIs. The content script records raw page
 * interactions (clicks, navigations, submits, key presses, errors, failed
 * requests) while the user records; this module turns that raw stream into
 * ordered, human-readable entries for the popup and the report.
 *
 * Rule: a timeline is EVIDENCE — it records what the user did and what the
 * page did. It never claims why something happened.
 */

(function (global) {
  "use strict";

  var KIND_LABELS = {
    start: "Recording started",
    stop: "Recording stopped",
    click: "Click",
    nav: "Navigation",
    submit: "Form submit",
    key: "Key press",
    error: "Error",
    network: "Failed request",
    visibility: "Tab visibility",
    focus: "Focus",
    note: "Note"
  };

  /** Parse an ISO timestamp or a number (ms since epoch / ms offset). */
  function toMs(t) {
    if (t == null || t === "") return NaN;
    if (typeof t === "number") return t;
    var n = Number(t);
    if (!isNaN(n) && String(t).trim() === String(n)) return n;
    var d = new Date(t);
    return d.getTime();
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  /** Human relative timestamp: T+0.4s, T+12.8s, T+1m04s. */
  function relTime(offsetMs) {
    var ms = Number(offsetMs);
    if (!isFinite(ms) || ms < 0) ms = 0;
    // Round to tenths first so 59.96s becomes T+1m00s, not "T+60.0s".
    var s = Math.round(ms / 100) / 10;
    if (s < 60) return "T+" + s.toFixed(1) + "s";
    var m = Math.floor(s / 60);
    var rest = Math.floor(s - m * 60);
    return "T+" + m + "m" + pad2(rest) + "s";
  }

  function oneLine(s, max) {
    var t = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    if (max && t.length > max) return t.slice(0, max - 1) + "…";
    return t;
  }

  /**
   * Normalize a raw event list into sorted entries.
   * raw: [{ t | time, kind | type, label?, detail?, url?, selector?, text? }]
   * opts: { startedAt (ISO), max (default 200) }
   */
  function normalize(raw, opts) {
    opts = opts || {};
    var list = Array.isArray(raw) ? raw.slice() : [];
    var max = opts.max || 200;

    // Establish t0: explicit start, else the first entry.
    var t0 = NaN;
    if (opts.startedAt != null) t0 = toMs(opts.startedAt);
    if (!isFinite(t0)) {
      for (var i = 0; i < list.length; i++) {
        var cand = toMs(list[i].t != null ? list[i].t : list[i].time);
        if (isFinite(cand)) { t0 = cand; break; }
      }
    }
    if (!isFinite(t0)) t0 = 0;

    var entries = [];
    list.forEach(function (e) {
      if (!e) return;
      var when = toMs(e.t != null ? e.t : e.time);
      var offset = isFinite(when) ? Math.max(0, when - t0) : 0;
      var kind = e.kind || e.type || "note";
      var label = e.label != null ? String(e.label) : (KIND_LABELS[kind] || kind);
      var detail = e.detail != null ? oneLine(e.detail, 260) : "";
      if (!detail) {
        detail = oneLine(e.text || e.url || e.selector || e.message || "", 260);
      }
      entries.push({
        t: isFinite(when) ? new Date(when).toISOString() : null,
        offsetMs: offset,
        time: relTime(offset),
        kind: kind,
        label: oneLine(label, 80),
        detail: detail
      });
    });

    entries.sort(function (a, b) { return a.offsetMs - b.offsetMs; });
    if (entries.length > max) entries = entries.slice(entries.length - max);
    return entries;
  }

  function summarize(entries) {
    var s = { total: 0, clicks: 0, navigations: 0, errors: 0, network: 0, submits: 0, keys: 0, durationMs: 0 };
    if (!Array.isArray(entries)) return s;
    s.total = entries.length;
    entries.forEach(function (e) {
      if (!e) return;
      if (e.kind === "click") s.clicks++;
      else if (e.kind === "nav") s.navigations++;
      else if (e.kind === "error") s.errors++;
      else if (e.kind === "network") s.network++;
      else if (e.kind === "submit") s.submits++;
      else if (e.kind === "key") s.keys++;
      if (e.offsetMs > s.durationMs) s.durationMs = e.offsetMs;
    });
    return s;
  }

  /** Compact one-line summary for the popup. */
  function summaryLine(entries) {
    var s = summarize(entries);
    if (!s.total) return "No events recorded yet.";
    var parts = [];
    if (s.clicks) parts.push(s.clicks + " click" + (s.clicks === 1 ? "" : "s"));
    if (s.navigations) parts.push(s.navigations + " navigation" + (s.navigations === 1 ? "" : "s"));
    if (s.errors) parts.push(s.errors + " error" + (s.errors === 1 ? "" : "s"));
    if (s.network) parts.push(s.network + " failed request" + (s.network === 1 ? "" : "s"));
    return parts.join(" · ") + " over " + relTime(s.durationMs).replace("T+", "");
  }

  /**
   * Markdown block for the report's Timeline section.
   * Returns an array of lines (no heading — the report adds it).
   */
  function formatMarkdown(entries, opts) {
    opts = opts || {};
    var max = opts.max || 60;
    var lines = [];
    if (!Array.isArray(entries) || !entries.length) {
      lines.push("_No recording was taken. Timeline unavailable._");
      return lines;
    }
    entries.slice(0, max).forEach(function (e) {
      var line = "- `" + e.time + "` **" + e.label + "**";
      if (e.detail) line += " — " + e.detail;
      lines.push(line);
    });
    if (entries.length > max) {
      lines.push("- _…" + (entries.length - max) + " more event(s) not shown._");
    }
    if (opts.note !== false) {
      lines.push("");
      lines.push("_Recorded from page events. Text typed into fields is intentionally **not** captured._");
    }
    return lines;
  }

  var api = {
    KIND_LABELS: KIND_LABELS,
    toMs: toMs,
    relTime: relTime,
    normalize: normalize,
    summarize: summarize,
    summaryLine: summaryLine,
    formatMarkdown: formatMarkdown
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackTimeline = api;
})(typeof self !== "undefined" ? self : this);

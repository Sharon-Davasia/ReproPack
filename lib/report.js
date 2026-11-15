/**
 * ReproPack — report generation library.
 * Pure functions, no browser APIs. Works in the extension popup,
 * in Node (tests), and in the demo page.
 *
 * Design rule: ORGANIZE evidence, never invent a cause.
 * Anything not present in the evidence is listed under
 * "Missing information" instead of being guessed.
 */

(function (global) {
  "use strict";

  // ---------------------------------------------------------------- helpers

  function esc(s) {
    return String(s == null ? "" : s).replace(/\r\n/g, "\n").trim();
  }

  function oneLine(s, max) {
    var t = esc(s).replace(/\s+/g, " ").trim();
    if (max && t.length > max) return t.slice(0, max - 1) + "…";
    return t;
  }

  function stripQueryParams(url) {
    try {
      var u = new URL(url);
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return url;
    }
  }

  /** Redact obvious secrets: bearer tokens, long hex/base64 blobs, emails. */
  function redact(text) {
    var t = String(text == null ? "" : text);
    t = t.replace(/Bearer\s+[A-Za-z0-9\-._~+/=]+/gi, "Bearer [REDACTED]");
    t = t.replace(/\b(api[_-]?key|token|secret|password|passwd|auth)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]");
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL]");
    // long opaque tokens (32+ chars, mixed case/digits) — conservative
    t = t.replace(/\b[A-Za-z0-9+/]{32,}={0,2}\b/g, function (m) {
      return /[0-9]/.test(m) && /[A-Za-z]/.test(m) ? "[REDACTED]" : m;
    });
    return t;
  }

  function formatWhen(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso || "");
      return d.toLocaleString(undefined, {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
    } catch (e) {
      return String(iso || "");
    }
  }

  function slugify(s) {
    return oneLine(s, 60).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "bug-report";
  }

  // ------------------------------------------------------- timeline rendering

  function relTime(offsetMs) {
    var ms = Number(offsetMs);
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = ms / 1000;
    if (s < 60) return "T+" + s.toFixed(1) + "s";
    var m = Math.floor(s / 60);
    var rest = Math.floor(s - m * 60);
    return "T+" + m + "m" + (rest < 10 ? "0" + rest : rest) + "s";
  }

  /**
   * Render recorded page events as Markdown lines.
   * Entries may come pre-normalized ({ offsetMs, time, label, detail }) or raw
   * ({ t, kind, label, detail }) — both are handled.
   */
  function renderTimeline(entries, opts) {
    opts = opts || {};
    var max = opts.max || 60;
    var list = Array.isArray(entries) ? entries.slice() : [];
    var lines = [];
    if (!list.length) {
      lines.push("_No recording was taken, so no interaction timeline is available._");
      return lines;
    }

    // Establish t0 when entries are raw timestamps.
    var t0 = NaN;
    if (opts.startedAt) {
      var d0 = new Date(opts.startedAt);
      if (!isNaN(d0.getTime())) t0 = d0.getTime();
    }
    if (!isFinite(t0)) {
      for (var i = 0; i < list.length; i++) {
        var cand = new Date(list[i].t).getTime();
        if (!isNaN(cand)) { t0 = cand; break; }
      }
    }
    if (!isFinite(t0)) t0 = 0;

    var norm = list.map(function (e) {
      var when = new Date(e.t).getTime();
      var offset = typeof e.offsetMs === "number" ? e.offsetMs : (isFinite(when) ? Math.max(0, when - t0) : 0);
      return {
        offset: offset,
        time: e.time || relTime(offset),
        label: oneLine(e.label || e.kind || "Event", 80),
        detail: oneLine(e.detail || "", 240)
      };
    }).sort(function (a, b) { return a.offset - b.offset; });

    norm.slice(0, max).forEach(function (e) {
      lines.push("- `" + e.time + "` **" + e.label + "**" + (e.detail ? " — " + e.detail : ""));
    });
    if (norm.length > max) lines.push("- _…" + (norm.length - max) + " more event(s) not shown._");
    lines.push("");
    lines.push("_Recorded from page events (clicks, navigations, submits, shortcut keys, errors). Text typed into fields is **not** captured._");
    return lines;
  }

  // ------------------------------------------------------- missing info

  /**
   * Inspect evidence + form fields and list what is still unknown.
   * Returns an array of { key, label, hint }.
   */
  function detectMissing(evidence, form) {
    evidence = evidence || {};
    form = form || {};
    var missing = [];

    function add(key, label, hint) {
      missing.push({ key: key, label: label, hint: hint || "" });
    }

    if (!esc(form.title)) add("title", "Bug title", "One line: what is broken, where.");
    if (!esc(form.whatHappened)) add("whatHappened", "What happened", "Describe what you saw, in your own words.");
    if (!esc(form.expected)) add("expected", "Expected behaviour", "What should have happened instead?");
    if (!esc(form.steps)) add("steps", "Reproduction steps", "Numbered steps from page load to the failure.");
    if (!evidence.screenshotDataUrl) add("screenshot", "Screenshot", "Capture the visible failure (or note why it can't be shared).");
    if (!evidence.url) add("url", "Page URL", "The exact page where it happens.");
    if (!evidence.errors || evidence.errors.length === 0) {
      add("errors", "Console / network errors", "None captured. If the page failed silently, say so explicitly.");
    }
    if (!esc(form.frequency)) add("frequency", "How often it happens", "Always / sometimes / once — and what seems to trigger it.");
    if (!esc(form.severity)) add("severity", "Severity / impact", "Who is blocked, and how badly?");
    if (!esc(form.account)) add("account", "Account / role / data used", "Which user, plan, or test data reproduces it?");
    if (!evidence.userAgent) add("environment", "Browser & OS", "Browser name/version and OS (captured automatically when you press Capture).");

    return missing;
  }

  // ------------------------------------------------------- report builder

  /**
   * Build a Markdown bug report from captured evidence + user form.
   *
   * evidence: {
   *   url, title, capturedAt, userAgent, viewport, referrer,
   *   errors: [{ type, message, source, time, stack? }],
   *   network: [{ url, status, method, time }],
   *   screenshotDataUrl, screenshotName,
   *   pageInfo: { lang, readyState, ... }
   * }
   * form: { title, whatHappened, expected, steps, severity, frequency, account, notes }
   * opts: { stripQueryParams, redact, includeScreenshotRef }
   */
  function generateReport(evidence, form, opts) {
    evidence = evidence || {};
    form = form || {};
    opts = opts || {};

    var doRedact = opts.redact !== false;
    var doStrip = !!opts.stripQueryParams;
    var R = function (s) { return doRedact ? redact(s) : String(s == null ? "" : s); };

    var url = evidence.url || "";
    if (doStrip && url) url = stripQueryParams(url);

    var title = oneLine(form.title) || oneLine(evidence.title) || "Bug report";
    var lines = [];

    lines.push("# Bug: " + title);
    lines.push("");
    lines.push("| Field | Value |");
    lines.push("|---|---|");
    lines.push("| **URL** | " + (url ? "<" + R(url) + ">" : "_not captured_") + " |");
    lines.push("| **Page title** | " + (evidence.title ? R(oneLine(evidence.title, 120)) : "_unknown_") + " |");
    lines.push("| **Captured** | " + formatWhen(evidence.capturedAt) + " |");
    lines.push("| **Browser** | " + (evidence.userAgent ? R(oneLine(evidence.userAgent, 160)) : "_unknown_") + " |");
    if (evidence.viewport) lines.push("| **Viewport** | " + R(evidence.viewport) + " |");
    if (evidence.referrer) lines.push("| **Referrer** | " + R(evidence.referrer) + " |");
    if (form.severity) lines.push("| **Severity** | " + R(oneLine(form.severity, 80)) + " |");
    if (form.frequency) lines.push("| **Frequency** | " + R(oneLine(form.frequency, 80)) + " |");
    if (form.account) lines.push("| **Account / role** | " + R(oneLine(form.account, 120)) + " |");
    lines.push("");

    if (evidence.screenshotDataUrl) {
      var name = evidence.screenshotName || "screenshot.png";
      lines.push("> 📎 **Screenshot:** attached as `" + name + "` — download it from ReproPack and attach it to the ticket.");
      lines.push("> (ReproPack does not embed the image inline so the report stays copy-paste friendly.)");
      lines.push("");
    } else {
      lines.push("> 📎 **Screenshot:** _not captured_");
      lines.push("");
    }

    lines.push("## Summary");
    lines.push("");
    lines.push(esc(form.whatHappened) ? R(esc(form.whatHappened)) : "_No description provided yet._");
    lines.push("");

    lines.push("## Expected vs Actual");
    lines.push("");
    lines.push("| | |");
    lines.push("|---|---|");
    lines.push("| **Expected** | " + (esc(form.expected) ? R(esc(form.expected).replace(/\n/g, " ")) : "_not stated_") + " |");
    lines.push("| **Actual** | " + (esc(form.whatHappened) ? R(esc(form.whatHappened).replace(/\n/g, " ")) : "_not stated_") + " |");
    lines.push("");

    lines.push("## Steps to reproduce");
    lines.push("");
    var steps = esc(form.steps);
    if (steps) {
      // Normalise to a numbered list if the user typed plain lines.
      var raw = steps.split("\n").map(function (l) { return l.trim(); }).filter(Boolean);
      var numbered = raw.some(function (l) { return /^\d+[.)]\s/.test(l); });
      if (numbered) {
        raw.forEach(function (l) { lines.push(l); });
      } else {
        raw.forEach(function (l, i) { lines.push((i + 1) + ". " + l); });
      }
    } else {
      lines.push("1. _Open the URL above._");
      lines.push("2. _Perform the action that triggers the failure._");
      lines.push("3. _Observe the result._");
    }
    lines.push("");

    if (evidence.timeline && evidence.timeline.length && opts.includeTimeline !== false) {
      lines.push("## Timeline (recorded)");
      lines.push("");
      renderTimeline(evidence.timeline, { max: opts.maxTimeline || 60, startedAt: evidence.timelineStartedAt })
        .forEach(function (l) { lines.push(R(l)); });
      lines.push("");
    }

    var extraAttachments = [];
    if (evidence.clip && evidence.clip.name) {
      var clipDur = Number(evidence.clip.durationMs) || 0;
      extraAttachments.push("🎬 **Video clip:** `" + R(evidence.clip.name) + "`" +
        (clipDur ? " (" + (clipDur / 1000).toFixed(1) + "s)" : "") +
        " — saved to your Downloads folder; attach it to the ticket.");
    }
    if (evidence.harSummary && evidence.harSummary.total) {
      extraAttachments.push("🌐 **HAR-lite:** " + Number(evidence.harSummary.total) + " request(s), " +
        Number(evidence.harSummary.failed || 0) + " failed — metadata only, no bodies or headers.");
    }

    lines.push("## Evidence");
    lines.push("");
    lines.push("### Console / runtime errors (" + ((evidence.errors || []).length) + ")");
    lines.push("");
    if (evidence.errors && evidence.errors.length) {
      evidence.errors.slice(0, 20).forEach(function (e, i) {
        var msg = R(oneLine(e.message || "(no message)", 300)) || "(no message)";
        var where = e.source ? " — `" + R(oneLine(e.source, 120)) + "`" : "";
        var when = e.time ? " · " + formatWhen(e.time) : "";
        lines.push((i + 1) + ". **" + R(oneLine(e.type || "error", 40)) + ":** " + msg + where + when);
        if (e.stack) {
          lines.push("   ```");
          R(String(e.stack)).split("\n").slice(0, 6).forEach(function (l) { lines.push("   " + l); });
          lines.push("   ```");
        }
      });
    } else {
      lines.push("_None captured. The page may have failed silently, or errors occurred before ReproPack was loaded._");
    }
    lines.push("");

    if (evidence.network && evidence.network.length) {
      var allRequests = evidence.network;
      var failedRequests = allRequests.filter(function (n) {
        if (!n) return false;
        if (n.failed === true) return true;
        if (n.status == null) return false;
        var s = Number(n.status);
        return s === 0 || s >= 400;
      });
      lines.push("### Network (" + allRequests.length + " request" + (allRequests.length === 1 ? "" : "s") + " recorded, " + failedRequests.length + " failed)");
      lines.push("");
      var shown = failedRequests.length ? failedRequests : [];
      if (shown.length) {
        shown.slice(0, 20).forEach(function (n) {
          var u = n.url || "";
          if (doStrip && u) u = stripQueryParams(u);
          var dur = typeof n.durationMs === "number" ? " · " + Math.round(n.durationMs) + " ms" : "";
          lines.push("- `" + R(oneLine(n.method || "GET", 10)) + " " + R(oneLine(u, 160)) + "` → **" + R(oneLine(String(n.status == null ? "failed" : n.status), 20)) + "**" + dur);
        });
      } else {
        lines.push("_No failed requests were recorded in this session._");
      }
      if (failedRequests.length < allRequests.length) {
        lines.push("");
        lines.push("_" + (allRequests.length - failedRequests.length) + " other request(s) completed without an error status and are not listed (available in the HAR-lite export). _");
      }
      lines.push("");
    }

    if (evidence.pageInfo) {
      lines.push("### Page info");
      lines.push("");
      lines.push("- Language: `" + R(oneLine(evidence.pageInfo.lang || "?", 20)) + "`");
      lines.push("- Ready state: `" + R(oneLine(evidence.pageInfo.readyState || "?", 20)) + "`");
      if (evidence.pageInfo.focusedElement) {
        lines.push("- Focused element: `" + R(oneLine(evidence.pageInfo.focusedElement, 120)) + "`");
      }
      lines.push("");
    }

    if (extraAttachments.length) {
      lines.push("### Attachments");
      lines.push("");
      extraAttachments.forEach(function (a) { lines.push("- " + a); });
      lines.push("");
    }

    // Optional: the heuristic severity suggestion, only when the caller passes
    // it in. It is presented as a suggestion with its evidence and a caveat —
    // never as a diagnosis, and the user's own severity always wins.
    var triage = opts.triage || evidence.triage;
    if (triage && triage.level && opts.includeTriage !== false) {
      lines.push("## Suggested severity (heuristic)");
      lines.push("");
      lines.push("**" + R(triage.level.label) + "** · confidence " + Math.round((triage.confidence || 0) * 100) + "%");
      lines.push("");
      (triage.reasons || []).forEach(function (r) {
        lines.push("- " + R(r.label) + (r.evidence ? " — `" + R(oneLine(r.evidence, 120)) + "`" : ""));
      });
      lines.push("");
      lines.push("_" + R(triage.caveat || "Heuristic from the captured evidence — not a diagnosis. The reporter's severity wins.") + "_");
      lines.push("");
    }

    var missing = detectMissing(evidence, form);
    lines.push("## Missing information");
    lines.push("");
    lines.push("_ReproPack will not guess these — please fill in what you can before filing:_");
    lines.push("");
    if (missing.length) {
      missing.forEach(function (m) {
        lines.push("- [ ] **" + m.label + "**" + (m.hint ? " — " + m.hint : ""));
      });
    } else {
      lines.push("- [x] Everything above is filled in. 🎉");
    }
    lines.push("");

    if (esc(form.notes)) {
      lines.push("## Notes");
      lines.push("");
      lines.push(R(esc(form.notes)));
      lines.push("");
    }

    lines.push("---");
    lines.push("_Generated with ReproPack — evidence organized, cause not invented._");

    return lines.join("\n");
  }

  /** Convert the Markdown report to a Jira-friendly plain-text variant. */
  function toJiraWiki(md) {
    return String(md || "")
      .replace(/^# (.*)$/gm, "h1. $1")
      .replace(/^## (.*)$/gm, "h2. $1")
      .replace(/^### (.*)$/gm, "h3. $1")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/`([^`]+)`/g, "{{$1}}");
  }

  var api = {
    generateReport: generateReport,
    detectMissing: detectMissing,
    stripQueryParams: stripQueryParams,
    redact: redact,
    slugify: slugify,
    formatWhen: formatWhen,
    toJiraWiki: toJiraWiki,
    renderTimeline: renderTimeline,
    relTime: relTime
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackReport = api;
})(typeof self !== "undefined" ? self : this);

/**
 * ReproPack — severity suggestion.
 *
 * Suggests a severity from OBSERVABLE signals only (errors present, request
 * statuses, which page it is, how often the user says It happens). It never
 * claims a cause and never overrides the human: the report keeps whatever the
 * user picks.
 *
 * Deterministic and pure so it can be unit tested.
 */

(function (global) {
  "use strict";

  var LEVELS = {
    blocker: { key: "blocker", label: "Blocker — cannot proceed", rank: 3 },
    major: { key: "major", label: "Major — workaround exists", rank: 2 },
    minor: { key: "minor", label: "Minor — cosmetic / edge case", rank: 1 },
    question: { key: "question", label: "Question — need clarification", rank: 0 }
  };

  // Path keywords that usually mean the failure blocks a core task.
  // (Matches the URL the user was on — evidence, not a diagnosis.)
  var CRITICAL_PATH = /(^|[/_.-])(checkout|payment|pay|billing|invoice|order|purchase|cart|login|signin|sign-in|signup|sign-up|register|auth|authn|password|reset|onboarding|upload|submit)([/_.-]|$)/i;

  function levelFor(score) {
    if (score >= 6) return LEVELS.blocker;
    if (score >= 3) return LEVELS.major;
    if (score >= 1) return LEVELS.minor;
    return LEVELS.question;
  }

  function isFailureStatus(status) {
    if (status == null) return false;
    var s = Number(status);
    return s === 0 || s >= 400;
  }

  function methodOf(entry) {
    return String((entry && entry.method) || "GET").toUpperCase();
  }

  function describeStatus(status) {
    var s = Number(status);
    if (s === 0) return "no response (blocked, offline, CORS or aborted)";
    if (s >= 500) return s + " server error";
    if (s === 429) return "429 rate limited";
    if (s >= 400) return s + " client error";
    return String(status);
  }

  /**
   * suggestSeverity(evidence, form) → {
   *   level: { key, label, rank }, score, confidence, reasons: [{ label, weight, evidence }],
   *   caveat
   * }
   */
  function suggestSeverity(evidence, form) {
    evidence = evidence || {};
    form = form || {};
    var reasons = [];
    var score = 0;

    function add(weight, label, evidenceText) {
      score += weight;
      reasons.push({ weight: weight, label: label, evidence: evidenceText || "" });
    }

    var errors = (evidence.errors || []).filter(function (e) { return e && e.type !== "network"; });
    var requests = evidence.network || [];
    var failures = requests.filter(function (n) { return isFailureStatus(n.status); });
    var serverErrors = failures.filter(function (n) { return Number(n.status) >= 500; });
    var noResponse = failures.filter(function (n) { return Number(n.status) === 0; });
    var writeFailures = failures.filter(function (n) { return /^(POST|PUT|PATCH|DELETE)$/.test(methodOf(n)); });
    var hardErrors = errors.filter(function (e) { return e.type === "error"; });
    var rejections = errors.filter(function (e) { return e.type === "unhandledrejection"; });
    var consoleOnly = errors.length > 0 && hardErrors.length === 0 && rejections.length === 0;

    if (hardErrors.length) {
      add(3, "Uncaught page error was recorded", hardErrors[0].message || "");
    }
    if (rejections.length) {
      add(2, "Unhandled promise rejection was recorded", rejections[0].message || "");
    }
    if (serverErrors.length) {
      add(3, "Server returned 5xx to the page", describeStatus(serverErrors[0].status) + " · " + (serverErrors[0].url || ""));
    }
    if (noResponse.length) {
      add(2, "A request received no response at all", describeStatus(0) + " · " + (noResponse[0].url || ""));
    }
    if (writeFailures.length && !serverErrors.length) {
      add(2, "A write request (POST/PUT/PATCH/DELETE) failed", methodOf(writeFailures[0]) + " " + (writeFailures[0].url || "") + " → " + describeStatus(writeFailures[0].status));
    }
    if (errors.length >= 4) {
      add(1, "Several distinct errors were recorded", errors.length + " error entries");
    }

    var url = String(evidence.url || "");
    var path = url.split("?")[0];
    var critical = CRITICAL_PATH.exec(path);
    if (critical) {
      add(2, "The failure happened on a critical flow page", "“" + (critical[2] || critical[0]) + "” in the URL path");
    }

    if (/blank|white screen|frozen|unresponsive/i.test(String(form.whatHappened || ""))) {
      add(1, "Your description mentions a blank or frozen page", "");
    }
    if (/^always$/i.test(String(form.frequency || ""))) {
      add(1, "You reported it happens every time", "Frequency: Always");
    }
    if (consoleOnly) {
      add(-1, "Only console output was recorded (no page error, no failed request)", "");
    }
    if (!errors.length && !failures.length) {
      add(-1, "No errors or failed requests were captured", "");
    }

    var level = levelFor(Math.max(0, score));
    var confidence = Math.min(0.9, 0.34 + Math.max(0, score) * 0.07);
    if (!errors.length && !failures.length) confidence = Math.min(confidence, 0.4);

    return {
      level: level,
      score: score,
      confidence: Math.round(confidence * 100) / 100,
      reasons: reasons.sort(function (a, b) { return b.weight - a.weight; }),
      caveat: "Heuristic from the captured evidence — not a diagnosis. The severity you choose wins."
    };
  }

  /** One-line chip label for the popup. */
  function chipLabel(suggestion) {
    if (!suggestion || !suggestion.level) return "";
    var pct = Math.round((suggestion.confidence || 0) * 100);
    return "Suggested: " + suggestion.level.label.split(" — ")[0] + " · " + pct + "% confident";
  }

  var api = {
    LEVELS: LEVELS,
    suggestSeverity: suggestSeverity,
    chipLabel: chipLabel,
    isFailureStatus: isFailureStatus,
    levelFor: levelFor
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackTriage = api;
})(typeof self !== "undefined" ? self : this);

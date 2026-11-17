/**
 * ReproPack — HAR-lite export.
 *
 * Builds a HAR 1.2-shaped object from the network entries the content script
 * recorded. It is deliberately "lite":
 *   • no request/response bodies (we never capture them),
 *   • no cookies,
 *   • no headers (we do not read them),
 *   • timings are a single wait value, marked as approximate.
 * What it does keep: URL, method, status, status text, mime type, size,
 * start time, duration and whether ReproPack saw it fail.
 *
 * Pure functions, no browser APIs — usable in the popup, the service worker,
 * the demo page and Node tests.
 */

(function (global) {
  "use strict";

  var HAR_VERSION = "1.2";
  var CREATOR = { name: "ReproPack", version: "0.2.0", comment: "HAR-lite: metadata only, no bodies or headers." };

  function stripQueryParams(url) {
    try {
      var u = new URL(url);
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return String(url || "");
    }
  }

  function redactUrl(url) {
    var t = String(url == null ? "" : url);
    t = t.replace(/([?&](?:token|access_token|refresh_token|id_token|api[_-]?key|apikey|key|secret|client_secret|password|session|sessionid|auth|code|sig|signature|jwt)=)[^&#]*/gi, "$1[REDACTED]");
    t = t.replace(/\/\/[^/@\s]+:[^/@\s]+@/g, "//[REDACTED]@"); // user:pass@host
    return t;
  }

  function splitQuery(url) {
    var out = [];
    try {
      var u = new URL(url);
      u.searchParams.forEach(function (value, name) {
        out.push({ name: name, value: value });
      });
    } catch (e) { /* not an absolute URL — leave queryString empty */ }
    return out;
  }

  function statusTextFor(status, entry) {
    if (entry && entry.statusText) return String(entry.statusText);
    if (status === 0) return "No response (blocked / offline / CORS / aborted)";
    var known = {
      400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
      405: "Method Not Allowed", 408: "Request Timeout", 409: "Conflict",
      422: "Unprocessable Entity", 429: "Too Many Requests",
      500: "Internal Server Error", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout"
    };
    return known[status] || "";
  }

  function isoOrNull(t) {
    var d = new Date(t);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function isFailure(entry) {
    if (!entry) return false;
    if (entry.failed === true) return true;
    var s = entry.status;
    if (s == null) return false;
    return s === 0 || Number(s) >= 400;
  }

  /**
   * Build the HAR object.
   * network: [{ url, method, status, time (ISO), durationMs, statusText, mimeType, size, type }]
   * opts: { redact (default true), stripQueryParams (default false), pageUrl, pageTitle, startedAt }
   */
  function buildHar(network, opts) {
    opts = opts || {};
    var doRedact = opts.redact !== false;
    var doStrip = !!opts.stripQueryParams;
    var list = Array.isArray(network) ? network : [];

    var entries = list.map(function (n) {
      n = n || {};
      var rawUrl = n.url || "";
      var clean = doStrip ? stripQueryParams(rawUrl) : rawUrl;
      if (doRedact) clean = redactUrl(clean);

      var status = n.status == null ? 0 : Number(n.status);
      var duration = Number(n.durationMs);
      if (!isFinite(duration) || duration < 0) duration = 0;
      var started = isoOrNull(n.time || n.startedDateTime) || isoOrNull(opts.startedAt) || new Date(0).toISOString();
      var method = String(n.method || "GET").toUpperCase();
      // `clean` was already redacted as a whole URL, so values here are safe.
      var query = doStrip ? [] : splitQuery(clean);

      return {
        startedDateTime: started,
        time: Math.round(duration * 100) / 100,
        request: {
          method: method,
          url: clean,
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          queryString: query,
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: status,
          statusText: statusTextFor(status, n),
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          content: {
            size: typeof n.size === "number" ? n.size : -1,
            mimeType: n.mimeType || "",
            comment: "Body not captured by ReproPack."
          },
          redirectURL: "",
          headersSize: -1,
          bodySize: typeof n.size === "number" ? n.size : -1
        },
        cache: {},
        timings: { send: 0, wait: Math.round(duration * 100) / 100, receive: 0, comment: "Approximate: total request duration only." },
        _repropack: {
          failed: isFailure(n),
          resourceType: n.type || (n.method ? "fetch/xhr" : ""),
          note: "HAR-lite entry. No bodies or headers were recorded."
        }
      };
    });

    // Sort chronologically so the waterfall makes sense.
    entries.sort(function (a, b) {
      return new Date(a.startedDateTime).getTime() - new Date(b.startedDateTime).getTime();
    });

    var pages = [];
    if (opts.pageUrl || opts.pageTitle) {
      var pageUrl = doStrip ? stripQueryParams(opts.pageUrl || "") : (opts.pageUrl || "");
      if (doRedact) pageUrl = redactUrl(pageUrl);
      pages.push({
        startedDateTime: isoOrNull(opts.startedAt) || (entries[0] ? entries[0].startedDateTime : new Date(0).toISOString()),
        id: "page_1",
        title: opts.pageTitle || "",
        pageTimings: { onContentLoad: -1, onLoad: -1 }
      });
      entries.forEach(function (e) {
        e.pageref = "page_1";
      });
    }

    var failures = entries.filter(function (e) { return e._repropack.failed; }).length;

    return {
      log: {
        version: HAR_VERSION,
        creator: CREATOR,
        comment: "ReproPack HAR-lite — " + entries.length + " request(s), " + failures + " failed. Metadata only; no bodies or headers are recorded.",
        pages: pages,
        entries: entries
      }
    };
  }

  /** Pretty JSON string, ready for a .har download. */
  function toJson(har) {
    return JSON.stringify(har || buildHar([]), null, 2);
  }

  function fileName(pageUrl, when) {
    var host = "session";
    try { host = new URL(pageUrl).hostname.replace(/[^a-z0-9.-]/gi, "-") || "session"; } catch (e) {}
    var stamp = new Date(when || Date.now()).toISOString()
      .replace(/[:.]/g, "-")
      .replace("Z", "")
      .replace(/-\d{3}$/, "");
    return "repropack-" + host + "-" + stamp + ".har";
  }

  /** Short human summary used in the report and the popup. */
  function summary(har) {
    var entries = (har && har.log && har.log.entries) || [];
    var failed = entries.filter(function (e) { return e._repropack && e._repropack.failed; }).length;
    return { total: entries.length, failed: failed, text: entries.length + " request(s) recorded, " + failed + " failed" };
  }

  var api = {
    HAR_VERSION: HAR_VERSION,
    buildHar: buildHar,
    toJson: toJson,
    fileName: fileName,
    summary: summary,
    isFailure: isFailure,
    redactUrl: redactUrl,
    stripQueryParams: stripQueryParams,
    splitQuery: splitQuery,
    statusTextFor: statusTextFor
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackHar = api;
})(typeof self !== "undefined" ? self : this);

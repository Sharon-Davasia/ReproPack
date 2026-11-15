/**
 * ReproPack options — AI organizer, file destinations, privacy defaults,
 * browser capabilities and local data management.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };

  var DEFAULTS = {
    provider: "openai", apiKey: "", model: "", baseUrl: "", useAI: false,
    stripQueryParams: false, redact: true, includeScreenshot: true,
    includeTimeline: true, maxClipSeconds: 60,
    filing: {
      github: { token: "", repo: "", labels: "", assignees: "", apiBase: "" },
      jira: { baseUrl: "", email: "", token: "", projectKey: "", issueType: "Bug", priority: "", labels: "", deployment: "cloud" },
      slack: { webhookUrl: "" },
      webhook: { url: "", token: "" }
    },
    lastTarget: "github"
  };

  var FIELDS = {
    github: [["opt-gh-token", "token"], ["opt-gh-repo", "repo"], ["opt-gh-labels", "labels"], ["opt-gh-assignees", "assignees"], ["opt-gh-apibase", "apiBase"]],
    jira: [["opt-jira-baseurl", "baseUrl"], ["opt-jira-email", "email"], ["opt-jira-token", "token"], ["opt-jira-project", "projectKey"], ["opt-jira-type", "issueType"], ["opt-jira-priority", "priority"], ["opt-jira-labels", "labels"], ["opt-jira-deployment", "deployment"]],
    slack: [["opt-slack-webhook", "webhookUrl"]],
    webhook: [["opt-hook-url", "url"], ["opt-hook-token", "token"]]
  };

  function deepMerge(base, extra) {
    var out = JSON.parse(JSON.stringify(base));
    if (!extra) return out;
    Object.keys(extra).forEach(function (k) {
      if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k])) out[k] = deepMerge(out[k] || {}, extra[k]);
      else out[k] = extra[k];
    });
    return out;
  }

  function get(keys) { return new Promise(function (r) { chrome.storage.local.get(keys, function (v) { r(v || {}); }); }); }
  function set(obj) { return new Promise(function (r) { chrome.storage.local.set(obj, function () { r(); }); }); }

  function load() {
    return get(["repropack_settings"]).then(function (res) {
      var s = deepMerge(DEFAULTS, res.repropack_settings || {});
      $("opt-use-ai").checked = !!s.useAI;
      $("opt-provider").value = s.provider || "openai";
      $("opt-key").value = s.apiKey || "";
      $("opt-model").value = s.model || "";
      $("opt-baseurl").value = s.baseUrl || "";
      $("opt-strip").checked = !!s.stripQueryParams;
      $("opt-redact").checked = s.redact !== false;
      $("opt-shot").checked = s.includeScreenshot !== false;
      $("opt-timeline").checked = s.includeTimeline !== false;
      $("opt-maxclip").value = String(s.maxClipSeconds || 60);

      Object.keys(FIELDS).forEach(function (target) {
        var cfg = (s.filing || {})[target] || {};
        FIELDS[target].forEach(function (pair) {
          var el = $(pair[0]);
          if (el) el.value = cfg[pair[1]] || "";
        });
      });

      toggleBaseUrl();
      return s;
    });
  }

  function toggleBaseUrl() {
    var isOpenAI = $("opt-provider").value === "openai";
    $("field-baseurl").style.display = isOpenAI ? "" : "none";
  }
  $("opt-provider").addEventListener("change", toggleBaseUrl);

  function save() {
    var filing = {};
    Object.keys(FIELDS).forEach(function (target) {
      filing[target] = {};
      FIELDS[target].forEach(function (pair) {
        var el = $(pair[0]);
        filing[target][pair[1]] = el ? String(el.value || "").trim() : "";
      });
    });
    if (!filing.jira.issueType) filing.jira.issueType = "Bug";
    if (!filing.jira.deployment) filing.jira.deployment = "cloud";

    var s = {
      useAI: $("opt-use-ai").checked,
      provider: $("opt-provider").value,
      apiKey: $("opt-key").value.trim(),
      model: $("opt-model").value.trim(),
      baseUrl: $("opt-baseurl").value.trim(),
      stripQueryParams: $("opt-strip").checked,
      redact: $("opt-redact").checked,
      includeScreenshot: $("opt-shot").checked,
      includeTimeline: $("opt-timeline").checked,
      maxClipSeconds: Math.max(5, Math.min(Number($("opt-maxclip").value) || 60, 120)),
      filing: filing
    };

    return get(["repropack_settings"]).then(function (res) {
      var merged = Object.assign({}, res.repropack_settings || {}, s);
      return set({ repropack_settings: merged });
    }).then(function () {
      var el = $("save-status");
      el.textContent = "Saved ✓";
      setTimeout(function () { el.textContent = ""; }, 2500);
    });
  }

  $("btn-save").addEventListener("click", save);

  // ------------------------------------------------------------ capabilities

  function renderCapabilities() {
    var isFirefox = typeof browser !== "undefined" && !!browser.runtime && !!browser.runtime.getBrowserInfo;
    var caps = [
      ["Screenshot capture", !!(chrome.tabs && chrome.tabs.captureVisibleTab)],
      ["Timeline recording", !!(chrome.tabs && chrome.tabs.sendMessage)],
      ["Video clips (tabCapture + offscreen)", !!(chrome.tabCapture && chrome.offscreen)],
      ["Downloads", !!(chrome.downloads && chrome.downloads.download)],
      ["System share sheet", typeof navigator !== "undefined" && !!navigator.share],
      ["Built-in AI (no keys)", typeof window !== "undefined" && !!(window.ai || (navigator && navigator.ai))]
    ];
    var host = $("caps");
    host.innerHTML = "";
    caps.forEach(function (pair) {
      var row = document.createElement("div");
      row.className = "cap";
      var name = document.createElement("span");
      name.textContent = pair[0];
      var yes = document.createElement("span");
      yes.className = pair[1] ? "yes" : "no";
      yes.textContent = pair[1] ? "available ✓" : "not available";
      row.appendChild(name);
      row.appendChild(yes);
      host.appendChild(row);
    });
    var notes = [];
    if (isFirefox) notes.push("Firefox: video clips are unavailable (no offscreen API) — use screenshot capture, the timeline and HAR-lite.");
    if (!(chrome.tabCapture && chrome.offscreen)) notes.push("This browser cannot record clips. Everything else still works.");
    $("caps-note").textContent = notes.join(" ");
  }

  // ------------------------------------------------------------ data

  function renderHistoryInfo() {
    get(["repropack_history"]).then(function (res) {
      var hist = res.repropack_history || [];
      $("history-info").textContent = hist.length
        ? hist.length + " saved report(s) · newest " + (hist[0] && hist[0].savedAt ? new Date(hist[0].savedAt).toLocaleString() : "—")
        : "No saved reports yet.";
    });
  }

  $("btn-export").addEventListener("click", function () {
    get(["repropack_history", "repropack_settings"]).then(function (res) {
      var payload = {
        source: "repropack",
        exportedAt: new Date().toISOString(),
        reports: res.repropack_history || []
      };
      var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "repropack-reports-" + new Date().toISOString().slice(0, 10) + ".json";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
      $("save-status").textContent = "Exported " + payload.reports.length + " report(s) ✓";
      setTimeout(function () { $("save-status").textContent = ""; }, 2500);
    });
  });

  $("btn-import").addEventListener("click", function () { $("import-file").click(); });

  $("import-file").addEventListener("change", function (ev) {
    var file = ev.target.files && ev.target.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = JSON.parse(String(reader.result || "")); } catch (e) {
        $("save-status").textContent = "That file is not valid JSON.";
        return;
      }
      var incoming = Array.isArray(parsed) ? parsed : parsed.reports;
      if (!Array.isArray(incoming)) {
        $("save-status").textContent = "No reports found in that file.";
        return;
      }
      get(["repropack_history"]).then(function (res) {
        var existing = res.repropack_history || [];
        var seen = {};
        existing.forEach(function (r) { seen[r.id] = 1; });
        var merged = existing.concat(incoming.filter(function (r) { return r && r.id && !seen[r.id]; })).slice(0, 50);
        return set({ repropack_history: merged });
      }).then(function () {
        renderHistoryInfo();
        $("save-status").textContent = "Imported ✓";
        setTimeout(function () { $("save-status").textContent = ""; }, 2500);
      });
    };
    reader.readAsText(file);
    ev.target.value = "";
  });

  $("btn-clear").addEventListener("click", function () {
    if (!confirm("Delete all saved reports? Export first if you need them.")) return;
    set({ repropack_history: [] }).then(function () {
      renderHistoryInfo();
      $("save-status").textContent = "History cleared.";
      setTimeout(function () { $("save-status").textContent = ""; }, 2500);
    });
  });

  load().then(function () {
    renderCapabilities();
    renderHistoryInfo();
  });
})();

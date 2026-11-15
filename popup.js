/**
 * ReproPack popup — capture → record → describe → generate → file.
 * Everything runs locally; the only outbound calls are the ones you press.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var Report = window.ReproPackReport;
  var Timeline = window.ReproPackTimeline;
  var Har = window.ReproPackHar;
  var Triage = window.ReproPackTriage;
  var Dupes = window.ReproPackDupes;
  var Filing = window.ReproPackFiling;

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

  var state = {
    evidence: null,
    timeline: [],
    recording: false,
    recordingStartedAt: null,
    timelineStartedAt: null,
    screenshotDataUrl: null,
    screenshotName: "",
    clip: null,
    settings: JSON.parse(JSON.stringify(DEFAULTS)),
    excludedErrors: {},
    reportMd: "",
    triage: null,
    dupes: [],
    pollTimer: null,
    clipTimer: null,
    clipStartedAt: 0,
    filingDirty: false
  };

  // ------------------------------------------------------------ plumbing

  function sendMessage(msg) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(msg, function (resp) {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false, error: "No response" });
        });
      } catch (e) {
        resolve({ ok: false, error: e && e.message ? e.message : String(e) });
      }
    });
  }

  function storageGet(keys) {
    return new Promise(function (resolve) { chrome.storage.local.get(keys, function (res) { resolve(res || {}); }); });
  }
  function storageSet(obj) {
    return new Promise(function (resolve) { chrome.storage.local.set(obj, function () { resolve(); }); });
  }

  function deepMerge(base, extra) {
    var out = JSON.parse(JSON.stringify(base));
    if (!extra) return out;
    Object.keys(extra).forEach(function (k) {
      if (extra[k] && typeof extra[k] === "object" && !Array.isArray(extra[k])) {
        out[k] = deepMerge(out[k] || {}, extra[k]);
      } else {
        out[k] = extra[k];
      }
    });
    return out;
  }

  function feedback(msg, ms) {
    var el = $("copy-feedback");
    if (!el) return;
    el.textContent = msg;
    clearTimeout(feedback._t);
    feedback._t = setTimeout(function () { if (el.textContent === msg) el.textContent = ""; }, ms || 4200);
  }

  function fileStatus(msg, isError) {
    var el = $("file-status");
    el.textContent = msg;
    el.classList.toggle("is-error", !!isError);
  }

  // ------------------------------------------------------------ tabs

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.getAttribute("data-tab") === name);
    });
    document.querySelectorAll(".panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "tab-" + name);
    });
    if (name === "history") renderHistory();
    if (name === "file") { loadFilingForm(); renderFilingStatus(); }
    if (name === "report") { renderDuplicates(); $("report-out").focus(); }
  }
  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () { switchTab(t.getAttribute("data-tab")); });
  });
  $("btn-history").addEventListener("click", function () { switchTab("history"); });
  $("btn-options").addEventListener("click", function () {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });

  // ------------------------------------------------------------ settings

  async function loadSettings() {
    var res = await storageGet(["repropack_settings"]);
    state.settings = deepMerge(DEFAULTS, res.repropack_settings || {});
    applySettingsToUI();
  }

  function applySettingsToUI() {
    var s = state.settings;
    $("chk-strip").checked = !!s.stripQueryParams;
    $("chk-redact").checked = s.redact !== false;
    $("chk-include-shot").checked = s.includeScreenshot !== false;
    $("chk-include-timeline").checked = s.includeTimeline !== false;
    $("ai-badge").classList.toggle("hidden", !s.useAI);
    $("gen-note").textContent = s.useAI
      ? "AI organizer is ON (evidence-only prompt). Your key stays in this browser."
      : "Uses the offline organizer. Enable AI in ⚙️ Options for wording polish (still evidence-only).";
  }

  function persistSettings() {
    state.settings.stripQueryParams = $("chk-strip").checked;
    state.settings.redact = $("chk-redact").checked;
    state.settings.includeScreenshot = $("chk-include-shot").checked;
    state.settings.includeTimeline = $("chk-include-timeline").checked;
    return storageSet({ repropack_settings: state.settings });
  }
  ["chk-strip", "chk-redact", "chk-include-shot", "chk-include-timeline"].forEach(function (id) {
    $(id).addEventListener("change", persistSettings);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area === "local" && changes.repropack_settings) {
      state.settings = deepMerge(DEFAULTS, changes.repropack_settings.newValue || {});
      applySettingsToUI();
    }
  });

  // ------------------------------------------------------------ capture

  function setStatus(el, text, ok) {
    el.textContent = text;
    el.classList.toggle("ok", !!ok);
  }

  $("btn-capture").addEventListener("click", async function () {
    var btn = $("btn-capture");
    btn.disabled = true;
    btn.textContent = "Capturing…";
    setStatus($("capture-status"), "Capturing…", false);

    var evResp = await sendMessage({ type: "REPROPACK_GET_TAB_EVIDENCE" });
    var shotResp = await sendMessage({ type: "REPROPACK_CAPTURE_SCREENSHOT" });

    btn.disabled = false;
    btn.textContent = "📸 Capture evidence";

    if (!evResp.ok) {
      setStatus($("capture-status"), "Capture failed: " + (evResp.error || "unknown"), false);
      return;
    }

    state.evidence = evResp.evidence || {};
    state.excludedErrors = {};
    state.timeline = Array.isArray(state.evidence.timeline) ? state.evidence.timeline.slice() : [];
    if (shotResp.ok) {
      state.screenshotDataUrl = shotResp.dataUrl;
      state.screenshotName = "repropack-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
    } else {
      state.screenshotDataUrl = null;
      state.screenshotName = "";
    }

    renderEvidence();
    renderTimeline();
    setStatus($("capture-status"), "Captured ✓", true);
    $("btn-clear").disabled = false;

    if (!$("f-title").value && state.evidence.title) $("f-title").value = state.evidence.title;

    var limitations = state.evidence.limitations || [];
    if (state.evidence.note) limitations = limitations.concat([state.evidence.note]);
    if (limitations.length) setStatus($("capture-status"), "Captured with limits", true);

    if (state.recording) startPolling();
  });

  $("btn-clear").addEventListener("click", async function () {
    await sendMessage({ type: "REPROPACK_CLEAR_BUFFER" });
    state.evidence = null;
    state.timeline = [];
    state.screenshotDataUrl = null;
    state.screenshotName = "";
    state.reportMd = "";
    state.triage = null;
    state.dupes = [];
    state.recording = false;
    state.timelineStartedAt = null;
    stopPolling();
    $("evidence-summary").classList.add("hidden");
    $("shot-wrap").classList.add("hidden");
    $("errors-wrap").classList.add("hidden");
    $("timeline-list").classList.add("hidden");
    $("timeline-empty").classList.remove("hidden");
    $("triage-box").classList.add("hidden");
    $("dupes-box").classList.add("hidden");
    $("report-out").value = "";
    setStatus($("capture-status"), "Not captured yet", false);
    setStatus($("rec-status"), "Not recording", false);
    $("btn-clear").disabled = true;
    $("btn-record-start").disabled = false;
    $("btn-record-stop").disabled = true;
  });

  function renderEvidence() {
    var ev = state.evidence;
    if (!ev) return;
    $("evidence-summary").classList.remove("hidden");
    $("ev-url").textContent = ev.url || "—";
    $("ev-errors").textContent = String((ev.errors || []).length);
    $("ev-network").textContent = String((ev.network || []).length);
    $("ev-timeline").textContent = (state.timeline.length || 0) + " events";
    $("ev-shot").textContent = state.screenshotDataUrl ? "✓ captured" : "✗ not available";

    if (state.screenshotDataUrl) {
      $("shot-wrap").classList.remove("hidden");
      $("shot-img").src = state.screenshotDataUrl;
    } else {
      $("shot-wrap").classList.add("hidden");
    }

    var list = $("errors-list");
    list.innerHTML = "";
    var errs = ev.errors || [];
    if (errs.length) {
      $("errors-wrap").classList.remove("hidden");
      errs.forEach(function (e, i) {
        var li = document.createElement("li");
        var chk = document.createElement("input");
        chk.type = "checkbox";
        chk.checked = true;
        chk.setAttribute("aria-label", "Include this error");
        chk.addEventListener("change", function () { state.excludedErrors[i] = !chk.checked; });
        var tag = document.createElement("span");
        tag.className = "etype";
        tag.textContent = e.type || "error";
        var code = document.createElement("code");
        code.textContent = (e.message || "(no message)") + (e.source ? "  ·  " + e.source : "");
        li.appendChild(chk);
        li.appendChild(tag);
        li.appendChild(code);
        list.appendChild(li);
      });
    } else {
      $("errors-wrap").classList.add("hidden");
    }
  }

  $("btn-download-shot").addEventListener("click", function () {
    if (!state.screenshotDataUrl) return;
    var a = document.createElement("a");
    a.href = state.screenshotDataUrl;
    a.download = state.screenshotName || "screenshot.png";
    a.click();
  });

  $("btn-copy-shot").addEventListener("click", async function () {
    if (!state.screenshotDataUrl) return;
    try {
      var blob = await (await fetch(state.screenshotDataUrl)).blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      feedback("Screenshot copied to clipboard ✓");
    } catch (e) {
      feedback("Copy image not supported here — use Download PNG instead.");
    }
  });

  // ------------------------------------------------------------ timeline recording

  function renderTimeline() {
    var entries = state.timeline || [];
    var list = $("timeline-list");
    list.innerHTML = "";

    if (!entries.length) {
      list.classList.add("hidden");
      $("timeline-empty").classList.remove("hidden");
      $("ev-timeline").textContent = "0 events";
      return;
    }

    var normalized = Timeline.normalize(entries, { startedAt: state.recordingStartedAt });
    list.classList.remove("hidden");
    $("timeline-empty").classList.add("hidden");
    $("ev-timeline").textContent = normalized.length + " events";

    normalized.slice(-40).forEach(function (e) {
      var li = document.createElement("li");
      li.className = "tl-item tl-" + String(e.kind || "note").replace(/[^a-z]/gi, "");
      var t = document.createElement("span");
      t.className = "tl-time";
      t.textContent = e.time;
      var k = document.createElement("span");
      k.className = "tl-kind";
      k.textContent = e.label;
      li.appendChild(t);
      li.appendChild(k);
      if (e.detail) {
        var d = document.createElement("code");
        d.textContent = e.detail;
        li.appendChild(d);
      }
      list.appendChild(li);
    });
    list.scrollTop = list.scrollHeight;
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(async function () {
      var resp = await sendMessage({ type: "REPROPACK_GET_TIMELINE" });
      if (!resp || !resp.ok) { stopPolling(); return; }
      state.recording = !!resp.recording;
      if (resp.startedAt) { state.recordingStartedAt = resp.startedAt; state.timelineStartedAt = resp.startedAt; }
      state.timeline = resp.entries || [];
      renderTimeline();
      if (!state.recording) {
        stopPolling();
        $("btn-record-start").disabled = false;
        $("btn-record-stop").disabled = true;
        setStatus($("rec-status"), "Stopped · " + state.timeline.length + " events", true);
      }
    }, 1000);
  }
  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  $("btn-record-start").addEventListener("click", async function () {
    var resp = await sendMessage({ type: "REPROPACK_START_RECORDING" });
    if (!resp.ok) {
      setStatus($("rec-status"), resp.error || "Cannot record this page", false);
      return;
    }
    state.recording = true;
    state.recordingStartedAt = resp.startedAt || new Date().toISOString();
    state.timelineStartedAt = state.recordingStartedAt;
    state.timeline = resp.entries || [];
    $("btn-record-start").disabled = true;
    $("btn-record-stop").disabled = false;
    setStatus($("rec-status"), "● Recording — use the page now", true);
    renderTimeline();
    startPolling();
  });

  $("btn-record-stop").addEventListener("click", async function () {
    var resp = await sendMessage({ type: "REPROPACK_STOP_RECORDING" });
    stopPolling();
    state.recording = false;
    $("btn-record-start").disabled = false;
    $("btn-record-stop").disabled = true;
    if (resp.ok) {
      state.timeline = resp.entries || state.timeline;
      if (resp.startedAt) state.timelineStartedAt = resp.startedAt;
      renderTimeline();
      setStatus($("rec-status"), "Stopped · " + state.timeline.length + " events", true);
    } else {
      setStatus($("rec-status"), resp.error || "Stop failed", false);
    }
  });

  $("btn-timeline-refresh").addEventListener("click", async function () {
    var resp = await sendMessage({ type: "REPROPACK_GET_TIMELINE" });
    if (!resp.ok) { setStatus($("rec-status"), resp.error || "No timeline on this page", false); return; }
    state.recording = !!resp.recording;
    if (resp.startedAt) { state.recordingStartedAt = resp.startedAt; state.timelineStartedAt = resp.startedAt; }
    state.timeline = resp.entries || [];
    renderTimeline();
    if (state.recording) startPolling();
  });

  $("btn-steps-from-timeline").addEventListener("click", function () {
    var drafted = draftStepsFromTimeline();
    if (!drafted.length) { feedback("Record some interactions first, then draft the steps."); return; }
    var existing = $("f-steps").value.trim();
    var text = drafted.map(function (l, i) { return (i + 1) + ". " + l; }).join("\n");
    $("f-steps").value = existing ? existing + "\n" + text : text;
    feedback("Drafted " + drafted.length + " step(s) from the recording — edit before filing.");
  });

  /**
   * Turn recorded interactions into editable step text. These are OBSERVED
   * actions, not an explanation: what the user did, in order.
   */
  function draftStepsFromTimeline() {
    var entries = Timeline.normalize(state.timeline, { startedAt: state.recordingStartedAt });
    var steps = [];
    var lastNav = "";
    entries.forEach(function (e) {
      if (e.kind === "nav") {
        var page = shortPage(e.detail);
        if (page && page !== lastNav) {
          steps.push("Open " + page);
          lastNav = page;
        }
      } else if (e.kind === "click") {
        var what = String(e.label || "").replace(/^Clicked\s*/i, "");
        if (what) steps.push("Click " + what);
      } else if (e.kind === "submit") {
        steps.push("Submit " + (e.detail && e.detail !== "(no action attribute)" ? e.detail : "the form"));
      } else if (e.kind === "key") {
        steps.push(e.label);
      }
    });
    // De-duplicate consecutive identical steps (double clicks, retries).
    return steps.filter(function (s, i) { return i === 0 || s !== steps[i - 1]; }).slice(0, 12);
  }

  function shortPage(url) {
    try {
      var u = new URL(url);
      var p = u.pathname === "/" ? "" : u.pathname;
      return u.hostname + p;
    } catch (e) {
      return String(url || "").slice(0, 80);
    }
  }

  // ------------------------------------------------------------ clip recording

  function setClipStatus(text, isError) {
    var el = $("clip-status");
    el.textContent = text;
    el.classList.toggle("is-error", !!isError);
  }

  function fmtClock(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    var r = s % 60;
    return (m < 10 ? "0" + m : m) + ":" + (r < 10 ? "0" + r : r);
  }

  function startClipTimer(startedAt) {
    state.clipStartedAt = startedAt || Date.now();
    clearInterval(state.clipTimer);
    $("clip-timer").classList.remove("hidden");
    var maxMs = (state.settings.maxClipSeconds || 60) * 1000;
    state.clipTimer = setInterval(async function () {
      var elapsed = Date.now() - state.clipStartedAt;
      $("clip-timer").textContent = fmtClock(Math.min(elapsed, maxMs));
      if (elapsed >= maxMs + 500) {
        clearInterval(state.clipTimer);
        state.clipTimer = null;
        await pollClip(true);
      }
    }, 250);
  }

  function stopClipTimer() {
    clearInterval(state.clipTimer);
    state.clipTimer = null;
  }

  async function pollClip(silent) {
    var resp = await sendMessage({ type: "REPROPACK_CLIP_STATE" });
    if (resp && resp.active) {
      if (!silent) setClipStatus("● Recording clip — reproduce the bug, then press Stop.", true);
      if (resp.sizeBytes) $("clip-timer").textContent = fmtClock(resp.elapsedMs || 0);
      return true;
    }
    if (!silent) {
      stopClipTimer();
      $("btn-clip-start").disabled = false;
      $("btn-clip-stop").disabled = true;
      var meta = await loadClipMeta();
      setClipStatus(meta ? "Clip saved ✓" : "Clip finished.", false);
    }
    return false;
  }

  async function loadClipMeta() {
    var res = await storageGet(["repropack_clip"]);
    state.clip = res.repropack_clip || null;
    renderClipInfo();
    return state.clip;
  }

  function renderClipInfo() {
    var info = $("clip-info");
    if (!state.clip || !state.clip.name) {
      info.classList.add("hidden");
      $("btn-download-clip-report").classList.add("hidden");
      return;
    }
    info.classList.remove("hidden");
    $("btn-download-clip-report").classList.remove("hidden");
    var dur = state.clip.durationMs ? " · " + (state.clip.durationMs / 1000).toFixed(1) + "s" : "";
    $("clip-name").textContent = state.clip.name + dur;
    // Re-saving is only possible while the bytes are still held in storage.
    $("btn-clip-download").classList.toggle("hidden", !state.clip.dataUrl);
  }

  $("btn-clip-start").addEventListener("click", async function () {
    if (!chrome.tabCapture) {
      setClipStatus("This browser cannot record tab clips. Use 📸 Capture evidence instead.", true);
      return;
    }
    $("btn-clip-start").disabled = true;
    setClipStatus("Starting clip…", false);
    var maxMs = Math.max(5, Math.min(Number(state.settings.maxClipSeconds) || 60, 120)) * 1000;
    var resp = await sendMessage({ type: "REPROPACK_CLIP_START", maxMs: maxMs, audio: true });
    if (!resp.ok) {
      setClipStatus(resp.error || "Clip failed to start.", true);
      $("btn-clip-start").disabled = false;
      return;
    }
    $("btn-clip-stop").disabled = false;
    $("clip-timer").textContent = "00:00";
    setClipStatus("● Recording clip — reproduce the bug, then press Stop.", true);
    startClipTimer(Date.now());
  });

  $("btn-clip-stop").addEventListener("click", async function () {
    $("btn-clip-stop").disabled = true;
    setClipStatus("Finishing clip…", false);
    var resp = await sendMessage({ type: "REPROPACK_CLIP_STOP" });
    stopClipTimer();
    $("btn-clip-start").disabled = false;
    if (!resp.ok) {
      setClipStatus(resp.error || "Could not finish the clip.", true);
      return;
    }
    await loadClipMeta();
    setClipStatus(resp.meta ? "Clip saved to Downloads ✓" : "Clip finished.", false);
  });

  $("btn-clip-download").addEventListener("click", async function () {
    if (!state.clip || !state.clip.dataUrl) return;
    var resp = await sendMessage({
      type: "REPROPACK_CLIP_SAVE",
      payload: {
        dataUrl: state.clip.dataUrl,
        ext: (state.clip.name || "").split(".").pop() || "webm",
        mime: state.clip.mime,
        durationMs: state.clip.durationMs,
        sizeBytes: state.clip.sizeBytes
      }
    });
    if (resp.ok) { await loadClipMeta(); setClipStatus("Clip saved to Downloads ✓", false); }
    else setClipStatus(resp.error || "Save failed.", true);
  });

  $("btn-download-clip-report").addEventListener("click", function () {
    if (!state.clip) return;
    var url = state.clip.dataUrl || "";
    if (!url) { feedback("Clip already saved to your Downloads folder: " + state.clip.name); return; }
    var a = document.createElement("a");
    a.href = url;
    a.download = state.clip.name;
    a.click();
  });

  // ------------------------------------------------------------ form

  function readForm() {
    return {
      title: $("f-title").value,
      whatHappened: $("f-what").value,
      expected: $("f-expected").value,
      steps: $("f-steps").value,
      severity: $("f-severity").value,
      frequency: $("f-frequency").value,
      account: $("f-account").value,
      notes: $("f-notes").value
    };
  }

  function reportOpts() {
    return {
      stripQueryParams: $("chk-strip").checked,
      redact: $("chk-redact").checked,
      includeTimeline: $("chk-include-timeline").checked
    };
  }

  function filteredEvidence() {
    var ev = JSON.parse(JSON.stringify(state.evidence || {}));
    if (ev.errors) {
      ev.errors = ev.errors.filter(function (_, i) { return !state.excludedErrors[i]; });
    }
    if ($("chk-include-shot").checked && state.screenshotDataUrl) {
      ev.screenshotDataUrl = state.screenshotDataUrl;
      ev.screenshotName = state.screenshotName;
    } else {
      ev.screenshotDataUrl = null;
    }
    if (!reportOpts().includeTimeline) {
      ev.timeline = [];
    } else {
      ev.timeline = state.timeline;
      ev.timelineStartedAt = state.timelineStartedAt || (state.evidence && state.evidence.timelineStartedAt) || state.recordingStartedAt;
    }
    if (state.clip) {
      ev.clip = { name: state.clip.name, durationMs: state.clip.durationMs, sizeBytes: state.clip.sizeBytes };
    }
    if (ev.network && ev.network.length) {
      ev.harSummary = Har.summary(Har.buildHar(ev.network, reportOpts()));
    }
    return ev;
  }

  $("btn-generate").addEventListener("click", async function () {
    if (!state.evidence) {
      setStatus($("capture-status"), "Capture evidence first", false);
      switchTab("capture");
      return;
    }
    var btn = $("btn-generate");
    btn.disabled = true;
    btn.textContent = "✨ Generating…";

    var ev = filteredEvidence();
    var form = readForm();
    var opts = reportOpts();
    state.triage = Triage.suggestSeverity(ev, form);
    renderTriage(state.triage);

    try {
      var md;
      if (state.settings.useAI && state.settings.apiKey) {
        try {
          md = await window.ReproPackAI.organizeWithAI(ev, form, state.settings);
        } catch (aiErr) {
          md = Report.generateReport(ev, form, Object.assign({ triage: state.triage }, opts));
          feedback("AI failed (" + aiErr.message + ") — used the offline organizer instead.");
        }
      } else {
        md = Report.generateReport(ev, form, Object.assign({ triage: state.triage }, opts));
      }
      state.reportMd = md;
      $("report-out").value = md;
      renderMissing(ev, form);
      await renderDuplicates();
      switchTab("report");
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ Generate report";
    }
  });

  function renderTriage(suggestion) {
    var box = $("triage-box");
    if (!suggestion || !suggestion.reasons.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    $("triage-chip").textContent = Triage.chipLabel(suggestion);
    $("triage-caveat").textContent = suggestion.caveat;
    var list = $("triage-reasons");
    list.innerHTML = "";
    suggestion.reasons.slice(0, 6).forEach(function (r) {
      var li = document.createElement("li");
      li.textContent = (r.weight > 0 ? "+" : "") + r.weight + " · " + r.label + (r.evidence ? " — " + r.evidence : "");
      list.appendChild(li);
    });
  }

  $("btn-apply-triage").addEventListener("click", function () {
    if (!state.triage) return;
    var value = state.triage.level.label;
    var sel = $("f-severity");
    var found = false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === value) { sel.selectedIndex = i; found = true; break; }
    }
    if (!found) {
      var opt = document.createElement("option");
      opt.value = value;
      opt.textContent = value;
      sel.appendChild(opt);
      sel.value = value;
    }
    feedback("Severity set to the suggestion — change it if you disagree.");
  });

  function renderMissing(ev, form) {
    var missing = Report.detectMissing(ev, form);
    var box = $("missing-box");
    var list = $("missing-list");
    list.innerHTML = "";
    if (!missing.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    missing.forEach(function (m) {
      var li = document.createElement("li");
      li.textContent = m.label + (m.hint ? " — " + m.hint : "");
      list.appendChild(li);
    });
  }

  // ------------------------------------------------------------ duplicates

  async function renderDuplicates() {
    var box = $("dupes-box");
    var list = $("dupes-list");
    list.innerHTML = "";
    if (!state.evidence) { box.classList.add("hidden"); return; }

    var fp = Dupes.fingerprint(filteredEvidence(), readForm());
    var res = await storageGet(["repropack_history"]);
    var dupes = Dupes.findDuplicates(fp, res.repropack_history || []);
    state.dupes = dupes;

    if (!dupes.length) { box.classList.add("hidden"); return; }
    box.classList.remove("hidden");
    dupes.forEach(function (d) {
      var li = document.createElement("li");
      var strong = document.createElement("strong");
      strong.textContent = d.title;
      var meta = document.createElement("span");
      meta.className = "dupe-meta";
      meta.textContent = " · " + Dupes.percent(d.score) + " match";
      li.appendChild(strong);
      li.appendChild(meta);
      var why = document.createElement("div");
      why.className = "dupe-why";
      why.textContent = d.reasons.join(" · ");
      li.appendChild(why);
      list.appendChild(li);
    });
  }

  // ------------------------------------------------------------ report actions

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      feedback(okMsg);
    } catch (e) {
      var ta = $("report-out");
      ta.focus();
      ta.select();
      try { document.execCommand("copy"); } catch (err) {}
      feedback(okMsg);
    }
  }

  function currentMarkdown() {
    return $("report-out").value.trim();
  }

  $("btn-copy-md").addEventListener("click", function () {
    if (!currentMarkdown()) { feedback("Nothing to copy yet — generate a report first."); return; }
    copyText(currentMarkdown(), "Markdown copied ✓ — paste into GitHub / Slack / Notion.");
  });

  $("btn-copy-jira").addEventListener("click", function () {
    if (!currentMarkdown()) { feedback("Nothing to copy yet — generate a report first."); return; }
    copyText(Report.toJiraWiki(currentMarkdown()), "Jira wiki markup copied ✓");
  });

  function downloadBlob(blob, filename) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
  }

  $("btn-download-md").addEventListener("click", function () {
    if (!currentMarkdown()) { feedback("Nothing to download yet."); return; }
    var title = $("f-title").value || "bug-report";
    downloadBlob(new Blob([currentMarkdown()], { type: "text/markdown" }), Report.slugify(title) + ".md");
    feedback("Markdown file downloaded ✓");
  });

  $("btn-download-har").addEventListener("click", function () {
    var ev = state.evidence;
    if (!ev || !ev.network || !ev.network.length) {
      feedback("No network activity was captured for this page.");
      return;
    }
    var har = Har.buildHar(ev.network, {
      redact: $("chk-redact").checked,
      stripQueryParams: $("chk-strip").checked,
      pageUrl: ev.url,
      pageTitle: ev.title,
      startedAt: ev.capturedAt
    });
    var name = Har.fileName(ev.url, ev.capturedAt);
    downloadBlob(new Blob([Har.toJson(har)], { type: "application/json" }), name);
    var s = Har.summary(har);
    $("har-note").textContent = s.text + " · no bodies or headers recorded.";
    feedback("HAR-lite downloaded ✓");
  });

  // ------------------------------------------------------------ history + save

  async function saveReportToHistory() {
    var md = currentMarkdown();
    if (!md) return null;
    var res = await storageGet(["repropack_history"]);
    var hist = res.repropack_history || [];
    var fp = state.evidence ? Dupes.fingerprint(filteredEvidence(), readForm()) : null;
    var item = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      title: $("f-title").value || "Untitled bug report",
      url: state.evidence ? state.evidence.url || "" : "",
      savedAt: new Date().toISOString(),
      markdown: md,
      fingerprint: fp
    };
    hist.unshift(item);
    hist = hist.slice(0, 50);
    await storageSet({ repropack_history: hist });
    renderHistory();
    return item;
  }

  $("btn-save").addEventListener("click", async function () {
    if (!currentMarkdown()) { feedback("Nothing to save yet."); return; }
    await saveReportToHistory();
    feedback("Saved to History ✓");
  });

  async function renderHistory() {
    var res = await storageGet(["repropack_history"]);
    var hist = res.repropack_history || [];
    $("history-count").textContent = String(hist.length);
    $("history-empty").classList.toggle("hidden", hist.length > 0);
    var list = $("history-list");
    list.innerHTML = "";

    hist.forEach(function (item) {
      var li = document.createElement("li");
      var t = document.createElement("div");
      t.className = "h-title";
      t.textContent = item.title;
      var m = document.createElement("div");
      m.className = "h-meta";
      m.textContent = Report.formatWhen(item.savedAt) + (item.url ? " · " + shortPage(item.url) : "");
      var row = document.createElement("div");
      row.className = "row";

      var bCopy = document.createElement("button");
      bCopy.className = "btn btn-ghost btn-sm";
      bCopy.textContent = "📋 Copy";
      bCopy.addEventListener("click", function () { copyText(item.markdown, "Copied from History ✓"); });

      var bLoad = document.createElement("button");
      bLoad.className = "btn btn-ghost btn-sm";
      bLoad.textContent = "Open";
      bLoad.addEventListener("click", function () {
        $("report-out").value = item.markdown;
        switchTab("report");
      });

      var bDel = document.createElement("button");
      bDel.className = "btn btn-ghost btn-sm";
      bDel.textContent = "🗑";
      bDel.addEventListener("click", async function () {
        var r2 = await storageGet(["repropack_history"]);
        var h2 = (r2.repropack_history || []).filter(function (x) { return x.id !== item.id; });
        await storageSet({ repropack_history: h2 });
        renderHistory();
      });

      row.appendChild(bCopy);
      row.appendChild(bLoad);
      row.appendChild(bDel);
      li.appendChild(t);
      li.appendChild(m);
      li.appendChild(row);
      list.appendChild(li);
    });
  }

  $("btn-clear-history").addEventListener("click", async function () {
    if (!confirm("Delete all saved reports? This cannot be undone.")) return;
    await storageSet({ repropack_history: [] });
    renderHistory();
  });

  // ------------------------------------------------------------ filing

  var FIELD_MAP = {
    github: [
      ["fg-token", "token"], ["fg-repo", "repo"], ["fg-labels", "labels"],
      ["fg-assignees", "assignees"], ["fg-apibase", "apiBase"]
    ],
    jira: [
      ["fj-baseurl", "baseUrl"], ["fj-email", "email"], ["fj-token", "token"],
      ["fj-project", "projectKey"], ["fj-type", "issueType"], ["fj-priority", "priority"],
      ["fj-deployment", "deployment"]
    ],
    slack: [["fs-webhook", "webhookUrl"]],
    webhook: [["fw-url", "url"], ["fw-token", "token"]]
  };

  function currentTarget() { return $("file-target").value; }

  function loadFilingForm() {
    var target = currentTarget();
    document.querySelectorAll(".target-fields").forEach(function (el) {
      el.classList.toggle("hidden", el.getAttribute("data-target") !== target);
    });
    var cfg = (state.settings.filing || {})[target] || {};
    (FIELD_MAP[target] || []).forEach(function (pair) {
      var el = $(pair[0]);
      if (el) el.value = cfg[pair[1]] || "";
    });
    state.filingDirty = false;
  }

  function readFilingForm() {
    var target = currentTarget();
    var cfg = {};
    (FIELD_MAP[target] || []).forEach(function (pair) {
      var el = $(pair[0]);
      cfg[pair[1]] = el ? el.value.trim() : "";
    });
    if (target === "jira" && !cfg.issueType) cfg.issueType = "Bug";
    if (target === "jira" && !cfg.deployment) cfg.deployment = "cloud";
    return cfg;
  }

  $("file-target").addEventListener("change", function () {
    state.settings.lastTarget = currentTarget();
    storageSet({ repropack_settings: state.settings });
    loadFilingForm();
    renderFilingStatus();
    fileStatus("", false);
    $("file-link-wrap").classList.add("hidden");
  });

  document.querySelectorAll(".target-fields input, .target-fields select").forEach(function (el) {
    el.addEventListener("input", function () { state.filingDirty = true; });
    el.addEventListener("change", function () { state.filingDirty = true; });
  });

  $("btn-save-filing").addEventListener("click", async function () {
    var target = currentTarget();
    state.settings.filing[target] = readFilingForm();
    await storageSet({ repropack_settings: state.settings });
    state.filingDirty = false;
    renderFilingStatus();
    fileStatus("Destination settings saved ✓", false);
  });

  function renderFilingStatus() {
    var target = currentTarget();
    var missing = Filing.validateTarget(target, readFilingForm());
    var el = $("file-target-status");
    if (!missing.length) {
      el.textContent = "Ready";
      el.classList.add("ok");
    } else {
      el.textContent = "Missing: " + missing.map(function (m) { return m.label; }).join(", ");
      el.classList.remove("ok");
    }
  }

  $("btn-file").addEventListener("click", async function () {
    var target = currentTarget();
    var md = currentMarkdown();
    if (!md) {
      fileStatus("Generate a report first — the File tab sends what is on the Report tab.", true);
      switchTab("capture");
      return;
    }
    var cfg = readFilingForm();
    var missing = Filing.validateTarget(target, cfg);
    if (missing.length) {
      fileStatus("Still needed: " + missing.map(function (m) { return m.label; }).join(", "), true);
      return;
    }

    var label = { github: "GitHub issue", jira: "Jira issue", slack: "Slack message", webhook: "your webhook" }[target];
    if (!confirm("Send this report to " + label + "?\n\nThe report text is sent as-is (plus URL and severity). Review it first.")) return;

    var btn = $("btn-file");
    btn.disabled = true;
    btn.textContent = "🚀 Sending…";
    fileStatus("Sending…", false);
    $("file-link-wrap").classList.add("hidden");

    var ev = state.evidence || {};
    var form = readForm();
    var failedCount = (ev.network || []).filter(function (n) {
      if (!n) return false;
      var s = Number(n.status);
      return n.failed === true || s === 0 || s >= 400;
    }).length;

    try {
      var payload = Filing.buildPayload(target, {
        title: form.title || ev.title || "Bug report",
        markdown: md,
        url: ev.url || "",
        pageTitle: ev.title || "",
        severity: form.severity || "",
        frequency: form.frequency || "",
        capturedAt: ev.capturedAt || "",
        errorCount: (ev.errors || []).length,
        failedRequestCount: failedCount,
        fingerprint: ev.url ? Dupes.fingerprint(ev, form).hash : ""
      }, cfg);

      var resp = await fetch(payload.url, {
        method: payload.method,
        headers: payload.headers,
        body: payload.body
      });

      var text = await resp.text();
      var json = null;
      try { json = JSON.parse(text); } catch (e) {}

      if (!resp.ok) {
        fileStatus(Filing.explainHttpError(target, resp.status, text), true);
        return;
      }

      var describe = payload.describe ? payload.describe(json) : "Sent ✓";
      fileStatus(describe + " ✓", false);

      var link = payload.resultUrl ? payload.resultUrl(json) : "";
      if (link && target !== "slack" && target !== "webhook") {
        $("file-link").href = link;
        $("file-link-wrap").classList.remove("hidden");
      }

      await saveReportToHistory();
      setTimeout(function () { fileStatus(describe + " ✓ · saved to History", false); }, 1200);
    } catch (err) {
      var msg = err && err.message ? err.message : String(err);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        fileStatus("Network request blocked or offline. Check the URL, your connection, and that the host allows browser calls (CORS).", true);
      } else {
        fileStatus("Could not send: " + msg, true);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = "🚀 File report";
    }
  });

  // ------------------------------------------------------------ init

  (async function init() {
    await loadSettings();
    $("file-target").value = state.settings.lastTarget || "github";
    loadFilingForm();
    renderFilingStatus();
    await loadClipMeta();
    await renderHistory();
  })();
})();

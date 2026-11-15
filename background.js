/**
 * ReproPack background service worker (Chrome) / event page (Firefox).
 *
 * Responsibilities:
 *  • screenshot capture for the active tab
 *  • relay between popup and content script (evidence, timeline, recording)
 *  • short screen-clip recording via tabCapture + an offscreen document
 *  • downloading the finished clip
 *
 * Nothing is uploaded. The only network calls in ReproPack originate from the
 * popup (1) when the user explicitly files a report and (2) for the optional AI
 * organizer they configured.
 */

var OFFSCREEN_URL = "offscreen.html";
var DEFAULT_SETTINGS = {
  provider: "openai",
  apiKey: "",
  model: "",
  baseUrl: "",
  useAI: false,
  stripQueryParams: false,
  redact: true,
  includeScreenshot: true,
  includeTimeline: true,
  maxClipSeconds: 60,
  filing: {
    github: { token: "", repo: "", labels: "", assignees: "", apiBase: "" },
    jira: { baseUrl: "", email: "", token: "", projectKey: "", issueType: "Bug", priority: "", labels: "", deployment: "cloud" },
    slack: { webhookUrl: "" },
    webhook: { url: "", token: "" }
  },
  lastTarget: "github"
};

function mergeSettings(stored) {
  var out = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  if (!stored) return out;
  Object.keys(stored).forEach(function (k) {
    if (k === "filing" && stored.filing) {
      ["github", "jira", "slack", "webhook"].forEach(function (t) {
        out.filing[t] = Object.assign({}, out.filing[t], (stored.filing || {})[t] || {});
      });
    } else {
      out[k] = stored[k];
    }
  });
  return out;
}

// ------------------------------------------------------------ install

chrome.runtime.onInstalled.addListener(function () {
  chrome.storage.local.get(["repropack_settings"], function (res) {
    chrome.storage.local.set({ repropack_settings: mergeSettings(res.repropack_settings) });
  });
});

// ------------------------------------------------------------ helpers

function sendToTab(tabId, msg) {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.sendMessage(tabId, msg, function (resp) {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(resp || { ok: false, error: "No response from page" });
        }
      });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

function activeTab() {
  return new Promise(function (resolve) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      resolve((tabs && tabs[0]) || null);
    });
  });
}

function setRecordingBadge(tabId, on) {
  try {
    if (tabId == null) return;
    chrome.action.setBadgeBackgroundColor({ color: "#ff4d4f" });
    chrome.action.setBadgeText({ tabId: tabId, text: on ? "REC" : "" });
  } catch (e) {}
}

function restrictedFallback(tab, note) {
  return {
    url: tab && tab.url ? tab.url : "",
    title: tab && tab.title ? tab.title : "",
    userAgent: navigator.userAgent || "",
    viewport: "",
    referrer: "",
    errors: [],
    network: [],
    timeline: [],
    pageInfo: {},
    capturedAt: new Date().toISOString(),
    note: note || "Page scripts not accessible (restricted page). Only URL/title captured."
  };
}

// ------------------------------------------------------------ offscreen clip

var creatingOffscreen = null;

function hasOffscreenContext() {
  return new Promise(function (resolve) {
    if (!chrome.offscreen) return resolve(false);
    if (!chrome.runtime.getContexts) return resolve(null); // unknown → try create
    chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }, function (contexts) {
      resolve(Array.isArray(contexts) && contexts.length > 0);
    });
  });
}

function ensureOffscreen() {
  if (!chrome.offscreen) {
    return Promise.reject(new Error("Video clips need the offscreen API (Chrome 116+). Use screenshot capture instead."));
  }
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = hasOffscreenContext().then(function (exists) {
    if (exists) return true;
    return chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA"],
      justification: "Record a short clip of the broken tab as bug-report evidence."
    }).catch(function (err) {
      // Race: another call created it first.
      if (err && /single offscreen/i.test(String(err.message || err))) return true;
      throw err;
    }).then(function () { return true; });
  }).finally(function () { creatingOffscreen = null; });
  return creatingOffscreen;
}

function offscreenSend(msg) {
  return new Promise(function (resolve) {
    chrome.runtime.sendMessage(Object.assign({ target: "offscreen" }, msg), function (resp) {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false, error: "Offscreen document did not respond" });
    });
  });
}

function getStreamId(tabId) {
  return new Promise(function (resolve, reject) {
    try {
      var maybe = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, function (streamId) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!streamId) reject(new Error("Could not get a capture stream for this tab."));
        else resolve(streamId);
      });
      if (maybe && typeof maybe.then === "function") {
        maybe.then(resolve).catch(reject);
      }
    } catch (e) {
      reject(e);
    }
  });
}

async function startClip(tabId, maxMs, audio) {
  var tab = tabId != null ? tabId : (await activeTab() || {}).id;
  if (tab == null) throw new Error("No active tab to record.");
  await ensureOffscreen();
  var streamId = await getStreamId(tab);
  var resp = await offscreenSend({
    type: "REPROPACK_OFFSCREEN_START",
    streamId: streamId,
    maxMs: maxMs || 60000,
    audio: audio !== false
  });
  if (!resp.ok) throw new Error(resp.error || "The clip could not start.");
  setRecordingBadge(tab, true);
  return resp;
}

async function stopClip() {
  var resp = await offscreenSend({ type: "REPROPACK_OFFSCREEN_STOP" });
  return resp;
}

async function clipState() {
  var resp = await offscreenSend({ type: "REPROPACK_OFFSCREEN_STATE" });
  if (!resp || !resp.ok) return { ok: true, active: false };
  return resp;
}

async function saveClip(payload) {
  var stamp = new Date().toISOString().replace(/[:.]/g, "-").replace("Z", "");
  var ext = payload.ext || "webm";
  var filename = "repropack-clip-" + stamp + "." + ext;
  var dataUrl = payload.dataUrl || "";
  if (!dataUrl) throw new Error("Clip data was empty.");

  var downloadId = null;
  try {
    downloadId = await new Promise(function (resolve, reject) {
      chrome.downloads.download({ url: dataUrl, filename: filename, saveAs: false }, function (id) {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      });
    });
  } catch (e) {
    // Recording still succeeded; the user can download from the popup.
  }

  var meta = {
    name: filename,
    downloadId: downloadId,
    mime: payload.mime || "video/webm",
    durationMs: payload.durationMs || 0,
    sizeBytes: payload.sizeBytes || 0,
    savedAt: new Date().toISOString(),
    dataUrl: downloadId ? "" : dataUrl
  };
  await new Promise(function (resolve) {
    chrome.storage.local.set({ repropack_clip: meta }, resolve);
  });
  try { chrome.action.setBadgeText({ text: "" }); } catch (e) {}
  return meta;
}

// ------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !msg.type) return false;
  if (msg.target === "offscreen") return false; // handled by the offscreen document

  // ---- screenshot
  if (msg.type === "REPROPACK_CAPTURE_SCREENSHOT") {
    chrome.tabs.captureVisibleTab({ format: "png" }, function (dataUrl) {
      if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      else sendResponse({ ok: true, dataUrl: dataUrl });
    });
    return true;
  }

  // ---- evidence
  if (msg.type === "REPROPACK_GET_TAB_EVIDENCE") {
    activeTab().then(function (tab) {
      if (!tab) return sendResponse({ ok: false, error: "No active tab found." });
      sendToTab(tab.id, { type: "REPROPACK_GET_EVIDENCE" }).then(function (resp) {
        if (!resp || !resp.ok) {
          sendResponse({ ok: true, evidence: restrictedFallback(tab) });
          return;
        }
        resp.evidence.limitations = resp.evidence.limitations || [];
        if (tab.url && /^(chrome|edge|about|chrome-extension|moz-extension):/i.test(tab.url)) {
          resp.evidence.limitations.push("Restricted browser page: only URL and title could be captured.");
        }
        sendResponse(resp);
      });
    });
    return true;
  }

  // ---- recording (timeline)
  if (msg.type === "REPROPACK_START_RECORDING" || msg.type === "REPROPACK_STOP_RECORDING" ||
      msg.type === "REPROPACK_GET_TIMELINE" || msg.type === "REPROPACK_ADD_NOTE" || msg.type === "REPROPACK_CLEAR_BUFFER") {
    activeTab().then(function (tab) {
      if (!tab) return sendResponse({ ok: false, error: "No active tab found." });
      var wire = {
        REPROPACK_START_RECORDING: "REPROPACK_START_RECORDING",
        REPROPACK_STOP_RECORDING: "REPROPACK_STOP_RECORDING",
        REPROPACK_GET_TIMELINE: "REPROPACK_GET_TIMELINE",
        REPROPACK_ADD_NOTE: "REPROPACK_ADD_NOTE",
        REPROPACK_CLEAR_BUFFER: "REPROPACK_CLEAR_BUFFER"
      }[msg.type];
      sendToTab(tab.id, { type: wire, text: msg.text }).then(function (resp) {
        if (!resp || !resp.ok) {
          sendResponse({ ok: false, error: (resp && resp.error) || "This page cannot be recorded (restricted page)." });
          return;
        }
        if (msg.type === "REPROPACK_START_RECORDING" || msg.type === "REPROPACK_STOP_RECORDING") {
          setRecordingBadge(tab.id, msg.type === "REPROPACK_START_RECORDING");
        }
        sendResponse(resp);
      });
    });
    return true;
  }

  // ---- video clip
  if (msg.type === "REPROPACK_CLIP_START") {
    startClip(msg.tabId, msg.maxMs, msg.audio).then(function (resp) {
      sendResponse(resp);
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }
  if (msg.type === "REPROPACK_CLIP_STOP") {
    stopClip().then(function (resp) {
      chrome.storage.local.get(["repropack_clip"], function () {});
      sendResponse(resp);
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }
  if (msg.type === "REPROPACK_CLIP_STATE") {
    clipState().then(sendResponse).catch(function (err) {
      sendResponse({ ok: true, active: false, error: err && err.message });
    });
    return true;
  }
  if (msg.type === "REPROPACK_CLIP_READY") {
    // Sent by the offscreen document when a recording finishes.
    saveClip(msg.payload || {}).then(function (meta) {
      sendResponse({ ok: true, meta: meta });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }
  if (msg.type === "REPROPACK_CLIP_SAVE") {
    saveClip(msg.payload || {}).then(function (meta) {
      sendResponse({ ok: true, meta: meta });
    }).catch(function (err) {
      sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
    });
    return true;
  }

  return false;
});

// Keep the badge honest if the recorded tab goes away.
try {
  chrome.tabs.onRemoved.addListener(function () { /* badge disappears with the tab */ });
} catch (e) {}

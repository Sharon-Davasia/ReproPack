/**
 * ReproPack offscreen document — records a short clip of the active tab.
 *
 * Why an offscreen document? `chrome.tabCapture` streams can only be consumed
 * in an extension document that stays alive, and MV3 service workers get
 * suspended. Offscreen documents exist exactly for USER_MEDIA like this.
 *
 * There is no UI here: the popup drives it, the background saves the result.
 * Nothing is uploaded — the bytes go from MediaRecorder straight to a local
 * download via the background worker.
 */

(function () {
  "use strict";

  var MAX_BYTES_WARN = 80 * 1024 * 1024; // ~80 MB of base64 in one message
  var rec = null;
  var chunks = [];
  var stream = null;
  var audioCtx = null;
  var startedAt = 0;
  var mime = "";
  var stopTimer = null;
  var sizeBytes = 0;
  var lastError = "";

  function pickMime() {
    var candidates = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm",
      "video/mp4"
    ];
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    for (var i = 0; i < candidates.length; i++) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return "";
  }

  function extFor(m) {
    if (/mp4/.test(m)) return "mp4";
    return "webm";
  }

  async function getTabStream(streamId, withAudio) {
    var videoConstraints = {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
        maxFrameRate: 15,
        maxWidth: 1920,
        maxHeight: 1200
      }
    };
    var constraints = { video: videoConstraints, audio: !!withAudio };
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      if (!withAudio) throw err;
      // Some tabs have no audio track; retry video-only.
      return await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    }
  }

  function keepAudioAudible(s) {
    // Capturing a tab mutes it for the user unless we route audio back out.
    try {
      if (!s.getAudioTracks().length) return;
      audioCtx = new AudioContext();
      var source = audioCtx.createMediaStreamSource(s);
      source.connect(audioCtx.destination);
    } catch (e) { /* non-fatal */ }
  }

  async function start(msg) {
    if (rec) return { ok: false, error: "A clip is already recording." };
    lastError = "";
    chunks = [];
    sizeBytes = 0;

    try {
      stream = await getTabStream(msg.streamId, msg.audio !== false);
    } catch (err) {
      return { ok: false, error: describeMediaError(err) };
    }

    keepAudioAudible(stream);
    mime = pickMime();

    try {
      rec = new MediaRecorder(stream, {
        mimeType: mime || undefined,
        videoBitsPerSecond: 1_200_000,
        audioBitsPerSecond: 64_000
      });
    } catch (err) {
      cleanup();
      return { ok: false, error: "MediaRecorder could not start: " + (err && err.message ? err.message : err) };
    }

    rec.ondataavailable = function (ev) {
      if (ev.data && ev.data.size) {
        chunks.push(ev.data);
        sizeBytes += ev.data.size;
      }
    };
    rec.onerror = function (ev) {
      lastError = "Recorder error: " + (ev && ev.error ? ev.error.name || ev.error.message : "unknown");
    };
    rec.onstop = finish;

    var maxMs = Math.max(5000, Math.min(Number(msg.maxMs) || 60000, 180000));
    startedAt = Date.now();
    try {
      rec.start(500); // timeslice → chunk every 500ms so a crash loses little
    } catch (err) {
      cleanup();
      return { ok: false, error: "Recorder failed to start: " + (err && err.message ? err.message : err) };
    }
    stopTimer = setTimeout(function () { stop("max-duration").catch(function () {}); }, maxMs);

    return { ok: true, active: true, startedAt: new Date(startedAt).toISOString(), mime: mime || "video/webm", maxMs: maxMs };
  }

  function describeMediaError(err) {
    var name = err && err.name ? err.name : "";
    if (name === "NotAllowedError") return "Screen capture was blocked. Click the ReproPack icon again and press “Record clip”.";
    if (name === "NotFoundError") return "No capturable stream for this tab (restricted browser page?).";
    if (name === "NotReadableError") return "The tab is already being captured by another app.";
    return "Could not start the clip: " + (err && err.message ? err.message : String(err));
  }

  function state() {
    return {
      ok: true,
      active: !!rec && rec.state === "recording",
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      sizeBytes: sizeBytes,
      mime: mime || "video/webm",
      error: lastError
    };
  }

  async function stop(reason) {
    if (!rec) return { ok: true, active: false, note: "No clip was recording." };
    var durationMs = startedAt ? Date.now() - startedAt : 0;
    return new Promise(function (resolve) {
      var resolved = false;
      var done = function (value) {
        if (resolved) return;
        resolved = true;
        resolve(value);
      };
      var prevOnStop = rec.onstop;
      rec.onstop = function (ev) {
        try { if (prevOnStop) prevOnStop(ev); } catch (e) {}
        var payload = finalize(durationMs).then(done, function (err) {
          done({ ok: false, error: err && err.message ? err.message : String(err) });
        });
        return payload;
      };
      try {
        if (rec.state !== "inactive") rec.stop();
        else finalize(durationMs).then(done);
      } catch (err) {
        done({ ok: false, error: "Stop failed: " + (err && err.message ? err.message : err) });
      }
      // Safety net for stalls.
      setTimeout(function () { done({ ok: false, error: "Recording did not finish in time." }); }, 15000);
      setTimeout(function () { /* noop: keeps lint quiet about unused reason */ }, 0);
    });
  }

  async function finalize(durationMs) {
    var type = (rec && rec.mimeType) || mime || "video/webm";
    var blob = new Blob(chunks, { type: type.split(";")[0] });
    var ext = extFor(type);
    cleanup();

    if (!blob.size) {
      return { ok: false, error: "The clip was empty — the tab may have been closed or blocked." };
    }

    var dataUrl = await blobToDataUrl(blob);
    if (dataUrl.length > MAX_BYTES_WARN) {
      return { ok: false, error: "Clip is too large to save (" + Math.round(dataUrl.length / 1048576) + " MB). Try a shorter recording." };
    }

    var payload = {
      dataUrl: dataUrl,
      ext: ext,
      mime: type,
      durationMs: durationMs,
      sizeBytes: blob.size
    };

    var saved = await new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: "REPROPACK_CLIP_SAVE", payload: payload }, function (resp) {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false, error: "Background did not confirm the save." });
      });
    });

    return {
      ok: !!saved.ok,
      error: saved.ok ? "" : (saved.error || "Could not save the clip."),
      meta: saved.meta || null,
      active: false,
      durationMs: durationMs,
      sizeBytes: blob.size
    };
  }

  function blobToDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || "")); };
      fr.onerror = function () { reject(new Error("Could not read the recorded clip.")); };
      fr.readAsDataURL(blob);
    });
  }

  function cleanup() {
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    stream = null;
    try { if (audioCtx) audioCtx.close(); } catch (e) {}
    audioCtx = null;
    rec = null;
    startedAt = 0;
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.target !== "offscreen") return false;

    if (msg.type === "REPROPACK_OFFSCREEN_START") {
      start(msg).then(sendResponse, function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
      return true;
    }
    if (msg.type === "REPROPACK_OFFSCREEN_STOP") {
      stop("manual").then(sendResponse, function (err) {
        sendResponse({ ok: false, error: err && err.message ? err.message : String(err) });
      });
      return true;
    }
    if (msg.type === "REPROPACK_OFFSCREEN_STATE") {
      sendResponse(state());
      return true;
    }
    return false;
  });
})();

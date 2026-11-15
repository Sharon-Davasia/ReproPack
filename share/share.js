/**
 * ReproPack mobile companion (PWA).
 *
 * Installed from the repo, this page registers as a Web Share Target: sharing a
 * link from any phone app opens ReproPack with the URL pre-filled, then turns
 * your note into the same Markdown report the extension produces — fully
 * offline, using lib/report.js.
 *
 * It captures less evidence than the extension (no screenshot, no console), and
 * says so in “Missing information” rather than pretending otherwise.
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var R = window.ReproPackReport;

  function firstUrl(text) {
    var m = /https?:\/\/[^\s"'<>]+/i.exec(String(text || ""));
    return m ? m[0] : "";
  }

  function feedback(msg) {
    var el = $("feedback");
    el.textContent = msg;
    clearTimeout(feedback._t);
    feedback._t = setTimeout(function () { if (el.textContent === msg) el.textContent = ""; }, 3200);
  }

  // ------------------------------------------------------------ share target intake

  var params = new URLSearchParams(location.search);
  var sharedUrl = params.get("url") || "";
  var sharedText = params.get("text") || "";
  var sharedTitle = params.get("title") || "";

  if (sharedUrl || sharedText || sharedTitle) {
    var url = sharedUrl || firstUrl(sharedText);
    if (url) $("f-url").value = url;
    if (sharedTitle) $("f-title").value = sharedTitle;
    if (sharedText && sharedText !== url) {
      // The shared text usually contains the page title; keep it as context.
      var clean = sharedText.replace(url, "").trim();
      if (clean) $("f-what").value = clean.slice(0, 600);
    }
    $("shared-box").style.display = "block";
    $("shared-detail").innerHTML = "";
    var code = document.createElement("code");
    code.textContent = url || sharedTitle || (sharedText || "").slice(0, 120);
    $("shared-detail").appendChild(code);
  }

  // ------------------------------------------------------------ generate

  function buildEvidence() {
    return {
      url: $("f-url").value.trim(),
      title: $("f-title").value.trim(),
      userAgent: navigator.userAgent || "",
      viewport: window.innerWidth + "×" + window.innerHeight,
      referrer: document.referrer || "",
      errors: [],
      network: [],
      timeline: [],
      pageInfo: {
        lang: document.documentElement.lang || "",
        readyState: "complete"
      },
      capturedAt: new Date().toISOString(),
      limitations: [
        "Captured from the mobile companion, which cannot read the page's console or take a screenshot."
      ]
    };
  }

  function readForm() {
    return {
      title: $("f-title").value,
      whatHappened: $("f-what").value,
      expected: $("f-expected").value,
      steps: $("f-steps").value,
      severity: $("f-severity").value,
      frequency: $("f-frequency").value,
      account: ""
    };
  }

  $("btn-generate").addEventListener("click", function () {
    var ev = buildEvidence();
    var form = readForm();
    if (!form.title && !ev.url) {
      feedback("Add at least a title or a URL first.");
      return;
    }
    var md = R.generateReport(ev, form, { redact: true, stripQueryParams: false });
    $("out").value = md;

    var missing = R.detectMissing(ev, form);
    var box = $("missing-box");
    var list = $("missing-list");
    list.innerHTML = "";
    if (missing.length) {
      box.style.display = "block";
      missing.slice(0, 8).forEach(function (m) {
        var li = document.createElement("li");
        li.textContent = m.label;
        list.appendChild(li);
      });
    } else {
      box.style.display = "none";
    }
    $("out").scrollIntoView({ behavior: "smooth", block: "center" });
  });

  // ------------------------------------------------------------ output actions

  $("btn-copy").addEventListener("click", async function () {
    var v = $("out").value.trim();
    if (!v) { feedback("Generate a report first."); return; }
    try {
      await navigator.clipboard.writeText(v);
      feedback("Copied ✓");
    } catch (e) {
      $("out").focus();
      $("out").select();
      feedback("Select and copy manually (clipboard is blocked here).");
    }
  });

  $("btn-share").addEventListener("click", async function () {
    var v = $("out").value.trim();
    if (!v) { feedback("Generate a report first."); return; }
    if (!navigator.share) { feedback("This browser has no share sheet — use Copy instead."); return; }
    try {
      await navigator.share({ title: $("f-title").value || "Bug report", text: v });
      feedback("Shared ✓");
    } catch (e) {
      if (e && e.name === "AbortError") return;
      feedback("Sharing failed — use Copy instead.");
    }
  });

  $("btn-download").addEventListener("click", function () {
    var v = $("out").value.trim();
    if (!v) { feedback("Generate a report first."); return; }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([v], { type: "text/markdown" }));
    a.download = R.slugify($("f-title").value) + ".md";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 3000);
    feedback("Downloaded ✓");
  });

  // ------------------------------------------------------------ offline shell

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function () {
        $("mode-badge").textContent = "offline ready";
      }).catch(function () {
        $("mode-badge").textContent = "online only";
      });
    });
  }
})();

/**
 * ReproPack — optional AI organizer.
 *
 * The extension works fully offline with the local template organizer
 * (lib/report.js). If the user pastes their own API key in Options,
 * this module can ask an LLM to tidy the wording — under a strict
 * contract: use ONLY the supplied evidence, never invent a root cause,
 * and keep unknown items in "Missing information".
 *
 * Keys are stored in chrome.storage.local and never leave the browser
 * except in the direct request to the chosen provider.
 */

(function (global) {
  "use strict";

  var SYSTEM_PROMPT = [
    "You are ReproPack, a bug-report organizer. You receive captured evidence",
    "(URL, console errors, failed requests, screenshot note, and the user's own words).",
    "Your job is ONLY to organize that evidence into a clean Markdown bug report",
    "with sections: Summary, Expected vs Actual, Steps to reproduce, Evidence,",
    "Missing information.",
    "",
    "Hard rules:",
    "1. Never invent a root cause, a fix, or facts not present in the evidence.",
    "2. If something is unknown, put it under 'Missing information' as a checkbox.",
    "3. Do not add technical claims the evidence does not support.",
    "4. Keep the user's wording where possible; only tidy grammar and structure.",
    "5. Output Markdown only — no preamble, no commentary outside the report."
  ].join("\n");

  function buildPrompt(evidence, form) {
    var parts = [];
    parts.push("## Captured evidence");
    parts.push("- URL: " + (evidence.url || "(unknown)"));
    parts.push("- Page title: " + (evidence.title || "(unknown)"));
    parts.push("- Browser: " + (evidence.userAgent || "(unknown)"));
    parts.push("- Screenshot: " + (evidence.screenshotDataUrl ? "captured (attached separately)" : "not captured"));
    parts.push("");
    parts.push("### Errors");
    if (evidence.errors && evidence.errors.length) {
      evidence.errors.slice(0, 20).forEach(function (e) {
        parts.push("- [" + (e.type || "error") + "] " + (e.message || "") + (e.source ? " (" + e.source + ")" : ""));
      });
    } else {
      parts.push("- (none captured)");
    }
    parts.push("");
    parts.push("### Failed requests");
    if (evidence.network && evidence.network.length) {
      evidence.network.slice(0, 20).forEach(function (n) {
        parts.push("- " + (n.method || "GET") + " " + (n.url || "") + " -> " + (n.status == null ? "failed" : n.status));
      });
    } else {
      parts.push("- (none captured)");
    }
    parts.push("");
    parts.push("## User's own words");
    parts.push("- Title: " + (form.title || "(blank)"));
    parts.push("- What happened: " + (form.whatHappened || "(blank)"));
    parts.push("- Expected: " + (form.expected || "(blank)"));
    parts.push("- Steps: " + (form.steps || "(blank)"));
    parts.push("- Severity: " + (form.severity || "(blank)"));
    parts.push("- Frequency: " + (form.frequency || "(blank)"));
    parts.push("- Account/role: " + (form.account || "(blank)"));
    parts.push("- Notes: " + (form.notes || "(blank)"));
    parts.push("");
    parts.push("Organize the above into the Markdown bug report now.");
    return parts.join("\n");
  }

  /**
   * settings: { provider: 'openai'|'anthropic'|'gemini', apiKey, model?, baseUrl? }
   * Returns a Promise<string> of Markdown.
   */
  function organizeWithAI(evidence, form, settings) {
    settings = settings || {};
    var provider = settings.provider || "openai";
    var key = settings.apiKey || "";
    if (!key) return Promise.reject(new Error("No API key set. Add one in Options, or use the offline organizer."));

    var userPrompt = buildPrompt(evidence, form);

    if (provider === "anthropic") {
      return fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true"
        },
        body: JSON.stringify({
          model: settings.model || "claude-sonnet-4-20250514",
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userPrompt }]
        })
      }).then(function (r) {
        if (!r.ok) throw new Error("Anthropic request failed (" + r.status + "). Check your key and model.");
        return r.json();
      }).then(function (j) {
        var text = (j.content || []).map(function (b) { return b.text || ""; }).join("");
        if (!text) throw new Error("Anthropic returned an empty response.");
        return text;
      });
    }

    if (provider === "gemini") {
      var model = settings.model || "gemini-2.0-flash";
      return fetch("https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }]
        })
      }).then(function (r) {
        if (!r.ok) throw new Error("Gemini request failed (" + r.status + "). Check your key and model.");
        return r.json();
      }).then(function (j) {
        var text = (((j.candidates || [])[0] || {}).content || {}).parts || [];
        var out = text.map(function (p) { return p.text || ""; }).join("");
        if (!out) throw new Error("Gemini returned an empty response.");
        return out;
      });
    }

    // Default: OpenAI-compatible (OpenAI, Azure, local gateways, etc.)
    var base = (settings.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    return fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key
      },
      body: JSON.stringify({
        model: settings.model || "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt }
        ]
      })
    }).then(function (r) {
      if (!r.ok) throw new Error("AI request failed (" + r.status + "). Check your key, model, and base URL.");
      return r.json();
    }).then(function (j) {
      var text = (((j.choices || [])[0] || {}).message || {}).content || "";
      if (!text) throw new Error("AI returned an empty response.");
      return text;
    });
  }

  var api = { organizeWithAI: organizeWithAI, buildPrompt: buildPrompt, SYSTEM_PROMPT: SYSTEM_PROMPT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackAI = api;
})(typeof self !== "undefined" ? self : this);

/**
 * ReproPack — manifest variants & validation.
 *
 * ReproPack ships one source of truth (`manifest.json`, Chrome MV3) and derives
 * the Firefox variant from it. Pure functions so the build script, the tests
 * and the options page can all ask the same questions.
 */

(function (global) {
  "use strict";

  var GECKO_ID = "repropack@sharon-davasia.dev";
  var GECKO_MIN = "115.0";

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj || {}));
  }

  /**
   * Chrome MV3 manifest → Firefox MV3 manifest.
   * Firefox uses a background event page (`scripts`) instead of a service
   * worker, and needs an add-on id for storage/updates.
   */
  function toFirefoxManifest(chromeManifest) {
    var m = clone(chromeManifest);

    if (m.background && m.background.service_worker) {
      m.background = { scripts: [m.background.service_worker] };
    }
    delete m.minimum_chrome_version;

    // APIs ReproPack only uses behind a capability check.
    var optional = m.optional_permissions || [];
    ["tabCapture", "offscreen", "downloads"].forEach(function (p) {
      if ((m.permissions || []).indexOf(p) !== -1 && optional.indexOf(p) === -1) optional.push(p);
    });
    if (optional.length) m.optional_permissions = optional;

    m.browser_specific_settings = {
      gecko: {
        id: GECKO_ID,
        strict_min_version: GECKO_MIN,
        // Firefox 140+ asks add-ons to declare data collection; ReproPack has no server.
        data_collection_permissions: { required: ["none"] }
      }
    };
    m.description = (m.description || "") + " (Firefox build)";
    return m;
  }

  /** Every file path the manifest refers to. */
  function referencedFiles(manifest) {
    var m = manifest || {};
    var files = [];
    function add(p) { if (typeof p === "string" && p && files.indexOf(p) === -1) files.push(p); }

    if (m.background) {
      add(m.background.service_worker);
      if (Array.isArray(m.background.scripts)) m.background.scripts.forEach(add);
    }
    if (m.action && m.action.default_popup) add(m.action.default_popup);
    if (m.options_page) add(m.options_page);
    if (m.options_ui && m.options_ui.page) add(m.options_ui.page);
    if (m.icons) Object.keys(m.icons).forEach(function (k) { add(m.icons[k]); });
    if (m.action && m.action.default_icon) {
      var di = m.action.default_icon;
      if (typeof di === "string") add(di);
      else Object.keys(di).forEach(function (k) { add(di[k]); });
    }
    (m.content_scripts || []).forEach(function (cs) {
      (cs.js || []).forEach(add);
      (cs.css || []).forEach(add);
    });
    return files;
  }

  /**
   * Validate a manifest object.
   * exists(path) → boolean
   * → [{ level: 'error'|'warn', message }]
   */
  function validateManifest(manifest, exists) {
    var m = manifest || {};
    var problems = [];
    var check = typeof exists === "function" ? exists : function () { return true; };

    if (m.manifest_version !== 3) problems.push({ level: "error", message: "manifest_version must be 3 (got " + m.manifest_version + ")" });
    if (!m.name) problems.push({ level: "error", message: "name is required" });
    if (!m.version) problems.push({ level: "error", message: "version is required" });
    // Chrome requires 1-4 dot-separated integers (e.g. "0.2.0"); anything else fails to load.
    if (m.version && !/^\d+(\.\d+){0,3}$/.test(String(m.version))) {
      problems.push({ level: "error", message: "version must be 1-4 dot-separated integers (got " + m.version + ")" });
    }
    if (m.name && String(m.name).length > 75) problems.push({ level: "warn", message: "name is longer than 75 characters" });
    if (m.description && String(m.description).length > 132) {
      problems.push({ level: "warn", message: "description is longer than 132 characters (store listing truncates it)" });
    }
    if (m.default_locale && !check("_locales/" + m.default_locale + "/messages.json")) {
      problems.push({ level: "error", message: "default_locale is set but _locales/" + m.default_locale + "/messages.json is missing" });
    }

    var files = referencedFiles(m);
    files.forEach(function (f) {
      if (!check(f)) problems.push({ level: "error", message: "manifest references a missing file: " + f });
    });

    if (!files.length) problems.push({ level: "warn", message: "manifest references no files" });

    // Content scripts must not be injected into extension pages twice.
    var urlMatches = (m.content_scripts || []).some(function (cs) {
      return (cs.matches || []).indexOf("<all_urls>") !== -1;
    });
    if (urlMatches && (m.permissions || []).indexOf("activeTab") === -1) {
      problems.push({ level: "warn", message: "content script runs on <all_urls> without the activeTab permission" });
    }

    return problems;
  }

  var api = {
    GECKO_ID: GECKO_ID,
    GECKO_MIN: GECKO_MIN,
    toFirefoxManifest: toFirefoxManifest,
    referencedFiles: referencedFiles,
    validateManifest: validateManifest
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackManifest = api;
})(typeof self !== "undefined" ? self : this);

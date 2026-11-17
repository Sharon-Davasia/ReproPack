/**
 * ReproPack — one-click filing.
 *
 * Turns a finished report into the exact HTTP request each destination wants:
 *   • GitHub  — POST /repos/{owner}/{repo}/issues (Markdown body)
 *   • Jira    — POST /rest/api/3/issue (ADF, Cloud) or /rest/api/2/issue (wiki, Server/DC)
 *   • Slack   — POST to an incoming webhook (Block Kit, mrkdwn)
 *   • Webhook — POST a JSON bundle to any URL you control
 *
 * Everything here is a PURE payload builder: no fetch, no storage, no
 * side-effects. That makes it testable in Node and keeps the network call in
 * one small place (popup.js) where errors can be explained to the user.
 *
 * The report is still the user's to review — filing never edits it, and the
 * payload builders never add claims the report does not contain.
 */

(function (global) {
  "use strict";

  var VERSION = "0.2.0";

  // ------------------------------------------------------------ helpers

  function str(v) { return String(v == null ? "" : v); }

  function truncate(s, max) {
    var t = str(s);
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function stripQueryParams(url) {
    try {
      var u = new URL(url);
      u.search = "";
      u.hash = "";
      return u.toString();
    } catch (e) {
      return str(url);
    }
  }

  function trimSlash(s) { return str(s).replace(/\/+$/, ""); }

  /** "owner/repo", a GitHub URL, or "https://ghe.corp/api/v3 + owner/repo". */
  function parseGitHubRepo(input) {
    var raw = str(input).trim();
    if (!raw) return null;
    var fromUrl = /github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(raw);
    if (fromUrl) return { owner: fromUrl[1], repo: fromUrl[2].replace(/\.git$/, "") };
    var m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(raw);
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, "") };
    return null;
  }

  function splitList(input) {
    if (Array.isArray(input)) return input.map(function (x) { return str(x).trim(); }).filter(Boolean);
    return str(input).split(",").map(function (x) { return x.trim(); }).filter(Boolean);
  }

  // ------------------------------------------------------------ validation

  /**
   * What is still needed before this target can be used?
   * → [{ field, label }]  (empty array = ready)
   */
  function validateTarget(target, cfg) {
    cfg = cfg || {};
    var missing = [];
    function need(field, label, value) {
      if (!str(value).trim()) missing.push({ field: field, label: label });
    }
    if (target === "github") {
      need("token", "GitHub token (repo scope)", cfg.token);
      if (!parseGitHubRepo(cfg.repo)) missing.push({ field: "repo", label: "Repository as owner/repo" });
    } else if (target === "jira") {
      need("baseUrl", "Jira base URL", cfg.baseUrl);
      need("email", "Jira account email", cfg.email);
      need("token", "Jira API token", cfg.token);
      need("projectKey", "Project key", cfg.projectKey);
      need("issueType", "Issue type", cfg.issueType || "Bug");
    } else if (target === "slack") {
      var url = str(cfg.webhookUrl).trim();
      if (!url) missing.push({ field: "webhookUrl", label: "Slack incoming webhook URL" });
      else if (!/^https:\/\/hooks\.slack\.com\//i.test(url) && !/^https:\/\//i.test(url)) {
        missing.push({ field: "webhookUrl", label: "A valid https:// webhook URL" });
      }
    } else if (target === "webhook") {
      var w = str(cfg.url).trim();
      if (!w) missing.push({ field: "url", label: "Webhook URL" });
      else if (!/^https?:\/\//i.test(w)) missing.push({ field: "url", label: "A http(s):// webhook URL" });
    }
    return missing;
  }

  // ------------------------------------------------------------ GitHub

  /**
   * buildGitHubIssue({ title, markdown, labels, assignees, url }, cfg)
   * → { method, url, headers, body }
   */
  function buildGitHubIssue(input, cfg) {
    cfg = cfg || {};
    input = input || {};
    var repo = parseGitHubRepo(cfg.repo);
    if (!repo) throw new Error("GitHub repository must be owner/repo (got: " + str(cfg.repo) + ")");
    if (!str(cfg.token).trim()) throw new Error("GitHub token is missing — add it in Options.");

    var apiBase = trimSlash(cfg.apiBase || "https://api.github.com");
    var payload = {
      title: truncate(str(input.title).trim() || "Bug report", 250),
      body: str(input.markdown)
    };
    var labels = splitList(cfg.labels || input.labels);
    if (labels.length) payload.labels = labels.slice(0, 10);
    var assignees = splitList(cfg.assignees || input.assignees);
    if (assignees.length) payload.assignees = assignees.slice(0, 5);

    return {
      target: "github",
      method: "POST",
      url: apiBase + "/repos/" + encodeURIComponent(repo.owner) + "/" + encodeURIComponent(repo.repo) + "/issues",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + str(cfg.token).trim(),
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: JSON.stringify(payload),
      // Where to send the user after a successful create.
      resultUrl: function (json) {
        return json && json.html_url ? json.html_url : "https://github.com/" + repo.owner + "/" + repo.repo + "/issues";
      },
      describe: function (json) {
        return "Issue #" + ((json && json.number) || "?") + " created";
      }
    };
  }

  // ------------------------------------------------------------ Jira

  var BLOCK_MARKS = { strong: "strong", em: "em", code: "code", strike: "strike" };

  /** Parse inline Markdown into ADF text nodes. */
  function inlineToAdf(text) {
    var s = str(text);
    var nodes = [];
    var re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)|(\[[^\]]+\]\([^)]+\))|(<[^>\s]+>)/g;
    var last = 0, m;
    function pushText(value, marks) {
      if (!value) return;
      var node = { type: "text", text: value };
      if (marks && marks.length) node.marks = marks.map(function (m) { return { type: m }; });
      nodes.push(node);
    }
    while ((m = re.exec(s))) {
      if (m.index > last) pushText(s.slice(last, m.index), []);
      if (m[1]) pushText(m[1].slice(1, -1), [BLOCK_MARKS.code]);
      else if (m[2]) pushText(m[2].slice(2, -2), [BLOCK_MARKS.strong]);
      else if (m[3]) pushText(m[3].slice(1, -1), [BLOCK_MARKS.em]);
      else if (m[4]) pushText(m[4].slice(1, -1), [BLOCK_MARKS.em]);
      else if (m[5]) {
        var link = /\[([^\]]+)\]\(([^)]+)\)/.exec(m[5]);
        nodes.push({
          type: "text",
          text: link[1],
          marks: [{ type: "link", attrs: { href: link[2] } }]
        });
      } else if (m[6]) {
        var href = m[6].slice(1, -1);
        nodes.push({ type: "text", text: href, marks: [{ type: "link", attrs: { href: href } }] });
      }
      last = re.lastIndex;
    }
    if (last < s.length) pushText(s.slice(last), []);
    if (!nodes.length) nodes.push({ type: "text", text: s });
    return nodes;
  }

  function adfParagraph(text) {
    return { type: "paragraph", content: inlineToAdf(text) };
  }

  function adfListItem(text) {
    return { type: "listItem", content: [adfParagraph(text)] };
  }

  /**
   * Convert the report Markdown to Atlassian Document Format.
   * Tables are preserved as monospace code blocks (ADF tables are awkward and
   * this keeps the aligned columns readable in Jira).
   */
  function markdownToADF(markdown) {
    var lines = str(markdown).replace(/\r\n/g, "\n").split("\n");
    var content = [];
    var i = 0;

    function isTableLine(l) { return /^\s*\|.*\|\s*$/.test(l); }
    function isSeparatorRow(l) { return /^\s*\|[\s:|-]+\|\s*$/.test(l); }

    while (i < lines.length) {
      var line = lines[i];

      // fenced code
      if (/^\s*```/.test(line)) {
        var lang = line.replace(/^\s*```/, "").trim();
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++; // closing fence
        content.push({
          type: "codeBlock",
          attrs: lang ? { language: lang } : {},
          content: [{ type: "text", text: code.join("\n") || " " }]
        });
        continue;
      }

      // table → code block, keep alignment
      if (isTableLine(line)) {
        var rows = [];
        while (i < lines.length && isTableLine(lines[i])) {
          if (!isSeparatorRow(lines[i])) rows.push(lines[i].trim());
          i++;
        }
        content.push({
          type: "codeBlock",
          attrs: { language: "text" },
          content: [{ type: "text", text: rows.join("\n") || " " }]
        });
        continue;
      }

      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        content.push({
          type: "heading",
          attrs: { level: Math.min(6, heading[1].length) },
          content: inlineToAdf(heading[2])
        });
        i++;
        continue;
      }

      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        content.push({ type: "rule" });
        i++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i++;
        }
        content.push({
          type: "blockquote",
          content: [adfParagraph(quote.join(" ").trim())]
        });
        continue;
      }

      var bullets = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        bullets.push(lines[i].replace(/^\s*[-*+]\s+/, "").replace(/^\[[ xX]\]\s*/, function (m) {
          return /x/i.test(m) ? "✅ " : "☐ ";
        }));
        i++;
      }
      if (bullets.length) {
        content.push({ type: "bulletList", content: bullets.map(adfListItem) });
        continue;
      }

      var ordered = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        ordered.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i++;
      }
      if (ordered.length) {
        content.push({ type: "orderedList", content: ordered.map(adfListItem) });
        continue;
      }

      if (!line.trim()) { i++; continue; }

      // paragraph: gather until a blank line or a block starter
      var para = [];
      while (i < lines.length && lines[i].trim() &&
        !/^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s)/.test(lines[i]) &&
        !isTableLine(lines[i]) &&
        !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        para.push(lines[i].trim());
        i++;
      }
      if (para.length) content.push(adfParagraph(para.join(" ")));
      else i++;
    }

    if (!content.length) content.push(adfParagraph("(empty report)"));
    return { type: "doc", version: 1, content: content };
  }

  /** Minimal Markdown → Jira wiki markup, for Jira Server / Data Center. */
  function markdownToJiraWiki(markdown) {
    return str(markdown)
      .replace(/^######\s+(.*)$/gm, "h6. $1")
      .replace(/^#####\s+(.*)$/gm, "h5. $1")
      .replace(/^####\s+(.*)$/gm, "h4. $1")
      .replace(/^###\s+(.*)$/gm, "h3. $1")
      .replace(/^##\s+(.*)$/gm, "h2. $1")
      .replace(/^#\s+(.*)$/gm, "h1. $1")
      .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "* ")
      .replace(/^\s*[-*+]\s+/gm, "* ")
      .replace(/\*\*([^*]+)\*\*/g, "*$1*")
      .replace(/`([^`]+)`/g, "{{$1}}")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "[$1|$2]")
      .replace(/^---$/gm, "----");
  }

  // ------------------------------------------------------------ Slack

  /** Markdown → Slack mrkdwn. */
  function markdownToSlackMrkdwn(markdown) {
    var lines = str(markdown).replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var inCode = false;
    var inTable = false;

    lines.forEach(function (line) {
      if (/^\s*```/.test(line)) {
        if (inTable) { out.push("```"); inTable = false; }
        inCode = !inCode;
        out.push("```");
        return;
      }
      if (inCode) { out.push(line); return; }

      var isTableRow = /^\s*\|.*\|\s*$/.test(line);
      if (isTableRow) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) return;
        if (!inTable) { out.push("```"); inTable = true; }
        out.push(line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(function (c) { return c.trim(); }).join("   "));
        return;
      }
      if (inTable) { out.push("```"); inTable = false; }

      var t = line
        .replace(/^#{1,6}\s+(.*)$/, "*$1*")
        .replace(/\*\*([^*]+)\*\*/g, "*$1*")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
        .replace(/<((?:https?|mailto):[^>\s]+)>/g, "<$1>")
        .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, function (m) { return /x/i.test(m) ? "✅ " : "☐ "; })
        .replace(/^\s*[-*+]\s+/, "• ");
      out.push(t);
    });
    if (inTable) out.push("```");
    return out.join("\n");
  }

  function chunkText(text, size) {
    var chunks = [];
    var t = str(text);
    while (t.length > size) {
      var cut = t.lastIndexOf("\n", size);
      if (cut < size * 0.5) cut = size;
      chunks.push(t.slice(0, cut));
      t = t.slice(cut).replace(/^\n+/, "");
    }
    if (t.length) chunks.push(t);
    return chunks;
  }

  /** Slack Block Kit payload (max 50 blocks, 3000 chars per text block). */
  function buildSlackPayload(input) {
    input = input || {};
    var title = truncate(str(input.title).trim() || "Bug report", 140);
    var mrkdwn = markdownToSlackMrkdwn(input.markdown);

    var blocks = [];
    blocks.push({ type: "header", text: { type: "plain_text", text: title, emoji: true } });

    var meta = [];
    if (input.url) meta.push("<" + str(input.url) + "|page>");
    if (input.severity) meta.push("Severity: " + str(input.severity));
    if (input.frequency) meta.push("Frequency: " + str(input.frequency));
    if (meta.length) {
      blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: truncate(meta.join(" · "), 2900) }] });
    }
    blocks.push({ type: "divider" });

    chunkText(mrkdwn, 2900).slice(0, 46).forEach(function (chunk) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
    });

    return {
      target: "slack",
      method: "POST",
      url: str(input.webhookUrl).trim(),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: title + (input.url ? " — " + str(input.url) : ""),
        blocks: blocks.slice(0, 50),
        unfurl_links: false
      }),
      describe: function () { return "Report posted to Slack"; }
    };
  }

  // ------------------------------------------------------------ Jira payloads

  function buildJiraIssue(input, cfg) {
    cfg = cfg || {};
    input = input || {};
    var base = trimSlash(cfg.baseUrl);
    if (!base) throw new Error("Jira base URL is missing — add it in Options.");
    if (!str(cfg.email).trim()) throw new Error("Jira email is missing — add it in Options.");
    if (!str(cfg.token).trim()) throw new Error("Jira API token is missing — add it in Options.");
    if (!str(cfg.projectKey).trim()) throw new Error("Jira project key is missing — add it in Options.");

    var deployment = cfg.deployment === "server" ? "server" : "cloud";
    var apiVersion = deployment === "server" ? "2" : "3";
    var summary = truncate(str(input.title).trim() || "Bug report", 250);
    var description = deployment === "server"
      ? markdownToJiraWiki(input.markdown)
      : markdownToADF(input.markdown);

    var fields = {
      project: { key: str(cfg.projectKey).trim().toUpperCase() },
      summary: summary,
      description: description,
      issuetype: { name: str(cfg.issueType || "Bug").trim() }
    };

    // Priority is optional and Jira-specific; only send if the user set one.
    if (str(cfg.priority).trim()) fields.priority = { name: str(cfg.priority).trim() };
    var labels = splitList(cfg.labels);
    if (labels.length) fields.labels = labels.slice(0, 10);

    var auth = "Basic " + toBase64(str(cfg.email).trim() + ":" + str(cfg.token).trim());

    return {
      target: "jira",
      method: "POST",
      url: base + "/rest/api/" + apiVersion + "/issue",
      headers: {
        "Accept": "application/json",
        "Authorization": auth,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ fields: fields }),
      resultUrl: function (json) {
        return json && json.key ? base + "/browse/" + json.key : base;
      },
      describe: function (json) {
        return json && json.key ? "Created " + json.key : "Issue created";
      }
    };
  }

  function toBase64(s) {
    if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(s)));
    /* istanbul ignore next — Node fallback for tests */
    return Buffer.from(String(s), "utf8").toString("base64");
  }

  // ------------------------------------------------------------ generic webhook

  function buildWebhookPayload(input, cfg) {
    cfg = cfg || {};
    input = input || {};
    if (!/^https?:\/\//i.test(str(cfg.url))) throw new Error("Webhook URL must start with http:// or https://");

    var bundle = {
      source: "repropack",
      version: VERSION,
      event: "bug_report",
      sentAt: new Date(input.now || Date.now()).toISOString(),
      report: {
        title: str(input.title),
        markdown: str(input.markdown),
        url: str(input.url),
        pageTitle: str(input.pageTitle),
        severity: str(input.severity),
        frequency: str(input.frequency),
        capturedAt: input.capturedAt || "",
        errorCount: typeof input.errorCount === "number" ? input.errorCount : null,
        failedRequestCount: typeof input.failedRequestCount === "number" ? input.failedRequestCount : null,
        fingerprint: input.fingerprint || ""
      }
    };
    var headers = { "Content-Type": "application/json" };
    if (str(cfg.token).trim()) headers["Authorization"] = "Bearer " + str(cfg.token).trim();

    return {
      target: "webhook",
      method: "POST",
      url: str(cfg.url).trim(),
      headers: headers,
      body: JSON.stringify(bundle),
      describe: function () { return "Report delivered to your webhook"; }
    };
  }

  // ------------------------------------------------------------ dispatch + errors

  /**
   * buildPayload(target, input, cfg) — single entry point used by the popup.
   * input: { title, markdown, url, pageTitle, severity, frequency, capturedAt, errorCount, failedRequestCount, fingerprint }
   */
  function buildPayload(target, input, cfg) {
    switch (target) {
      case "github": return buildGitHubIssue(input, cfg);
      case "jira": return buildJiraIssue(input, cfg);
      case "slack": return buildSlackPayload(Object.assign({}, input, { webhookUrl: (cfg || {}).webhookUrl }));
      case "webhook": return buildWebhookPayload(input, cfg);
      default: throw new Error("Unknown destination: " + str(target));
    }
  }

  /** Turn a failed response into an actionable sentence (never a guess). */
  function explainHttpError(target, status, bodyText) {
    var detail = "";
    var body = str(bodyText);
    try {
      var json = JSON.parse(body);
      detail = json.message || json.error_description || json.error || (json.errors && JSON.stringify(json.errors)) || "";
      if (!detail && json.description) detail = json.description;
      if (typeof detail === "object") detail = JSON.stringify(detail);
    } catch (e) {
      detail = truncate(body.replace(/\s+/g, " ").trim(), 200);
    }
    detail = truncate(detail, 240);

    var base;
    if (status === 401) base = target === "github" ? "Token rejected (401). Check the token in Options." : "Not authorised (401). Check the email + API token.";
    else if (status === 403) base = "Forbidden (403). The credential may lack the needed scope, or the rate limit was hit.";
    else if (status === 404) {
      if (target === "github") base = "Not found (404). Check the repository name and that the token can see it.";
      else if (target === "slack") base = "Not found (404). The Slack webhook URL may be mistyped or revoked.";
      else if (target === "webhook") base = "Not found (404). Check the webhook URL.";
      else base = "Not found (404). Check the site URL / project key.";
    }
    else if (status === 413) base = "Payload too large (413). Shorten the report or drop the HAR attachment.";
    else if (status === 422) base = "Rejected as invalid (422). The destination needs a field ReproPack did not supply.";
    else if (status === 429) base = "Rate limited (429). Wait a moment and try again.";
    else if (status >= 500) base = "Destination error (" + status + "). This is on their side — try again later.";
    else if (status >= 400) base = "Request rejected (" + status + ").";
    else base = "Unexpected response (" + status + ").";

    return detail ? base + " Details: " + detail : base;
  }

  var api = {
    VERSION: VERSION,
    parseGitHubRepo: parseGitHubRepo,
    validateTarget: validateTarget,
    buildGitHubIssue: buildGitHubIssue,
    buildJiraIssue: buildJiraIssue,
    buildSlackPayload: buildSlackPayload,
    buildWebhookPayload: buildWebhookPayload,
    buildPayload: buildPayload,
    explainHttpError: explainHttpError,
    markdownToADF: markdownToADF,
    markdownToJiraWiki: markdownToJiraWiki,
    markdownToSlackMrkdwn: markdownToSlackMrkdwn,
    inlineToAdf: inlineToAdf,
    chunkText: chunkText,
    truncate: truncate,
    splitList: splitList
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.ReproPackFiling = api;
})(typeof self !== "undefined" ? self : this);

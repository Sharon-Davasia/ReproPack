/**
 * Unit tests for lib/filing.js — one-click filing payload builders.
 * These are pure builders; nothing here touches the network.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const F = require("../lib/filing.js");

const markdown = [
  "# Bug: Pay button crashes checkout",
  "",
  "| Field | Value |",
  "|---|---|",
  "| **URL** | <https://shop.test/checkout> |",
  "",
  "## Summary",
  "Clicking Pay shows a blank page.",
  "",
  "## Steps to reproduce",
  "1. Open checkout",
  "2. Click Pay now",
  "3. Page goes blank",
  "",
  "- [ ] **Severity** — who is blocked?",
  "- [x] Screenshot captured",
  "",
  "```js",
  "TypeError: boom",
  "```",
  "",
  "> Quoted note",
  "",
  "---"
].join("\n");

const input = {
  title: "Pay button crashes checkout",
  markdown: markdown,
  url: "https://shop.test/checkout",
  pageTitle: "Checkout",
  severity: "Blocker — cannot proceed",
  frequency: "Always",
  errorCount: 2,
  failedRequestCount: 1,
  fingerprint: "abc123"
};

// ------------------------------------------------------------ GitHub

test("parseGitHubRepo accepts owner/repo and URLs", () => {
  assert.deepEqual(F.parseGitHubRepo("acme/web"), { owner: "acme", repo: "web" });
  assert.deepEqual(F.parseGitHubRepo("https://github.com/acme/web/issues"), { owner: "acme", repo: "web" });
  assert.deepEqual(F.parseGitHubRepo("git@github.com:acme/web.git"), null);
  assert.deepEqual(F.parseGitHubRepo("https://github.com/acme/web.git"), { owner: "acme", repo: "web" });
  assert.equal(F.parseGitHubRepo(""), null);
  assert.equal(F.parseGitHubRepo("nope"), null);
});

test("validateTarget lists exactly what GitHub is missing", () => {
  const missing = F.validateTarget("github", {});
  assert.deepEqual(missing.map((m) => m.field).sort(), ["repo", "token"]);
  assert.deepEqual(F.validateTarget("github", { token: "t", repo: "acme/web" }), []);
});

test("validateTarget handles jira, slack and webhook requirements", () => {
  const jira = F.validateTarget("jira", {}).map((m) => m.field);
  assert.ok(jira.includes("baseUrl") && jira.includes("email") && jira.includes("token") && jira.includes("projectKey"));
  assert.equal(F.validateTarget("jira", { baseUrl: "https://x.atlassian.net", email: "a@b.c", token: "t", projectKey: "ENG" }).length, 0);

  assert.equal(F.validateTarget("slack", { webhookUrl: "not-a-url" }).length, 1);
  assert.equal(F.validateTarget("slack", { webhookUrl: "https://hooks.slack.com/services/x" }).length, 0);

  assert.equal(F.validateTarget("webhook", { url: "ftp://x" }).length, 1);
  assert.equal(F.validateTarget("webhook", { url: "https://x.test/hook" }).length, 0);
});

test("buildGitHubIssue builds a POST to the issues endpoint", () => {
  const req = F.buildGitHubIssue(input, { token: "ghp_x", repo: "acme/web", labels: "bug, from-repropack", assignees: "octocat" });
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://api.github.com/repos/acme/web/issues");
  assert.equal(req.headers.Authorization, "Bearer ghp_x");
  assert.equal(req.headers["X-GitHub-Api-Version"], "2022-11-28");
  const body = JSON.parse(req.body);
  assert.equal(body.title, "Pay button crashes checkout");
  assert.equal(body.body, markdown);
  assert.deepEqual(body.labels, ["bug", "from-repropack"]);
  assert.deepEqual(body.assignees, ["octocat"]);
});

test("buildGitHubIssue honours a GitHub Enterprise API base", () => {
  const req = F.buildGitHubIssue(input, { token: "t", repo: "acme/web", apiBase: "https://ghe.corp/api/v3/" });
  assert.equal(req.url, "https://ghe.corp/api/v3/repos/acme/web/issues");
});

test("buildGitHubIssue rejects bad config loudly", () => {
  assert.throws(() => F.buildGitHubIssue(input, { token: "t", repo: "bad" }), /owner\/repo/);
  assert.throws(() => F.buildGitHubIssue(input, { repo: "acme/web" }), /token is missing/);
});

test("buildGitHubIssue truncates a very long title", () => {
  const req = F.buildGitHubIssue({ title: "x".repeat(400), markdown: "m" }, { token: "t", repo: "a/b" });
  assert.ok(JSON.parse(req.body).title.length <= 250);
});

test("github resultUrl and describe use the API response", () => {
  const req = F.buildGitHubIssue(input, { token: "t", repo: "acme/web" });
  assert.equal(req.resultUrl({ html_url: "https://github.com/acme/web/issues/7", number: 7 }), "https://github.com/acme/web/issues/7");
  assert.equal(req.resultUrl(null), "https://github.com/acme/web/issues");
  assert.match(req.describe({ number: 7 }), /Issue #7 created/);
});

// ------------------------------------------------------------ ADF / Jira

test("markdownToADF produces a valid doc with headings and paragraphs", () => {
  const doc = F.markdownToADF(markdown);
  assert.equal(doc.type, "doc");
  assert.equal(doc.version, 1);
  const types = doc.content.map((n) => n.type);
  assert.ok(types.includes("heading"));
  assert.ok(types.includes("paragraph"));
  assert.equal(doc.content[0].attrs.level, 1);
  assert.match(JSON.stringify(doc), /Pay button crashes checkout/);
});

test("markdownToADF converts lists, code, quotes and rules", () => {
  const doc = F.markdownToADF(markdown);
  const types = doc.content.map((n) => n.type);
  assert.ok(types.includes("orderedList"));
  assert.ok(types.includes("bulletList"));
  assert.ok(types.includes("codeBlock"));
  assert.ok(types.includes("blockquote"));
  assert.ok(types.includes("rule"));

  const ordered = doc.content.find((n) => n.type === "orderedList");
  assert.equal(ordered.content.length, 3);
  assert.equal(ordered.content[0].content[0].content[0].text, "Open checkout");

  const bullets = doc.content.find((n) => n.type === "bulletList");
  assert.equal(bullets.content.length, 2);
  assert.match(JSON.stringify(bullets), /☐/);
});

test("markdownToADF keeps tables readable as monospace blocks", () => {
  const doc = F.markdownToADF(markdown);
  const codeBlocks = doc.content.filter((n) => n.type === "codeBlock");
  const table = codeBlocks.find((n) => n.attrs && n.attrs.language === "text");
  assert.ok(table);
  assert.match(table.content[0].text, /\| Field \| Value \|/);
  assert.doesNotMatch(table.content[0].text, /\|---\|---\|/);
});

test("inlineToAdf adds marks for bold, code, links", () => {
  const nodes = F.inlineToAdf("**bold** and `code` and [docs](https://x.test)");
  const bold = nodes.find((n) => n.text === "bold");
  assert.deepEqual(bold.marks, [{ type: "strong" }]);
  const code = nodes.find((n) => n.text === "code");
  assert.deepEqual(code.marks, [{ type: "code" }]);
  const link = nodes.find((n) => n.text === "docs");
  assert.equal(link.marks[0].type, "link");
  assert.equal(link.marks[0].attrs.href, "https://x.test");
});

test("markdownToJiraWiki produces wiki markup for Server/DC", () => {
  const wiki = F.markdownToJiraWiki(markdown);
  assert.match(wiki, /^h1\. Bug: Pay button crashes checkout/m);
  assert.match(wiki, /h2\. Summary/);
  assert.match(wiki, /^\* \*Severity\* — who is blocked\?/m); // bullet + bold
  assert.doesNotMatch(wiki, /^## /m);
});

test("buildJiraIssue uses API v3 + ADF on Cloud", () => {
  const req = F.buildJiraIssue(input, {
    baseUrl: "https://team.atlassian.net",
    email: "me@corp.test",
    token: "tok",
    projectKey: "eng",
    issueType: "Bug"
  });
  assert.equal(req.url, "https://team.atlassian.net/rest/api/3/issue");
  assert.equal(req.headers.Authorization, "Basic " + Buffer.from("me@corp.test:tok").toString("base64"));
  const body = JSON.parse(req.body);
  assert.equal(body.fields.project.key, "ENG");
  assert.equal(body.fields.issuetype.name, "Bug");
  assert.equal(body.fields.description.type, "doc");
  assert.equal(body.fields.summary, "Pay button crashes checkout");
});

test("buildJiraIssue uses API v2 + wiki text on Server", () => {
  const req = F.buildJiraIssue(input, {
    baseUrl: "https://jira.corp.test/",
    email: "me@corp.test",
    token: "tok",
    projectKey: "ENG",
    deployment: "server"
  });
  assert.equal(req.url, "https://jira.corp.test/rest/api/2/issue");
  const body = JSON.parse(req.body);
  assert.equal(typeof body.fields.description, "string");
  assert.match(body.fields.description, /^h1\./);
});

test("buildJiraIssue includes optional priority and labels", () => {
  const req = F.buildJiraIssue(input, {
    baseUrl: "https://team.atlassian.net", email: "e@x.io", token: "t",
    projectKey: "ENG", priority: "High", labels: "from-repropack, bug"
  });
  const body = JSON.parse(req.body);
  assert.equal(body.fields.priority.name, "High");
  assert.deepEqual(body.fields.labels, ["from-repropack", "bug"]);
});

test("buildJiraIssue rejects incomplete config", () => {
  assert.throws(() => F.buildJiraIssue(input, {}), /base URL is missing/);
  assert.throws(() => F.buildJiraIssue(input, { baseUrl: "https://x" }), /email is missing/);
});

test("jira resultUrl builds a browse link", () => {
  const req = F.buildJiraIssue(input, { baseUrl: "https://team.atlassian.net", email: "e@x.io", token: "t", projectKey: "ENG" });
  assert.equal(req.resultUrl({ key: "ENG-12" }), "https://team.atlassian.net/browse/ENG-12");
  assert.equal(req.describe({ key: "ENG-12" }), "Created ENG-12");
});

// ------------------------------------------------------------ Slack

test("markdownToSlackMrkdwn converts headings, bold, links and bullets", () => {
  const out = F.markdownToSlackMrkdwn(markdown);
  assert.match(out, /^\*Bug: Pay button crashes checkout\*$/m);
  assert.match(out, /^\*Summary\*$/m);
  assert.match(out, /^☐ \*Severity\*/m);
  assert.match(out, /^✅ Screenshot captured/m);
  // Links outside tables become Slack link syntax.
  assert.match(F.markdownToSlackMrkdwn("[docs](https://x.test/a)"), /<https:\/\/x\.test\/a\|docs>/);
  // Tables are fenced so columns stay aligned, which keeps their markup literal.
  assert.match(out, /```\nField   Value\n/);
});

test("markdownToSlackMrkdwn fences tables so they stay aligned", () => {
  const out = F.markdownToSlackMrkdwn("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(out, /```/);
  assert.match(out, /1   2/);
});

test("buildSlackPayload builds Block Kit with a header and divider", () => {
  const req = F.buildSlackPayload(Object.assign({}, input, { webhookUrl: "https://hooks.slack.com/services/x" }));
  assert.equal(req.method, "POST");
  assert.equal(req.url, "https://hooks.slack.com/services/x");
  const body = JSON.parse(req.body);
  assert.equal(body.blocks[0].type, "header");
  assert.equal(body.blocks[0].text.text, "Pay button crashes checkout");
  assert.ok(body.blocks.some((b) => b.type === "divider"));
  assert.ok(body.blocks.length <= 50);
  assert.ok(body.text.length > 0);
});

test("buildSlackPayload respects Slack's 3000-char section limit", () => {
  const long = "# Title\n\n" + ("word ".repeat(2000));
  const req = F.buildSlackPayload({ title: "Long", markdown: long, webhookUrl: "https://hooks.slack.com/x" });
  const body = JSON.parse(req.body);
  body.blocks.forEach((b) => {
    if (b.text && b.type === "section") assert.ok(b.text.text.length <= 3000);
  });
});

test("chunkText splits on newlines and never exceeds the size", () => {
  const chunks = F.chunkText("a\n".repeat(50) + "b", 20);
  chunks.forEach((c) => assert.ok(c.length <= 20));
  assert.equal(chunks.join("").replace(/\n/g, "").length, 51);
});

// ------------------------------------------------------------ generic webhook

test("buildWebhookPayload bundles the report as JSON", () => {
  const req = F.buildWebhookPayload(input, { url: "https://hooks.test/x", token: "secret" });
  assert.equal(req.headers.Authorization, "Bearer secret");
  const body = JSON.parse(req.body);
  assert.equal(body.source, "repropack");
  assert.equal(body.event, "bug_report");
  assert.equal(body.report.title, "Pay button crashes checkout");
  assert.equal(body.report.markdown, markdown);
  assert.equal(body.report.errorCount, 2);
  assert.equal(body.report.fingerprint, "abc123");
  assert.ok(body.sentAt);
});

test("buildWebhookPayload rejects a non-http URL", () => {
  assert.throws(() => F.buildWebhookPayload(input, { url: "ftp://x" }), /http/);
});

// ------------------------------------------------------------ dispatch + errors

test("buildPayload dispatches to each destination", () => {
  assert.equal(F.buildPayload("github", input, { token: "t", repo: "a/b" }).target, "github");
  assert.equal(F.buildPayload("jira", input, { baseUrl: "https://x.test", email: "e", token: "t", projectKey: "E" }).target, "jira");
  assert.equal(F.buildPayload("slack", input, { webhookUrl: "https://hooks.slack.com/x" }).target, "slack");
  assert.equal(F.buildPayload("webhook", input, { url: "https://x.test/h" }).target, "webhook");
  assert.throws(() => F.buildPayload("carrier-pigeon", input, {}), /Unknown destination/);
});

test("explainHttpError gives actionable, non-speculative messages", () => {
  assert.match(F.explainHttpError("github", 401, ""), /Token rejected/);
  assert.match(F.explainHttpError("github", 404, ""), /repository name/);
  assert.match(F.explainHttpError("jira", 422, JSON.stringify({ errors: { summary: "required" } })), /invalid/);
  assert.match(F.explainHttpError("slack", 500, ""), /on their side/);
  assert.match(F.explainHttpError("webhook", 429, ""), /Rate limited/);
  assert.match(F.explainHttpError("github", 418, "teapot"), /teapot/);
});

test("splitList trims and drops empties", () => {
  assert.deepEqual(F.splitList(" a, b ,, c "), ["a", "b", "c"]);
  assert.deepEqual(F.splitList(["x", " y "]), ["x", "y"]);
  assert.deepEqual(F.splitList(""), []);
});

test("truncate keeps strings short with an ellipsis", () => {
  assert.equal(F.truncate("abcdef", 4).length, 4);
  assert.equal(F.truncate("abc", 10), "abc");
});

# 📦 ReproPack — Bug Report Capture

> Turn “it’s broken” into a report worth filing. Record what happened, capture the evidence, and ReproPack organizes it into a clean Markdown bug report — then files it to GitHub, Jira or Slack.

**Core promise: ReproPack organizes evidence — it never invents a cause.** Anything unknown becomes a checkbox under **Missing information**, never a guess. You review and edit the report before anything leaves your browser.

---

## What’s new in v0.2

The four flows, all in one extension:

| Flow | What it does |
|---|---|
| **⏱ Capture** | Record a **timeline** of clicks/navigations/submits/shortcut keys while you reproduce, capture a **video clip** of the tab, and export a **HAR-lite** file of every request. |
| **🚀 File** | Create a **GitHub issue**, **Jira issue** (Cloud ADF *or* Server/DC wiki markup), **Slack** message, or POST to your own **webhook** — one click, your credentials, straight from the browser. |
| **🧠 Intelligence** | **Severity suggestion** from observable signals (with its reasons and a caveat), and **duplicate detection** against the reports you already saved. |
| **📱 Platform** | **Firefox build** generated from the same source, and a **mobile PWA companion** that registers as a system **share target**. |

---

## Features

**Capture**
- Screenshot (`captureVisibleTab`), URL, title, viewport, referrer
- Console errors, unhandled rejections, `console.error`, failed resource loads — buffered from `document_start`
- Every `fetch()`/XHR request: method, URL, status, duration, mime (metadata only — never bodies)
- **Timeline recording**: clicks (with element descriptors), SPA navigations, form submits, navigation/shortcut keys, tab visibility — timestamped T+0.0s onward. **Typed text is never recorded.**
- **Video clip** via `tabCapture` + an offscreen `MediaRecorder` (up to 2 min, saved to Downloads)
- **HAR-lite export** (`1.2`-shaped, metadata only, redacted)

**Organize**
- Offline deterministic Markdown template — no server, no key, no network
- Optional **BYO-key AI** polish (OpenAI-compatible / Anthropic / Gemini) under a strict evidence-only prompt
- **Severity heuristic**: transparent score → level with per-signal reasons and confidence, always caveated. Your own severity always wins.
- **Duplicate detection**: fingerprints normalize ids, timestamps and line numbers, so the same bug on a different order id still matches. Shows match % and why.
- Editable report in a textarea; Markdown, Jira wiki and `.md`/`.har` exports

**File** (all from your browser, no ReproPack server)
- GitHub issues (labels, assignees, GitHub Enterprise API base)
- Jira Cloud (API v3, description converted to **ADF**) and Jira Server/DC (API v2, **wiki markup**)
- Slack incoming webhook (Block Kit, mrkdwn, auto-chunked under Slack’s limits)
- Generic webhook (`{ source, event, report: { title, markdown, url, severity, fingerprint, … } }`)

**Privacy**
- Redaction of bearer tokens, `key=value` secrets, emails and long opaque tokens — **on by default**
- Optional query-param/hash stripping
- Per-error exclusion, screenshot opt-out, timeline opt-out
- No telemetry, no server, no accounts. Credentials and reports live in `chrome.storage.local`.

---

## Install

### Chrome / Edge / Brave / Arc
1. Clone or download this repo.
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.
3. Pin **ReproPack**. Press `Ctrl+Shift+R` (`⌘+Shift+R`) on any broken page.

> Video clips need Chrome 116+ (offscreen API). Everything else works without it.

### Firefox
```bash
npm run build:firefox
```
Then `about:debugging` → **This Firefox** → **Load Temporary Add-on** → `dist/firefox/manifest.json`.
The build swaps the service worker for an event page, adds the add-on id, and moves `tabCapture`/`offscreen`/`downloads` to optional permissions (Firefox has no offscreen API, so clips are unavailable there — screenshots, timeline and HAR-lite all work).

### Mobile (PWA companion)
```bash
npm run demo -- 8000     # or: python3 -m http.server 8000
```
Open `/share/` on your phone over **HTTPS** (or `localhost`) and “Add to Home screen”. It registers as a **Web Share Target**: share a link from any app → ReproPack opens with the URL pre-filled → get the same Markdown report, offline, and share it back out.

---

## The four flows

### 1 · Capture flow
```
popup ──⏺ start recording──► content.js   (clicks, SPA navs, submits, keys, errors)
      ──🎬 start clip──────► background ──► offscreen.html  (MediaRecorder)
      ──📸 capture─────────► background ──► tabs.captureVisibleTab
      ──⬇ HAR-lite─────────► lib/har.js     (builds HAR from captured requests)
```
- The timeline survives a page reload (mirrored to `sessionStorage` while recording).
- **“Draft steps from the recording”** turns recorded clicks/navs into editable numbered steps — observed actions, never an inferred cause.
- Clips are written to your Downloads folder; the report references the file name so you attach it yourself.

### 2 · Filing flow
```
report + form ──► lib/filing.js (pure payload builder) ──► fetch() ──► GitHub / Jira / Slack / webhook
                                     │
                          validateTarget() tells you exactly what is missing
```
- File tab shows per-destination config with a **Ready / Missing: …** status.
- Confirmation dialog before anything is sent; the filed report is also saved to History.
- HTTP failures are explained, not guessed (`401` → check token, `404` → check repo/project, `422` → destination needs a field, `429` → rate limited…).

### 3 · Intelligence flow
```
evidence + form ──► lib/triage.js  → { level, confidence, reasons[], caveat }
                └─► lib/dupes.js   → fingerprint → matches in History
```
- The suggestion appears as a chip on the Capture tab with **“Use it”** — never applied silently.
- Duplicates show in the Report tab as *“Possible duplicates in your history”* with match % and reasons. Nothing is merged or deleted.

### 4 · Platform flow
- `lib/manifest-variants.js` derives the Firefox manifest; `npm run build:firefox` writes `dist/firefox/`.
- `share/` is a self-contained PWA (service worker + share target) using the same `lib/report.js`.
- Options page shows a live **capability report** (screenshot, timeline, clips, downloads, share sheet) for the browser you are running.

---

## Repository layout

| Path | Role |
|---|---|
| `manifest.json` | MV3 manifest (Chrome source of truth) |
| `content.js` | Buffers errors + requests, records the timeline |
| `background.js` | Screenshot, message relay, clip orchestration, downloads |
| `offscreen.html` / `offscreen.js` | MediaRecorder host for tab clips |
| `popup.html` / `popup.css` / `popup.js` | Capture · Report · File · History UI |
| `options.html` / `options.js` | AI, file destinations, defaults, capabilities, data export |
| `lib/report.js` | Report generator (Markdown, timeline, missing info, triage section) |
| `lib/timeline.js` | Timeline normalization, relative times, summaries |
| `lib/har.js` | HAR-lite builder + redaction |
| `lib/triage.js` | Severity heuristic (pure, deterministic) |
| `lib/dupes.js` | Fingerprints + similarity + duplicate search |
| `lib/filing.js` | GitHub / Jira (ADF + wiki) / Slack / webhook payload builders |
| `lib/ai.js` | Optional BYO-key AI organizer |
| `lib/manifest-variants.js` | Firefox manifest derivation + validation |
| `demo/index.html` | Live playground running the real modules |
| `share/` | Mobile PWA companion (share target, offline) |
| `tests/` | 120 tests (unit + jsdom integration) |
| `scripts/` | `validate.js`, `build-firefox.js`, `serve.js` |

---

## Development

```bash
npm install        # jsdom, for the UI integration tests
npm test           # 120 tests: lib units + popup/options/demo/share in jsdom
npm run validate   # manifest, missing files, JS syntax, Firefox variant, privacy defaults
npm run build:firefox
npm run demo       # http://localhost:8000/demo/ and /share/
```

The integration tests drive the **real** `popup.html` and `options.html` in jsdom with a stubbed `chrome` API: capture → record → generate → HAR → save → file (success and 401 paths). That catches renamed ids and handlers that throw before rendering. They skip cleanly if jsdom is not installed.

---

## Filing setup

**GitHub** — token with `repo` scope (classic) or *Issues: Read & write* (fine-grained), repository as `owner/repo`, optional labels/assignees. GitHub Enterprise: set the API base to `https://ghe.example.com/api/v3`.

**Jira Cloud** — site URL, account email, API token (`id.atlassian.com` → Security → API tokens), project key, issue type. Descriptions are converted to **ADF**; tables become monospace blocks so columns stay aligned.

**Jira Server / Data Center** — same fields, deployment = *Server/DC* → API v2 with **wiki markup** (`h2.`, `{{code}}`).

**Slack** — Incoming Webhook URL (Slack app → Incoming Webhooks → Add to channel). Posts a header, context line with the page + severity, and the report chunked under Slack’s 3000-char limit.

**Custom webhook** —
```http
POST https://your.app/hooks/repropack
Authorization: Bearer <optional>
Content-Type: application/json

{
  "source": "repropack", "version": "0.2.0", "event": "bug_report",
  "sentAt": "2026-11-15T10:00:00.000Z",
  "report": { "title": "…", "markdown": "…", "url": "…", "severity": "…",
              "errorCount": 2, "failedRequestCount": 1, "fingerprint": "1x0r8i5" }
}
```

---

## Report format (excerpt)

```markdown
# Bug: Pay button crashes checkout

| Field | Value |
|---|---|
| **URL** | <https://shop.example.com/checkout> |
| **Captured** | 15 Nov 2026, 10:00:01 |
| **Severity** | Blocker — cannot proceed |

> 📎 **Screenshot:** attached as `repropack-2026.png`

## Steps to reproduce
1. Open checkout
2. Click Pay now
3. Page goes blank

## Timeline (recorded)
- `T+0.0s` **Recording started** — https://shop.example.com/checkout
- `T+1.2s` **Clicked button#pay** — Pay now
- `T+2.4s` **Uncaught error** — TypeError: Cannot read properties of undefined

## Evidence
### Network (2 requests recorded, 1 failed)
- `POST https://api.example.com/pay` → **500** · 431 ms
### Attachments
- 🎬 **Video clip:** `repropack-clip-2026.webm` (4.3s) — saved to your Downloads folder
- 🌐 **HAR-lite:** 2 request(s), 1 failed — metadata only, no bodies or headers.

## Suggested severity (heuristic)
**Blocker — cannot proceed** · confidence 76%
- +3 · Uncaught page error was recorded
- +3 · Server returned 5xx to the page
_Heuristic from the captured evidence — not a diagnosis. The reporter's severity wins._

## Missing information
- [ ] **Severity / impact** — who is blocked, and how badly?
```

---

## Honest limitations

- **Clips** need Chrome 116+ (`tabCapture` + offscreen). Firefox and older Chrome fall back to screenshots.
- **HAR-lite** has no request/response bodies or headers — ReproPack never reads them.
- **Typed text is never recorded**; only navigation/shortcut keys.
- **Jira tables** become monospace blocks (ADF tables are awkward and this keeps alignment).
- **Duplicate detection is a heuristic**, not a database: it compares against *your* saved reports by error signature and page pattern. It shows its reasons and never auto-closes anything.
- **Mobile companion** cannot read console output or take a screenshot — the report says so under Missing information.
- While recording, the timeline is mirrored to the page's `sessionStorage` so a reload does not lose evidence. It contains the page's own errors, not your typed text.

## Roadmap

- [ ] Session replay links and multi-tab timelines
- [ ] Screenshot annotation/blur before attaching
- [ ] Team templates + custom severity rules per workspace
- [ ] GitLab / Linear / Azure Boards destinations (payload builders are already decoupled)
- [ ] Firefox clips once an equivalent offscreen API lands

## Contributing

Issues and PRs welcome. Keep the promise: **organize, don’t invent.** If a change would make ReproPack guess a root cause, it needs a “Missing information” checkbox instead. `npm run check` (validate + tests) must pass.

## License

MIT.

#!/usr/bin/env node
/**
 * Tiny static server for the demo playground and the mobile companion.
 *
 *   npm run demo        → http://localhost:8000/demo/
 *   npm run demo -- 3000
 *
 * The mobile companion (share/) needs a secure context for the service worker:
 * localhost counts, a LAN IP does not — use a tunnel for real phones.
 */
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const port = Number(process.argv[2] || process.env.PORT || 8000);
const host = process.env.HOST || "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".har": "application/json; charset=utf-8"
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  if (urlPath.endsWith("/")) urlPath += "index.html";

  const filePath = path.join(root, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found: " + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store",
      // Needed for the PWA service worker on some browsers during local dev.
      "Service-Worker-Allowed": "/"
    }).end(data);
  });
});

server.listen(port, host, () => {
  console.log("ReproPack dev server");
  console.log("  demo     → http://localhost:" + port + "/demo/");
  console.log("  mobile   → http://localhost:" + port + "/share/");
  console.log("  tests    → npm test");
  console.log("  firefox  → npm run build:firefox");
});

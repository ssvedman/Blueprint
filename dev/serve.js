#!/usr/bin/env node
/* ============================================================================
   Blueprint — local dev server.   Run:  node serve.js   →  http://localhost:8080

   Deliberately dependency-free: node's built-in http and fs only, so this works
   on a locked-down machine with no npm install and nothing to audit.

   Serves the folder as static files with caching disabled, which matters because
   the whole point of this environment is editing app.js and hitting reload.
   ========================================================================== */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");   // serve the project root, not dev/
const PORT = Number(process.env.PORT || 8080);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".sql": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch (_) {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (urlPath === "/") urlPath = "/index.html";

  // Resolve and confirm the result is still inside ROOT, so a crafted path
  // cannot walk out of the served directory.
  const full = path.resolve(ROOT, "." + urlPath);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.readFile(full, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<h1>404</h1><p>' + urlPath + ' not found.</p><p><a href="/">Back to Blueprint</a></p>');
      console.log("  404  " + urlPath);
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
      // No caching: edit, reload, see the change.
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache"
    });
    res.end(buf);
    console.log("  200  " + urlPath);
  });
});

server.on("error", e => {
  if (e.code === "EADDRINUSE") {
    console.error("\n  Port " + PORT + " is already in use.");
    console.error("  Try:  PORT=8081 node serve.js\n");
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, () => {
  console.log("\n  Blueprint — local dev server");
  console.log("  " + "─".repeat(46));
  console.log("  →  http://localhost:" + PORT);
  console.log("\n  Mode:  LOCAL (in-memory mock — localhost always uses the mock)");
  console.log("         add ?live=1 to hit the real Supabase project instead");
  console.log("  Data:  dev/mock-db.js — resets on every page reload");
  console.log("  Login: any password of 4+ characters");
  console.log("\n  Tests: node tests/core.test.js && node tests/mock.test.js");
  console.log("  Stop:  Ctrl+C\n");
});

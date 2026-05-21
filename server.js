const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, "state.json");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function readState() {
  try {
    return fs.readFileSync(STATE_FILE, "utf8");
  } catch {
    return JSON.stringify({ groups: {}, ko: {} });
  }
}

function writeState(json) {
  fs.writeFileSync(STATE_FILE, json);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/state" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(readState());
    return;
  }

  if (url === "/api/state" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
          throw new Error("expected object");
        }
        writeState(JSON.stringify(parsed, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  let p = url === "/" ? "/index.html" : url;
  const fullPath = path.normalize(path.join(ROOT, p));
  if (!fullPath.startsWith(ROOT)) {
    res.writeHead(403); res.end("forbidden"); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(fullPath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`Copa 2026 rodando em http://localhost:${PORT}`);
  console.log(`State file: ${STATE_FILE}`);
});

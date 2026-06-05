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

// Conexões SSE abertas. Quando o último cliente sai e nenhum reconecta
// dentro do GRACE_MS, o processo encerra — perfeito pra "fechar a aba
// derruba o servidor", sem matar tudo num reload momentâneo.
const liveClients = new Set();
const GRACE_MS = 3000;
let shutdownTimer = null;

function scheduleShutdownIfIdle() {
  if (liveClients.size > 0) return;
  if (shutdownTimer) return;
  shutdownTimer = setTimeout(() => {
    if (liveClients.size === 0) {
      console.log("Última aba fechada. Encerrando.");
      process.exit(0);
    }
  }, GRACE_MS);
}

function cancelShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if (url === "/api/heartbeat" && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write("retry: 10000\n\n");
    liveClients.add(res);
    cancelShutdown();
    const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 15000);
    const cleanup = () => {
      clearInterval(ka);
      liveClients.delete(res);
      scheduleShutdownIfIdle();
    };
    req.on("close", cleanup);
    req.on("error", cleanup);
    return;
  }

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
  // Se nenhum browser conectar em 30s (start.command falhou em abrir,
  // por exemplo), encerra sozinho em vez de virar processo zumbi.
  setTimeout(() => {
    if (liveClients.size === 0) {
      console.log("Nenhum cliente conectou. Encerrando.");
      process.exit(0);
    }
  }, 30000);
});

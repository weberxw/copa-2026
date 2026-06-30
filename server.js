// Servidor para dev local / hosts "always-on". Em produção serverless (Vercel)
// quem responde /api/state é api/state.js e a auth é o middleware.js — ambos
// reaproveitam a mesma lógica de lib/store.js.
const http = require("http");
const fs = require("fs");
const path = require("path");
const store = require("./lib/store");

const PORT = process.env.PORT || 5173;
const ROOT = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // Health check público (sem auth).
  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  const user = store.authUserFromHeader(req.headers["authorization"]);
  if (store.USE_AUTH && !user) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Copa 2026", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Autenticação necessária.");
    return;
  }
  const stateUser = user || "default";

  if (url === "/api/state" && req.method === "GET") {
    store.readState(stateUser)
      .then((bodyOut) => {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Auth-User": stateUser,
          "Cache-Control": "no-store",
        });
        res.end(bodyOut);
      })
      .catch((e) => {
        console.error("Erro ao ler estado:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"read failed"}');
      });
    return;
  }

  if (url === "/api/state" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on("end", async () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
        if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
          throw new Error("expected object");
        }
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
        return;
      }
      try {
        await store.writeState(stateUser, JSON.stringify(parsed, null, 2));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      } catch (e) {
        console.error("Erro ao salvar estado:", e.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end('{"error":"write failed"}');
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
  console.log(`Copa 2026 rodando na porta ${PORT}`);
  console.log(`Persistência: ${store.USE_REDIS ? "Upstash Redis" : "arquivo local (state.json)"}`);
  console.log(`Basic Auth: ${store.USE_AUTH ? "ativada" : "desativada"}`);
});

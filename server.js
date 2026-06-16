const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, "state.json");
const EMPTY_STATE = JSON.stringify({ groups: {}, ko: {} });

// Limpa aspas/espaços acidentais nos env vars. O painel REST do Upstash mostra
// os valores em formato .env com aspas (UPSTASH_..._URL="https://..."), então é
// comum colá-las junto — o que quebraria a URL/token.
function cleanEnv(v) {
  return (v || "").trim().replace(/^["']|["']$/g, "").trim();
}

// Persistência: Upstash Redis (REST) se configurado; senão arquivo local.
const REDIS_URL = cleanEnv(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, "");
const REDIS_TOKEN = cleanEnv(process.env.UPSTASH_REDIS_REST_TOKEN);
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const STATE_KEY = "copa2026-state";

// Basic Auth: ativada só quando as duas env vars existem.
const AUTH_USER = process.env.BASIC_AUTH_USER || "";
const AUTH_PASS = process.env.BASIC_AUTH_PASS || "";
const USE_AUTH = !!(AUTH_USER && AUTH_PASS);

// Auto-finalização ao ficar ocioso: só local. No Render (env RENDER) fica off,
// senão o serviço reiniciaria em loop.
const AUTO_SHUTDOWN = !process.env.RENDER;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function checkAuth(req) {
  if (!USE_AUTH) return true;
  const header = req.headers["authorization"] || "";
  const expected = "Basic " + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString("base64");
  return safeEqual(header, expected);
}

function readLocalState() {
  try {
    return fs.readFileSync(STATE_FILE, "utf8");
  } catch {
    return EMPTY_STATE;
  }
}

function hasResults(jsonStr) {
  try {
    const o = JSON.parse(jsonStr);
    const g = o && o.groups ? Object.keys(o.groups).length : 0;
    const k = o && o.ko ? Object.keys(o.ko).length : 0;
    return g + k > 0;
  } catch {
    return false;
  }
}

async function readState() {
  if (USE_REDIS) {
    const r = await fetch(`${REDIS_URL}/get/${STATE_KEY}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    });
    if (!r.ok) throw new Error(`redis get ${r.status}`);
    const data = await r.json();
    if (data.result != null) return data.result;
    // Redis vazio: semeia uma única vez a partir do state.json versionado,
    // pra não perder os resultados já preenchidos ao migrar pro deploy.
    const seed = readLocalState();
    if (hasResults(seed)) {
      try {
        await writeState(seed);
        console.log("Redis vazio — semeado a partir do state.json.");
      } catch (e) {
        console.error("Falha ao semear o Redis:", e.message);
      }
      return seed;
    }
    return EMPTY_STATE;
  }
  return readLocalState();
}

async function writeState(json) {
  if (USE_REDIS) {
    const r = await fetch(`${REDIS_URL}/set/${STATE_KEY}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      body: json,
    });
    if (!r.ok) throw new Error(`redis set ${r.status}`);
    return;
  }
  fs.writeFileSync(STATE_FILE, json);
}

// Conexões SSE abertas. Quando o último cliente sai e nenhum reconecta
// dentro do GRACE_MS, o processo encerra — perfeito pra "fechar a aba
// derruba o servidor", sem matar tudo num reload momentâneo.
const liveClients = new Set();
const GRACE_MS = 3000;
let shutdownTimer = null;

function scheduleShutdownIfIdle() {
  if (!AUTO_SHUTDOWN) return;
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

  if (!checkAuth(req)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Copa 2026", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Autenticação necessária.");
    return;
  }

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
    readState()
      .then((bodyOut) => {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
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
        await writeState(JSON.stringify(parsed, null, 2));
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
  console.log(`Persistência: ${USE_REDIS ? "Upstash Redis" : `arquivo local (${STATE_FILE})`}`);
  console.log(`Basic Auth: ${USE_AUTH ? "ativada" : "desativada"}`);
  // Local: se nenhum browser conectar em 30s (start.command falhou em abrir,
  // por exemplo), encerra sozinho em vez de virar processo zumbi. No Render
  // (AUTO_SHUTDOWN=false) isso fica off, senão o serviço reiniciaria em loop.
  if (AUTO_SHUTDOWN) {
    setTimeout(() => {
      if (liveClients.size === 0) {
        console.log("Nenhum cliente conectou. Encerrando.");
        process.exit(0);
      }
    }, 30000);
  }
});

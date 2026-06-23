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

// Usuários para Basic Auth, em dois formatos combinados:
//  - legado: BASIC_AUTH_USER + BASIC_AUTH_PASS (1 usuário)
//  - lista:  BASIC_AUTH_USERS="user1:senha1,user2:senha2"
// Cada usuário tem sua própria tabela de resultados no Redis. O 1º da lista é o
// "primário" e herda os dados do modo single-user (chave legada copa2026-state).
function parseUsers() {
  const list = [];
  const seen = new Set();
  const add = (user, pass) => {
    user = (user || "").trim();
    if (!user || !pass || seen.has(user)) return;
    seen.add(user);
    list.push({ user, pass });
  };
  add(cleanEnv(process.env.BASIC_AUTH_USER), process.env.BASIC_AUTH_PASS || "");
  for (const pair of cleanEnv(process.env.BASIC_AUTH_USERS).split(",")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    add(pair.slice(0, i), pair.slice(i + 1).trim());
  }
  return list;
}
const USERS = parseUsers();
const USE_AUTH = USERS.length > 0;
const PRIMARY_USER = USERS.length ? USERS[0].user : "";

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

// Retorna o nome do usuário autenticado, ou null. Cada usuário tem sua tabela.
function authUser(req) {
  if (!USE_AUTH) return null;
  const header = req.headers["authorization"] || "";
  if (!header.startsWith("Basic ")) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    return null;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  const user = decoded.slice(0, i);
  const pass = decoded.slice(i + 1);
  for (const u of USERS) {
    if (safeEqual(user, u.user) && safeEqual(pass, u.pass)) return u.user;
  }
  return null;
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

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
  });
  if (!r.ok) throw new Error(`redis get ${r.status}`);
  const data = await r.json();
  return data.result; // string ou null
}

async function redisSet(key, value) {
  const r = await fetch(`${REDIS_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: value,
  });
  if (!r.ok) throw new Error(`redis set ${r.status}`);
}

// Chave por usuário: cada um tem sua própria tabela de resultados.
function userKey(user) {
  return `${STATE_KEY}:${String(user).replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

async function readState(user) {
  if (!USE_REDIS) return readLocalState();
  const key = userKey(user);
  const cur = await redisGet(key);
  if (cur != null) return cur;
  // Tabela do usuário ainda não existe. Só o usuário primário herda os dados
  // antigos do modo single-user: primeiro a chave legada, depois o state.json.
  if (user === PRIMARY_USER) {
    const legacy = await redisGet(STATE_KEY);
    if (legacy != null && hasResults(legacy)) {
      await redisSet(key, legacy);
      console.log(`Migrado ${STATE_KEY} -> ${key}`);
      return legacy;
    }
    const seed = readLocalState();
    if (hasResults(seed)) {
      await redisSet(key, seed);
      console.log(`Semeado ${key} a partir do state.json.`);
      return seed;
    }
  }
  return EMPTY_STATE;
}

async function writeState(user, json) {
  if (!USE_REDIS) {
    fs.writeFileSync(STATE_FILE, json);
    return;
  }
  await redisSet(userKey(user), json);
}

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  // Health check público (sem auth) — usado pelo keep-alive e por monitores.
  if (url === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }

  const user = authUser(req);
  if (USE_AUTH && !user) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="Copa 2026", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Autenticação necessária.");
    return;
  }
  const stateUser = user || "default";

  if (url === "/api/state" && req.method === "GET") {
    readState(stateUser)
      .then((bodyOut) => {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "X-Auth-User": stateUser,
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
        await writeState(stateUser, JSON.stringify(parsed, null, 2));
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
  console.log(`Basic Auth: ${USE_AUTH ? `${USERS.length} usuário(s) [${USERS.map((u) => u.user).join(", ")}]` : "desativada"}`);
});

// Keep-alive: o plano free do Render dorme após ~15 min sem tráfego. Um auto-ping
// a cada 10 min em /healthz mantém o serviço acordado, mesmo sem ninguém na página.
// Só liga no Render (RENDER_EXTERNAL_URL = URL pública do serviço).
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL) {
  const KEEPALIVE_MS = 10 * 60 * 1000;
  setInterval(() => {
    fetch(`${SELF_URL}/healthz`).catch((e) => console.error("keep-alive falhou:", e.message));
  }, KEEPALIVE_MS);
  console.log(`Keep-alive: auto-ping a cada 10 min em ${SELF_URL}/healthz`);
}

// Lógica compartilhada de persistência + autenticação.
// Usada tanto pelo server.js (dev local / hosts "always-on") quanto pela
// função serverless api/state.js (Vercel). Mantém um único lugar pra Redis,
// usuários e leitura/escrita do estado.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const STATE_FILE = path.join(ROOT, "state.json");
const EMPTY_STATE = JSON.stringify({ groups: {}, ko: {} });

// Limpa aspas/espaços acidentais nos env vars (o painel REST do Upstash mostra
// os valores em formato .env com aspas, e é comum colá-las junto).
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

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Valida o header Authorization (Basic) e retorna o usuário, ou null.
function authUserFromHeader(header) {
  if (!USE_AUTH) return null;
  header = header || "";
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
      return legacy;
    }
    const seed = readLocalState();
    if (hasResults(seed)) {
      await redisSet(key, seed);
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

module.exports = {
  EMPTY_STATE,
  USE_REDIS,
  USE_AUTH,
  PRIMARY_USER,
  authUserFromHeader,
  readState,
  writeState,
};

// Função serverless da Vercel para /api/state (GET lê, POST salva).
// A autenticação (gate) é feita no middleware.js; aqui re-validamos o header
// só para descobrir qual usuário é (cada um tem sua tabela no Redis).
const store = require("../lib/store");

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  const user = store.authUserFromHeader(req.headers["authorization"]) || "default";

  if (req.method === "GET") {
    try {
      const body = await store.readState(user);
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("X-Auth-User", user);
      res.setHeader("Cache-Control", "no-store");
      res.end(body);
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end('{"error":"read failed"}');
    }
    return;
  }

  if (req.method === "POST") {
    let parsed;
    try {
      const raw =
        req.body != null
          ? typeof req.body === "string"
            ? req.body
            : JSON.stringify(req.body)
          : await readRawBody(req);
      parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || Array.isArray(parsed) || parsed === null) {
        throw new Error("expected object");
      }
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: e.message }));
      return;
    }
    try {
      await store.writeState(user, JSON.stringify(parsed, null, 2));
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end('{"ok":true}');
    } catch (e) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end('{"error":"write failed"}');
    }
    return;
  }

  res.statusCode = 405;
  res.end("method not allowed");
};

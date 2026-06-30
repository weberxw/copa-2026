// Basic Auth no Edge (Vercel), equivalente ao que o server.js fazia: protege
// a página e a API. Só ativa se houver usuários configurados nas env vars
// (BASIC_AUTH_USER/PASS ou BASIC_AUTH_USERS). Sem isso, libera tudo.
export const config = {
  // Protege todas as rotas (página, assets e /api). O healthz fica de fora.
  matcher: ["/((?!healthz).*)"],
};

function parseUsers() {
  const clean = (v) => (v || "").trim().replace(/^["']|["']$/g, "").trim();
  const list = [];
  const seen = new Set();
  const add = (user, pass) => {
    user = (user || "").trim();
    if (!user || !pass || seen.has(user)) return;
    seen.add(user);
    list.push({ user, pass });
  };
  add(clean(process.env.BASIC_AUTH_USER), process.env.BASIC_AUTH_PASS || "");
  for (const pair of clean(process.env.BASIC_AUTH_USERS).split(",")) {
    const i = pair.indexOf(":");
    if (i < 0) continue;
    add(pair.slice(0, i), pair.slice(i + 1).trim());
  }
  return list;
}

function decodeBasic(b64) {
  try {
    // atob devolve "binary string"; recupera UTF-8 corretamente.
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

const UNAUTHORIZED = () =>
  new Response("Autenticação necessária.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Copa 2026", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });

export default function middleware(request) {
  const users = parseUsers();
  if (!users.length) return; // sem auth configurada -> libera

  const header = request.headers.get("authorization") || "";
  if (header.startsWith("Basic ")) {
    const decoded = decodeBasic(header.slice(6));
    const i = decoded.indexOf(":");
    if (i >= 0) {
      const user = decoded.slice(0, i);
      const pass = decoded.slice(i + 1);
      if (users.some((u) => u.user === user && u.pass === pass)) return; // ok
    }
  }
  return UNAUTHORIZED();
}

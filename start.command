#!/usr/bin/env bash
# Inicializador da Copa 2026: sobe o servidor Node e abre o app no browser.
# Pode ser executado pelo Finder com duplo clique (extensão .command).

set -e
cd "$(dirname "$0")"

PORT="${PORT:-5173}"
URL="http://localhost:$PORT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node não encontrado. Instale com: brew install node"
  read -n 1 -s -r -p "Pressione qualquer tecla para fechar..."
  exit 1
fi

# Se já tem algo escutando na porta, só abre o browser.
if lsof -nP -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Servidor já está rodando na porta $PORT. Abrindo $URL ..."
  open "$URL"
  exit 0
fi

# Abre o browser depois que o servidor subir.
( sleep 0.7 && open "$URL" ) &

echo "Subindo servidor em $URL"
echo "Para parar: Ctrl+C ou feche esta janela."
exec node server.js

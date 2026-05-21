# Copa do Mundo 2026

Aplicação local para acompanhar os 12 grupos da Copa do Mundo 2026, preencher placares e ver o chaveamento do mata-mata atualizar automaticamente.

## Recursos

- 12 grupos com 4 seleções cada (sorteio oficial FIFA, dez/2025)
- Classificação calculada em tempo real (Pts → SG → GP)
- Ranking dos 3º colocados com destaque pros 8 que avançam
- Mata-mata completo: 16-avos → oitavas → quartas → semis → 3º lugar → final
- Atribuição automática dos 3º colocados aos 8 slots do mata-mata (backtracking respeitando as restrições oficiais por slot)
- Placar de pênaltis quando há empate no tempo normal
- Troféu 🏆 com o campeão depois da final
- Datas e horários oficiais de cada jogo (UTC convertido pro fuso local)
- Persistência em arquivo JSON no projeto (`state.json`)
- Exportar/Importar JSON

## Stack

- HTML + JS vanilla (sem build, sem framework)
- Servidor Node mínimo (`http` puro, sem dependências) servindo arquivos estáticos e expondo `GET/POST /api/state`
- Bandeira de cada país via emoji Unicode

## Como rodar

```bash
node server.js
# abre http://localhost:5173
```

Ou no macOS, basta dar duplo clique em `start.command` (sobe o servidor e abre o navegador) ou usar o `Copa 2026.app` (mesmo comportamento, ícone bonitinho pro Dock).

## Estrutura

```
copa-2026/
├── index.html          App (interface + lógica)
├── server.js           Servidor Node (estáticos + API state.json)
├── start.command       Launcher pro macOS (duplo clique)
├── Copa 2026.app/      Bundle .app pro Dock
├── favicon.png         Ícone da aba do browser
└── state.json          Resultados salvos (gerado em runtime, ignorado pelo git)
```

## Fonte dos dados

- Grupos e horários: [FotMob API](https://www.fotmob.com/leagues/77/world-cup)
- Regras do chaveamento: [Wikipedia — 2026 FIFA World Cup knockout stage](https://en.wikipedia.org/wiki/2026_FIFA_World_Cup_knockout_stage)

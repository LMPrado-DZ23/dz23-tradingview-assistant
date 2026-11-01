# Atribuição e modificações

## Obra original

Este repositório é uma **obra derivada** de:

- **TradingView Assistant** — <https://github.com/akumidv/tradingview-assistant-chrome-extension>
- Autor original: **akumidv** (ver o README preservado em [UPSTREAM-README.md](UPSTREAM-README.md))
- Licença do original: **GPL-3.0**

O texto integral do README original foi mantido em `docs/UPSTREAM-README.md` justamente para que a origem continue legível
dentro deste repositório, em vez de desaparecer numa reescrita.

## Licença deste repositório

**GPL-3.0** (ver [LICENSE](../LICENSE)), a mesma do original. A GPL é *copyleft*: quem redistribuir precisa manter a mesma
licença e a atribuição. Nada aqui muda isso.

## O que foi modificado

O motor original (popup com abas, backtest via painel do TradingView, otimização de parâmetros) foi **preservado** e recebeu
uma plataforma em volta:

| Camada | O que é novo |
|---|---|
| Painel do copiloto | `extension/copilot/` — chat contextual, histórico, memória por estratégia, anexos |
| Gateway local | `gateway/` — token, CORS por allowlist, rate limit, SSE, fallback entre provedores |
| Native host | `native-host/` — sobe e supervisiona o gateway (Chrome MV3 não pode iniciar processo) |
| Configuração única | `extension/lib/config.js` — registro versionado, migração idempotente dos dados antigos |
| Inteligência de mercado | `extension/lib/marketIntel.js` — RSI, MACD, ATR, Bollinger, VWAP, padrões, divergências |
| Strategy Lab | `extension/quant/` — métricas, PBO, DSR, Monte Carlo, walk-forward |
| Pine Script | `extension/quant/pine*.mjs` — validação e detecção de look-ahead/repintura |
| Agentes | `extension/lib/agents.js` — Sofia orquestrando especialistas com contrato validado |
| Alertas e watchlists | `extension/settings/boards.js` — CRUD com confirmação e releitura |
| Verificação | `_aitna/tools/` — 31 verificações no gate, 732 testes, auditorias de segredo, permissão e documentação |

Arte: os ícones originais (candles com "BUY") foram substituídos pela marca do DZ23 — gerada por
`npm run brand:icons`, em `_aitna/tools/brand/icon.py`. A arte original continua no histórico do Git.

Modificações no que já existia: links de ajuda passaram a apontar para este repositório; diálogos de erro ganharam saída
(ver [DIALOGOS.md](DIALOGOS.md)); caminhos absolutos de máquina foram removidos do código.

## O que **não** foi feito

- Nenhum código proprietário de terceiros foi copiado. A referência ao TradingView Remix no pedido original serviu como
  referência de **funcionalidades e experiência**, não de implementação.
- Nenhum cookie de sessão do TradingView é lido ou transmitido — o mecanismo do Remix citado no pedido foi explicitamente
  recusado.
- A identidade visual do original não foi alterada sem motivo; o que mudou foi a camada em volta.

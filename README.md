# DZ23 TradingView Assistant

Copiloto de IA para gráficos do TradingView, com gateway local, inteligência de mercado e laboratório de estratégias que
não depende do painel do TradingView.

> **Sobre este repositório.** É uma **evolução** do
> [tradingview-assistant-chrome-extension](https://github.com/akumidv/tradingview-assistant-chrome-extension) (GPL-3.0), do
> qual preserva a atribuição em [docs/NOTICE.md](docs/NOTICE.md). **Não é a extensão publicada na Chrome Web Store** — aquela é o
> produto original. Esta versão é carregada **sem compactação**, a partir do código deste repositório.

## O que faz

| Área | O que está pronto e verificado |
|---|---|
| **Copiloto contextual** | conversa no painel com o gráfico aberto (símbolo, exchange, timeframe), candles reais com fonte e horário, indicadores calculados, histórico por ativo |
| **Inteligência de mercado** | RSI, MACD, médias, VWAP, Bollinger, ATR, tendência, divergências, padrões de candle, suportes e resistências — com as limitações declaradas quando faltam dados |
| **Pine Script** | validação de sintaxe, versão, look-ahead, repintura (`varip`, `calc_on_every_tick`) e referência a barra futura |
| **Strategy Lab** | backtest reproduzível: PnL, drawdown (pelo maior recuo percentual), Sharpe, Sortino, Calmar, PBO, DSR, Monte Carlo, walk-forward |
| **Agentes** | Sofia orquestra especialistas com contrato JSON validado e consenso por votação |
| **Alertas e watchlists** | criar/editar/pausar/excluir com confirmação e releitura do estado |
| **Gateway local** | `127.0.0.1:8777`, token obrigatório, allowlist exata de origem, rate limit, logs sem segredos |
| **Multi-provedor** | Ollama (local, grátis), OpenRouter, DeepSeek, Gemini, OpenAI, Anthropic, compatíveis |

## Instalação

```powershell
# 1. dependências
npm ci

# 2. extensão: chrome://extensions → modo desenvolvedor → "Carregar sem compactação"
#    selecione a pasta extension/ deste repositório

# 3. gateway (uma vez por sessão do Windows)
npm run gateway:dev
```

Passo a passo completo, com pré-requisitos e tabela de sintomas, em [docs/INSTALACAO.md](docs/INSTALACAO.md).

## Verificação

O projeto não pede confiança: pede que você rode.

```powershell
npm run verify        # gate com evidência + pacote + conferência dos números do relatório
```

Estado atual, medido nesta máquina: **32 verificações** no gate, **732 testes**, aceite **16/16** (2 dependências externas,
2 itens ausentes por decisão). O relatório completo está em [docs/ENTREGA.md](docs/ENTREGA.md) e a matriz de aceitação em
[docs/ACEITACAO.md](docs/ACEITACAO.md).

O que o CI cobre a cada push: lint, localização, documentação, segredos, permissões do manifest, cobertura de arquivos de
teste, exportações mortas, arquivos órfãos, controles inertes, as suítes de gateway/quant/dz23/mcp/extensão/ferramentas e a
sonda de contrato da API. Os testes E2E (Chrome real) rodam localmente: `npm run test:e2e`.

## Segurança

- O gateway escuta **só** em `127.0.0.1` e **recusa iniciar sem token**.
- CORS por **allowlist exata** do ID da extensão — outra extensão instalada não alcança o gateway.
- **Nunca** lê cookies do TradingView, nem envia sessão para fora.
- Chaves de provedor ficam no gateway (`~/.dz23/`), fora do pacote e do repositório.
- `npm run audit:secrets` roda no gate e reprova segredo versionado e caminho absoluto de máquina em código.

## Limitações declaradas

Nenhuma delas está escondida no código; todas estão no relatório com o motivo.

- **MCP oficial do TradingView**: o servidor responde *"é necessário um plano pago"* para esta conta. OAuth 2.1 + PKCE está
  implementado e testado contra servidor falso; falta a assinatura.
- **Desenho no gráfico** (linhas, zonas, Fibonacci) e **aplicar Pine no gráfico**: exigiriam a API interna do chart, que não é
  pública. Fazer por seletor DOM frágil seria mentira com aparência de recurso.
- **Notícias, fundamentos, calendário econômico, screener**: sem fonte licenciada integrada; scraping irregular está fora de
  questão.

## Documentação

| Documento | Para quê |
|---|---|
| [docs/INSTALACAO.md](docs/INSTALACAO.md) | instalar do zero, com sintomas e soluções |
| [docs/CONFIGURACAO.md](docs/CONFIGURACAO.md) | um registro de configuração, provedores, memória |
| [docs/ENTREGA.md](docs/ENTREGA.md) | relatório final: o que está provado e como |
| [docs/ACEITACAO.md](docs/ACEITACAO.md) | matriz dos critérios, com evidência por item |
| [docs/STRATEGY-LAB.md](docs/STRATEGY-LAB.md) | métricas e o que elas não dizem |
| [docs/PINE.md](docs/PINE.md) | validação de Pine Script |
| [docs/DIALOGOS.md](docs/DIALOGOS.md) | cada diálogo de erro e a sua saída |
| [docs/ROLLBACK.md](docs/ROLLBACK.md) | voltar atrás sem perder história |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | como as peças se ligam |

## Licença e atribuição

GPL-3.0 (ver [LICENSE](LICENSE)). Este projeto é obra derivada do
[tradingview-assistant-chrome-extension](https://github.com/akumidv/tradingview-assistant-chrome-extension); a atribuição e a
lista de modificações estão em [docs/NOTICE.md](docs/NOTICE.md). Se você for redistribuir, leia a licença: ela exige manter a mesma
licença e a atribuição.

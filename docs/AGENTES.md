# Agentes especialistas (Sofia)

A orquestração vive em `extension/lib/agents.js` e é exercitável por `npm run agents`. Ela não é um painel decorativo
de "12 agentes": são papéis com contrato fixo, que só podem citar a evidência que recebem.

## Papéis

| Papel | Objetivo | Foco |
|---|---|---|
| `market-analyst` | ler contexto, tendência e estrutura das métricas | trend, structure, rsi, ema |
| `technical-analyst` | níveis, momentum e volatilidade | structure, rsi, macd, atr, bollinger |
| `risk-manager` | o que invalidaria a leitura e o risco de estar errado | atr, structure |
| `qa-reviewer` | a conclusão se apoia nos dados e rotula interpretação? | — |

O plano é **determinístico**: a pergunta decide quais papéis entram (risco → `risk-manager`; técnico → `technical-analyst`;
`qa-reviewer` sempre). Mesma entrada, mesmo plano — há teste para isso.

## Contrato de resposta

Cada especialista responde **somente** JSON:

```json
{"stance":"alta|baixa|lateral|inconclusivo","confidence":0.0,"evidence":["..."],"interpretation":"...","invalidation":"..."}
```

Regras aplicadas no parser (`parseVerdict`):

- `stance` fora do vocabulário → parecer inválido (não é reinterpretado);
- `confidence` fora de 0–1 → inválido;
- conclusão (`alta`/`baixa`/`lateral`) **sem** evidência citada → inválido;
- `inconclusivo` pode vir sem evidência, mas deve dizer o que faltaria em `invalidation`.

Parecer inválido entra no trace como `invalid` e **não** vota no consenso.

## O que o especialista recebe

- o papel e o objetivo;
- a pergunta do usuário;
- **os números calculados** (RSI, ATR e %, MACD, Bollinger, EMA20/50, SMA20, VWAP, tendência por regra fixa, faixa e
  swings, amostra e timeframe) — não só os nomes das métricas;
- a instrução de responder `inconclusivo` quando faltar dado.

Isso foi descoberto em execução real: a primeira versão mandava apenas os **nomes** das métricas, e os três
especialistas responderam `inconclusivo` com a justificativa correta ("nenhum valor numérico foi fornecido"). O
comportamento estava certo; o prompt estava incompleto. Corrigido e coberto por teste.

## Validação cruzada

`crossValidate` conta os pareceres válidos e não chama de consenso o que não é:

- **consenso** exige maioria de 2+ e **zero** dissidentes;
- empate → `consensus: false`, motivo `empate entre pareceres`;
- todos inconclusivos → `inconclusivo`, motivo explícito;
- dissenso é preservado com papel e posição (`dissenters`).

## Limites e falhas

- timeout por agente (padrão 45 s) — o próximo agente segue;
- **uma** nova tentativa por agente (falha de rede, resposta inválida);
- toda tentativa entra no `trace` (papel, nº de tentativas, status, duração, erro, texto);
- o resumo termina com a frase de que parecer **não** é recomendação de operação.

## CLI

```powershell
npm run agents -- "tendência do BTC no 1h e o que invalidaria?" --symbol BTCUSDT --interval 1h
```

Sem `--live` ele apenas mostra o plano e os prompts completos: **nenhuma chamada a provedor**, nada é cobrado — seguro
em CI.

```powershell
$env:DZ23_GATEWAY_TOKEN = (Get-Content "$env:USERPROFILE\.dz23\gateway-token" -Raw).Trim()
npm run agents -- "tendência do BTC no 1h?" --symbol BTCUSDT --interval 1h --live
```

Com `--live` ele busca candles da fonte pública, calcula as métricas com o **mesmo** módulo do painel e chama o gateway
uma vez por especialista. Custa tokens do provedor configurado.

### Execução real registrada (2026-10-30)

```
Evidência: gráfico=sim · candles=200 · métricas=rsi, atr, macd, bollinger, ema20, structure, trend
Sofia · 3 parecer(es) · trace run-h1o9o89a
- market-analyst: baixa (0.75) — EMA20 78182.78 < EMA50 79167.53; MACD -708.77 < sinal -658.85; RSI 32.01
- risk-manager:  baixa (0.68) — ATR 634.66 (0.83%); swing high 78804.01, swing low 76500.11
- qa-reviewer:   baixa (0.75) — VWAP 80177.06 acima do preço; banda inferior 76268.38
Consenso: sim (pareceres alinhados, concordância 100%)
Trace: market-analyst=ok(1x,3388ms) risk-manager=ok(1x,3497ms) qa-reviewer=ok(1x,3417ms)
```

Bug encontrado nessa execução: quando o host nativo saía, o gateway herdava um **pipe sem leitor** e morria no log
seguinte (`EPIPE`) — a terceira chamada caía com `fetch failed`. Correção: o gateway passou a escrever em
`~/.dz23/gateway.log` (arquivo, não pipe), e há teste garantindo que ele sobrevive ao fim do host.

## No painel

O botão **Sofia · especialistas** (acima do campo de mensagem) roda o plano sobre o **gráfico atual**:

- evidência = contexto do painel + candles carregados + métricas calculadas (as mesmas do prompt);
- sem candles, o botão **não inventa**: informa que não há evidência e não chama modelo;
- a resposta entra na conversa como mensagem do assistente com o resumo, o consenso e o trace;
- o estado ao lado do botão mostra "N/N parecer(es) · consenso: sim|não".

E2E: `npm run test:e2e` clica no botão com um provedor falso que responde o contrato e exige a asserção
"Sofia consulta os especialistas e reporta o consenso".

## O que ainda não existe

- Interface na UI (botão "Sofia" no painel): o motor e o CLI estão prontos e testados; a superfície no painel é a
  próxima onda.
- Papéis que dependem de dados que não temos (notícias, fundamentos, portfólio) **não** foram criados para inflar a
  lista.
- Nenhum agente executa ordem, altera configuração ou gasta dinheiro: o resultado é texto + trace.

## Por que quatro papéis (e não os doze da missão)

A missão lista doze papéis possíveis. Aqui existem **quatro** — `market-analyst`, `technical-analyst`, `risk-manager`,
`qa-reviewer` — porque são os que têm **dado real** no contexto do gráfico: métricas calculadas, candles e o texto do
usuário.

Os outros oito não foram criados de propósito:

| Papel ausente | Dado que faltaria |
|---|---|
| Quant Researcher / Backtest Analyst | resultados de backtest não estão no contexto do painel (vivem no Strategy Lab) |
| Strategy Architect / Pine Engineer | o código Pine não é anexado ao diálogo hoje |
| News Analyst | não há fonte de notícias integrada |
| Portfolio Analyst / Execution Supervisor | não há carteira nem ordens |
| Security Agent | a auditoria roda no build (`security:check`), não por gráfico |

Criar esses papéis sem dado produziria respostas "inconclusivo" — exatamente o que já corrigi uma vez quando os prompts
mandavam nomes de métricas sem os valores. Quando o dado existir, o papel entra em `ROLES` e no `planRun`.

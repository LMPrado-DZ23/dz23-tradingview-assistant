# Validação de Pine Script

`extension/quant/pine.mjs` é um **linter** estático para Pine Script, usado pelo Strategy Lab. Ele não compila nem
executa o script: aponta o que faz o script não rodar ou — pior — rodar mostrando um resultado que não existe.

```powershell
npm run pine:check -- caminho\script.pine          # relatório legível, exit 1 se houver erro
npm run pine:check -- script.pine --json           # mesmo resultado em JSON
Get-Content script.pine | npm run pine:check -- -  # pela entrada padrão
```

## O que ele verifica

| Código | Nível | O que significa |
|---|---|---|
| `pine.empty` | erro | script vazio |
| `pine.version_missing` | aviso | sem `//@version=` o TradingView assume v1 |
| `pine.version_unsupported` | erro | versão fora de 1–6 |
| `pine.version_old` | aviso | versão anterior à configurada como mínima (padrão 4) |
| `pine.declaration_missing` | erro | falta `indicator(...)` ou `strategy(...)` |
| `pine.declaration_conflict` | erro | as duas declarações no mesmo script |
| `pine.unbalanced` | erro | parênteses, colchetes ou chaves desbalanceados |
| `pine.string_unterminated` | erro | string aberta na linha |
| `pine.lookahead` | aviso | `request.security` com `lookahead = barmerge.lookahead_on` |
| `pine.repainting_realtime` | aviso | `barstate.isrealtime` gateando sinal (histórico ≠ tempo real) |
| `pine.future_reference` | erro | acesso a `[−n]` (barra futura) |
| `pine.deprecated_security` | aviso | `security(` sem o namespace `request.` |
| `pine.deprecated_study` | aviso | `study(` (substituído por `indicator(`) |
| `pine.namespace_version` | erro | `ta.` em versão anterior à v5 |
| `pine.strategy_no_costs` | aviso | `strategy()` sem `commission`/`slippage` — backtest ignora custo |
| `pine.strategy_no_entry` | aviso | estratégia sem `strategy.entry()` |
| `pine.strategy_no_exit` | aviso | há entrada e nenhum `strategy.exit()` — sem alvo/stop explícito |

Cada achado traz a linha, o código e uma mensagem que diz o que verificar no editor. O retorno inclui ainda `version`,
`kind` (`indicator`/`strategy`), `stats` (linhas úteis, chamadas de `request.security`, entradas, indicadores) e
`summary` com a contagem por nível.

## O que ele **não** faz (limites, para não prometer demais)

- Não é o compilador da TradingView: não valida tipos, séries, `series`/`simple`, nem disponibilidade de funções por
  plano.
- Não executa backtest. Métricas de resultado vêm do Strategy Lab (`extension/quant/`), com separação treino/validação,
  custos e PBO/DSR — e "bom no histórico" continua não sendo promessa de lucro.
- Não corrige o código: só aponta. A reescrita é decisão do autor (ou do copiloto, com revisão).
- Heurísticas de regex: um comentário de bloco multi-linha é removido antes da análise, mas construções exóticas (string
  contendo `//`, por exemplo) podem gerar falso positivo — o relatório nomeia a linha para conferência.

## Testes

`_aitna/tools/extension-tests/pine.test.mjs` — **13 casos**: indicador e estratégia bem formados (zero achados), vazio,
sem versão, versão inexistente, sem declaração, parênteses/string, `lookahead_on`, barra futura, `security`/`study`
antigos, `ta.` em v3, estratégia sem custos/entrada/saída e o formato legível.

## Onde usar

- **CLI**: `npm run pine:check -- script.pine` (texto ou `--json`).
- **UI**: página de pesquisa (`extension/research/`), seção **4. Pine Script** — colar o script, abrir um arquivo `.pine`,
  validar, copiar o relatório. O script digitado fica em `localStorage` (`dz23.pine.last`) e volta ao reabrir a página.
- Teste da UI: `npm run test:pine-ui` (Chrome headless; valida script ruim e bom, verifica códigos e linhas).

## Gerar com validação

O validador não serve só para checar o que você escreveu: ele fecha o ciclo da geração.

```powershell
npm run pine:gen -- "RSI com divergência e alerta" --live            # indicador
npm run pine:gen -- "rompimento com ATR e stop" --kind strategy --live
npm run pine:gen -- "minha ideia"                                    # só mostra o prompt, não chama modelo
```

O CLI pede o script ao gateway, **extrai só o bloco Pine** (descarta a conversa em volta) e roda o mesmo validador:

- aprovado → imprime relatório + script, exit 0;
- reprovado → imprime os achados com linha e código, exit 1, e diz "NÃO usar antes de corrigir";
- resposta sem Pine → diz que não reconheceu, mostra o que foi descartado, exit 1.

Sem `--live` nada é enviado a provedor (custo zero). O prompt exige `//@version=5`, custos explícitos para estratégias e
proíbe `lookahead_on`/dados futuros — e o validador reprova se o modelo desobedecer.

## Explicar e documentar código

```powershell
npm run pine:explain -- script.pine            # mostra o prompt e os achados; nada é enviado
npm run pine:explain -- script.pine --live     # o modelo explica; fatos do validador impressos separados
```

A saída separa **duas autoridades**:

1. **Validador (fatos)** — erros/avisos com linha e código, versão detectada.
2. **Explicação do modelo (interpretação, não verificação)** — no máximo 12 linhas, cobrindo o que calcula, entradas,
   risco de repainting/dados futuros e **o que não dá para concluir** pelo código (sem afirmar rentabilidade).

Se o script não passa no validador, o CLI ainda explica o problema, mas sai com exit 1 — não apresenta código inválido como
"pronto". Sem `--live` nada é enviado a provedor (custo zero).

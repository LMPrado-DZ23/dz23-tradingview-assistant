# Strategy Lab — comparação de estratégias

A comparação existe para responder "qual destas se saiu melhor **nas mesmas condições**" — e para dizer, na mesma frase,
quanto do resultado é provavelmente sorte de seleção.

## Uso

```powershell
npm run strat:compare -- a.json b.json [mais...] [--metric sharpe] [--json]
```

Cada arquivo pode ser:

- **experimento do contrato versionado** (`schema_version: "1.0.0"`) — um candidato por arquivo;
- **lote**: `{ "candidates": [ { "name", "trades" | "metrics", "period", "costs" } ] }`;
- **um candidato**: `{ "name", "metrics": {...}, "period": {...}, "costs": {...} }`.

## O que a comparação faz

1. **Exige comparabilidade.** Períodos diferentes ou premissas de custo diferentes → `NÃO comparáveis`, com o motivo
   listado (`períodos diferentes: 2024-01-01..2024-12-31 vs 2023-01-01..2023-12-31`) e **exit 1**.
2. **Ranqueia por UMA métrica declarada**: `sharpe`, `sortino`, `profitFactor`, `expectancy`, `winRate` ou
   `maxDrawdown` (nesta, menor é melhor).
3. **Quantifica o viés de seleção.** Escolher a melhor de N infla o vencedor: o módulo calcula, por simulação
   determinística, `E[máx de N normais padrão]` — 2 candidatas ≈ 0,56σ; 10 ≈ 1,54σ — e imprime junto do resultado.
4. **Mostra a dispersão** (p5 / p50 / p95) da métrica entre as candidatas, para ver se a "vencedora" é um outlier ou o
   meio do ruído.
5. **Não afirma rentabilidade.** A saída termina com "comparação de resultados históricos, não previsão nem recomendação
   de operação".

Exemplo real:

```
Comparação por sharpe · 2 estratégias
- Rompe 20 dias: sharpe 1.42 · PF 1.55 · expectância 18.40 · DD 9.20 · 48 trades ← melhor
- Pullback EMA: sharpe 0.91 · PF 1.28 · expectância 9.10 · DD 6.40 · 63 trades
- Viés de seleção: escolher a melhor de 2 candidatas infla o resultado: o máximo de 2 ruídos padrão fica em torno de
  0.565σ. Só trate a vencedora como superior se a diferença sobreviver a um teste fora da amostra.
- comparação de resultados históricos, não previsão nem recomendação de operação
- Distribuição de sharpe entre as candidatas: p5 0.94 · p50 1.17 · p95 1.39
```

## Limites declarados

- A comparação **não refaz** o backtest: ela lê resultados que já existem (`trades` crus ou `metrics`). Quem produz os
  resultados é o pipeline de pesquisa (`extension/quant/` + página de pesquisa), com IS/OOS, walk-forward, Monte Carlo e
  PBO/DSR.
- `E[máx de N]` é uma referência de ruído **na escala z**; não substitui o teste fora da amostra nem o deflated Sharpe
  (que já existem em `extension/quant/overfitting.mjs`).
- Um vencedor histórico continua sendo um vencedor histórico.

## Testes

`npm run test:strategy` — 11 casos: `expectedMaxZ` (determinismo e crescimento), ranking nas duas direções, recusa por
período e por custo, mínimo de duas candidatas, métrica inválida, candidata sem dados (reportada, não inventada), trades
crus convertidos em métricas, descrição com avisos e `spreadOf`.

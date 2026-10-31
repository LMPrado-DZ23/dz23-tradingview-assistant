# Watchlists e alertas

Ambos vivem na **configuração única** (`dz23.config.v1`): `watchlists.lists` e `alerts.rules`. A interface está na tela
de configurações (`extension/settings/`), seções **Watchlists** e **Alertas do DZ23**.

## Escopo, sem eufemismo

- **Watchlists** são listas do DZ23, guardadas localmente. Não são listas do TradingView (que não têm API pública).
- **Alertas** são avaliados quando você clica em *Avaliar agora*, contra candles da fonte pública. **Não** são alertas
  do TradingView: o TradingView roda os alertas dele nos servidores dele e não expõe API pública para criá-los. A
  interface diz isso na tela, e o resumo da avaliação termina com "Alertas do DZ23: avaliados aqui, não são alertas do
  TradingView."
- Nada aqui executa ordem, altera configuração de risco ou gasta dinheiro.

## Watchlists

| Ação | Regra aplicada |
|---|---|
| Criar lista | nome obrigatório (≤ 40 caracteres); até 60 símbolos; símbolos inválidos são descartados |
| Adicionar símbolo | normaliza para maiúsculas; recusa duplicado (comparação sem caixa) |
| Remover símbolo | exige que o símbolo esteja na lista |
| Comparar listas | independente de ordem e de caixa: só na primeira / só na segunda / em ambas |
| Avaliar oportunidades | regra fixa e declarada, com os números usados |

**Regra do ranking** (não é recomendação de operação):

- tendência de alta (EMA20 > EMA50 e preço acima da EMA20): **+2**; tendência de baixa: **−2**
- RSI entre 55 e 70: **+1** (zona de força); RSI < 30: **+0,5** (sobrevenda); RSI > 75: **−0,5** (esticado)
- preço acima do VWAP: **+0,5**

Símbolo sem amostra (mínimo 20 candles) aparece como **sem dados com o motivo**, nunca com score 0.

## Alertas

| Tipo | Dispara quando |
|---|---|
| `price_above` | preço **>** valor |
| `price_below` | preço **<** valor |
| `rsi_above` / `rsi_below` | RSI(14) do snapshot acima/abaixo do valor (0–100 validado) |
| `pct_move` | variação absoluta do último candle **≥** valor (%) |

**Editar**: mudar tipo ou valor **re-arma** o alerta e zera o último disparo (a condição antiga não descreve mais o que
você quer); mudar só a nota preserva o estado. O módulo valida tipo, faixa de RSI e cooldown — a UI não duplica essas regras.

Regras de comportamento:

- **uma vez por cruzamento**: ao disparar, o alerta fica `fired` e para de avaliar até ser retomado;
- **cooldown** (padrão 15 min) impede repetição em sequência;
- **pausar/retomar/excluir** mudam o estado e o estado novo é lido de volta da configuração;
- **sem leitura** (símbolo não retornou dados) → `sem avaliação`, nunca "disparou";
- o resumo traz disparados, aguardando (com valor observado) e sem leitura.

## Como é testado

- `_aitna/tools/extension-tests/watchlist-alerts.test.mjs` — **11 testes**: CRUD, duplicata, comparação, ranking com e
  sem dados, validação de tipo/valor/RSI, disparo único, cooldown, pausa, ausência de leitura, resumo com escopo.
- `npm run test:settings-ui` — **11 passos** no Chrome headless com candles sintéticos rotulados como tal: cria lista,
  avalia ranking, cria alerta, avalia (dispara de verdade: preço 159,5 > 100) e confirma `state: fired` gravado em
  `dz23.config.v1`.

## Limitações declaradas

- Avaliação só ocorre quando você clica em *Avaliar agora* (não há agendador em background; a extensão MV3 não roda
  sozinha com o navegador fechado).
- Fonte dos candles: Binance pública, timeframe 1h. Símbolo de outra exchange não é suportado e aparece como sem dados.
- `pct_move` compara os dois últimos candles da leitura, não uma janela configurável.

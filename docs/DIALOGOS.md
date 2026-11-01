# Diálogos de erro e suas saídas

Um diálogo que só informa deixa o usuário parado. Cada linha abaixo diz **qual é a saída** — e, quando não há botão, **por
que não há**: em alguns casos nenhum botão resolveria, e um botão decorativo é pior que nenhum.

Regra ao adicionar um diálogo: se existe uma ação que o usuário pode tomar, ela vira botão; se não existe, a mensagem
precisa dizer o que fazer em palavras.

## Com botão

| Diálogo | Saída | Por quê |
|---|---|---|
| `tv_no_strategy_on_chart` — sem estratégia no gráfico | **Abrir DZ23 Research** (`ui.researchAction()`) | o laboratório local testa sobre os candles e não precisa do painel do TradingView |
| `tv_cannot_open_params` — não abriu os parâmetros | **Abrir DZ23 Research** | mesma intenção (testar a estratégia) por um caminho que funciona |
| `tv_params_not_opened` / `_other` — abriu outra coisa | **Abrir DZ23 Research** | idem |
| `backtest_no_report_data_no_table` — relatório ilegível | **Abrir DZ23 Research** | o TradingView não entregou a tabela; o laboratório não depende dela |
| `tv_no_settings_button` — botão de config não encontrado | **Tentar novamente** (`ui.retryAction`) | falha transitória: o painel pode ter demorado a renderizar |
| `tv_dialog_not_opened` — diálogo não abriu | **Tentar novamente** | idem |
| `tv_inputs_tab_missing` — aba de entradas ausente | **Tentar novamente** | idem |
| `action_plotly_unavailable` — biblioteca do gráfico 3D | **Tentar novamente** | a biblioteca é carregada sob demanda; a segunda tentativa costuma resolver |

## Sem botão, de propósito

| Diálogo | Por que não há botão | O que a mensagem faz |
|---|---|---|
| `action_no_strategy_inputs` | a saída é escolher outra estratégia **no gráfico**, fora do nosso alcance | diz "adicione ao gráfico uma estratégia com entradas ou escolha outra" |
| `tv_no_data_loaded` | não há dado carregado para ticker/timeframe: ação do usuário no gráfico | diz "altere o ticker e o timeframe e reabra a janela" |
| `tv_params_not_found` | o parâmetro não existe no script; nenhum botão cria parâmetro | diz para verificar o script |
| `backtest_opt_param_not_found` | o relatório não tem esse parâmetro — e a mensagem **lista os disponíveis** | a escolha é do usuário, com a lista na mão |

## Como testar um diálogo novo

`_aitna/tools/extension-tests/dialog-action.test.mjs` roda no contexto da extensão com DOM instrumentado e cobre: botão só
aparece com ação, rótulo correto, clique executa e fecha, ação que lança não trava o diálogo, e as ações compartilhadas
(`ui.researchAction`, `ui.retryAction`).

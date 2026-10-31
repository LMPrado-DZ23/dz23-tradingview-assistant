# Teste manual — extensão carregada no Chrome com TradingView

Os testes automatizados cobrem o canal (`chartBridge` → copiloto), o CORS, o prompt e os candles via API pública.
O que **só a instalação manual** prova é a leitura da página real e a conversa com um provedor de verdade. Este roteiro
existe para transformar o primeiro teste num relatório curto e acionável — sem ele, qualquer afirmação sobre “integração
real” seria especulação.

## Preparação

```powershell
# 1. instalar o host nativo (uma vez). Ele sobe o gateway e entrega o token ao painel.
node native-host/install.mjs
#    o instalador deriva o ID da chave do manifest: não há ID para copiar

# 2. opcional: chaves de provedor fora do repositório
#    C:\Users\<você>\.dz23\providers.env   com linhas do tipo DEEPSEEK_API_KEY=...

# 3. extensão
#    chrome://extensions → modo desenvolvedor → "Carregar sem compactação" → pasta extension/
#    ID esperado: ejmflepgfmffgicdjdaigdfdcacehgma  (fixo pela chave em extension/manifest.json)
#    reinicie o Chrome depois de instalar o host
```

## Checklist (marque PASS/FAIL em cada linha)

| # | Ação | Esperado |
|---|---|---|
| 1 | Abrir `chrome://extensions` e carregar `extension/` | sem erro; o ID é o mesmo de qualquer máquina |
| 2 | Abrir o popup | todos os campos com valores; botões “Abrir copiloto”/“Abrir pesquisa” respondem |
| 3 | Abrir o painel DZ23 (ícone do Chrome ou botão do popup) | painel abre ao lado do gráfico, sem cobrir o TradingView |
| 4 | Abrir uma aba `tradingview.com/chart/…` com qualquer gráfico | — |
| 5 | **Sem** digitar token: recarregar o painel com o host instalado | status “gateway on-line” e pareamento feito sozinho (o token vem do host) |
| 6 | Com o gateway parado: abrir o painel | aviso “Sem gateway” com `npm run gateway`, pareamento automático e token — sem mentir “conectado” |
| 7 | Olhar o chip acima do compositor | `● Gráfico ativo: <SÍMBOLO> · <TF> · <EXCHANGE>`, ponto verde |
| 8 | Clicar no chip | diálogo com o bloco enviado ao modelo; linha “Candles (fonte pública)” com números **ou** o motivo |
| 9 | Colar uma regra em “Memória desta estratégia” e aplicar | regra aparece no preview do prompt e volta ao reabrir o diálogo |
| 10 | Trocar o ativo (ex.: BTCUSDT → ETHUSDT) | chip muda em ~1 s, sem recarregar a página |
| 11 | Trocar o timeframe (ex.: 5m → 15m) | chip muda na mesma hora |
| 12 | Abrir uma **segunda** aba com outro gráfico e alternar | chip acompanha a aba ativa; **nunca** mostra o símbolo da outra |
| 13 | Fechar a aba do gráfico | chip volta a “Sem gráfico ativo” |
| 14 | Enviar uma pergunta | resposta em streaming; o chip continua correto durante a geração |
| 15 | Cancelar no meio do streaming | o botão vira “Enviar”, nada fica preso, o texto recebido permanece |
| 16 | Abrir `chrome://extensions` → cartão do DZ23 → **Opções** | abre a **mesma** tela de configurações |
| 17 | Na tela de configurações: seção **Memória** | lista `usuário · estratégia · N nota(s)` e o botão Limpar pede confirmação |
| 18 | Seção **Diagnóstico** → Rodar diagnóstico | mostra health e a tabela **Uso por provedor** com latência e falhas reais |
| 19 | “Aplicar ação” com outro símbolo/timeframe | o painel confirma **por releitura** do gráfico, não pelo clique |
| 20 | Abrir “Contexto do trading” | preview mostra ativo/timeframe e “Contexto do gráfico” duplicado é **esperado** (um vem do usuário, outro da página) |

## Se o chip ficar “Sem gráfico ativo”

Cole **apenas o texto** (nada de credenciais, nada de print da conta) e eu ajusto os seletores:

```js
// no console do TradingView, com o gráfico aberto:
[...document.querySelectorAll('[data-name="legend-source-item"], [class*="legend-source"], header [data-symbol]')]
  .slice(0, 10)
  .map(el => ({ name: el.getAttribute('data-name'), symbol: el.getAttribute('data-symbol'), text: el.textContent.trim().slice(0, 60) }))
```

E também:

```js
document.title
```

Com esse retorno eu corrijo `SYMBOL_SELECTORS`/`TIMEFRAME_SELECTORS` em `extension/content_scripts/chartBridge.js` e
adiciono o caso como teste de regressão do parser (a parte pura já é testada; o que muda são os seletores).

## O que NÃO fazer

- Não colar chaves de API em chat, print, issue ou commit — elas devem viver em `~\.dz23\providers.env`.
- Não executar ordens reais: a extensão é análise e assistência; nada aqui envia ordem.
- Não desativar o token do gateway “para testar”: sem token ele recusa iniciar de propósito.
- Não copiar o ID de outra máquina: ele é fixo pela chave; ID diferente significa extensão carregada de outro pacote.

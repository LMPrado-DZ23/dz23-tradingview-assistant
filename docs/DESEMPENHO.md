# Orçamento de desempenho

Duas medições reais, com limites que existem para pegar regressão — não para enfeitar relatório.

## `npm run perf:check` — estático

| Medida | Hoje | Orçamento |
|---|---|---|
| JS "eager" (tudo menos a biblioteca 3D) | **447,5 KB** em 38 arquivos | 600 KB |
| Maior arquivo eager | **65,2 KB** (`extension/content_scripts/tv.js`) | 120 KB |
| CSS | 31 KB | 60 KB |
| HTML | 51,6 KB | 70 KB |
| `content_scripts` (rodam em toda página do TradingView) | **198,7 KB** em 15 arquivos | 300 KB |
| `extension/lib/plotly.min.js` | 3 577,4 KB — **lazy** | deve continuar lazy |

A última linha é uma asserção, não uma métrica: o check **reprova** se alguma página HTML referenciar `extension/lib/plotly.min.js` ou se
algum módulo eager o importar de forma estática. Hoje o carregamento é sob demanda (`tv.ensurePlotly()` em
`extension/content_scripts/tv.js`), usado só pelo gráfico 3D de resultados — ou seja, 89% do peso da extensão não entra no caminho
comum, e isso passa a estar protegido por teste.

## `npm run perf:pages` — dinâmico

Carrega as páginas reais em Chrome headless e mede o que o usuário espera:

| Página | load | nós no DOM | transferido |
|---|---|---|---|
| Configurações | **51 ms** | 112 | **91 KB** |
| Painel (copilot) | **65 ms** | 143 | **167 KB** |

Orçamentos: 1 500 ms de load, 1 200 nós, 900 KB por página.

## Por que estes números

- São medidos na mesma máquina e no mesmo Chrome for Testing, então comparação entre execuções é válida.
- Os limites estão **logo acima** do atual: um arquivo que dobre de tamanho, ou a biblioteca 3D entrando no caminho comum,
  estoura o orçamento antes de chegar ao usuário.
- `content_scripts` tem orçamento próprio porque custa em **toda** página do TradingView, não só quando o painel abre.

## Limites declarados

- A medição é local (rede zero, servidor em `127.0.0.1`); não representa latência de rede real nem máquina do usuário.
- `loadMs` vem de `PerformanceNavigationTiming`; não mede trabalho assíncrono que acontece depois (ex.: busca de candles).
- Não há medição de memória nem de CPU por script; se isso virar requisito, o próximo passo é `Performance.getMetrics`.

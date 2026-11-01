# DZ23 TradingView Assistant — relatório de entrega

Versão **2.17.0**. Documento gerado a partir da execução real do repositório, não de intenção. Onde algo não está
comprovado, está escrito assim.

```
repositório: %USERPROFILE%\Documents\tradingview-assistant-chrome-extension-main
pacote:      assistant-ext.zip · 67 arquivos · v2.17.0
SHA-256:     2c3f94962e974caee71e0e9b392a73353c97fe6ad313d5646a919ee0a8f553d6
```

---

## 1. O que o produto é

Extensão Chrome MV3 + gateway local em `127.0.0.1:8777` + módulos de pesquisa quantitativa. Um único produto, com
superfícies que compartilham a mesma configuração:

| Superfície | Papel |
|---|---|
| Painel (side panel) | copiloto contextual ao gráfico, histórico, Sofia (agentes), ações de gráfico |
| Popup | controle do assistente (teste de estratégia, resultados, sinais, opções) |
| Página de configurações | gateway, provedores, modelos, conta, watchlists, alertas, diagnóstico, segurança |
| Página de pesquisa | CSV → experimento, Top-N, heatmap, **validação de Pine Script** |
| Gateway local | multi-provedor de IA, autenticação por token, CORS por identidade, rate limit, diagnóstico |
| Native host | sobe/supervisiona o gateway a pedido da extensão (Chrome não inicia processos) |

---

## 2. Matriz de funcionalidades

Legenda: **comprovado** = há teste automatizado ou execução real registrada; **parcial** = funciona com limite
declarado; **ausente** = não existe.

### Bloqueios da missão

| Item | Estado | Evidência |
|---|---|---|
| Configuração centralizada (§3.1) | **comprovado** | `dz23.config.v1`; 11 testes de migração/validação + 3 de integração com o bridge; migração idempotente testada |
| Configurações alcançáveis (`options_ui`) | **comprovado** | manifest declara `extension/settings/index.html` como página de opções (`open_in_tab`), popup e painel abrem por `openOptionsPage`; 5 testes de superfície garantem que toda tela tem entrada e todo arquivo declarado existe |
| Uma única tela de configurações (§3.2) | **comprovado** | `extension/settings/` com 7 seções; `test:settings-ui` 11 passos |
| Gateway inicia por mecanismo suportado (§3.3) | **comprovado** | native host instalado (`HKCU`), start/stop/status reais; 4 testes; gateway sobrevive ao fim do host |
| Pareamento automático (§3.4) | **comprovado** | E2E nasce **sem token** e pareia (`{"token":true,"providers":2}`) |
| Invariantes de segurança (§10) | **comprovado** | `npm run security:check`: 8 regras sobre 60 arquivos — sem `chrome.cookies`/`document.cookie`, permissões mínimas (só `*.tradingview.com`), sem `eval`/`Function`, sem chave/token literal, CSP explícita, sem script remoto, hosts externos declarados, token fora de logs |
| Uso por provedor na tela | **comprovado** | seção Diagnóstico mostra chamadas, falhas, latência média e tokens por provedor lidos de `GET /usage` (janela das últimas 200), com estado vazio explícito; E2E 14 passos |
| Fallback e consumo de provedores (§12) | **comprovado** | cadeia pedido→reservas, só em falha do provedor antes de entregar texto; ledger com `GET /usage`. 11 unitários + 2 de integração HTTP **e o painel exercitando**: o E2E sobe com o provedor padrão apontando para um upstream 500 e prova pelo ledger (`openai failed=1 · openai-compatible ok=1`) que a resposta veio do reserva — chat **e** Sofia |
| CORS e token protegidos (§3.5) | **comprovado** | 29 testes de gateway; ao vivo: extensão do produto → 200, extensão estranha → 403, `/token` recusado |
| Candles reais no prompt (§3.6) | **comprovado** | E2E: `Candles: 60 … Fonte dos candles: BINANCE` + métricas calculadas |

### Produto

| Capacidade | Estado | Evidência |
|---|---|---|
| Copiloto contextual com streaming e cancelamento | **comprovado** | E2E: streaming, stop, markdown, 0 erro de console |
| Contexto do gráfico (símbolo/exchange/timeframe/indicadores) | **comprovado** | `bridge-e2e` 8/8 contra o DOM que o Remix lê, incluindo fallback por URL |
| Ações de gráfico verificáveis (símbolo/timeframe) | **comprovado** | `chartActions` 12 testes; E2E aplica ETHUSDT/15m e **confirma por releitura** |
| Cobertura de testes | **comprovado** | `npm run test:coverage`: **94,17%** statements, 77,72% branches, 83,38% funções (limites 92/68/80, `npm run test:coverage` sai 0). O número caiu de 97,8% quando os testes passaram a **carregar as próprias ferramentas de auditoria** (`audit:gate`, `audit:package`, `audit:mutacao`), que entram na conta e são exercitadas só parcialmente — o código de produto segue com módulos em 100% (`extension/copilot/memory.js`, `extension/quant/metrics.mjs`, `extension/quant/montecarlo.mjs`). Ver [COBERTURA.md](docs/COBERTURA.md) |
| Orçamento de desempenho | **comprovado** | `npm run perf:check` (457,1 KB eager / 600 KB · maior arquivo 65,2 KB · plotly 3,5 MB **lazy** e protegido por teste) e `npm run perf:pages` (configurações 58 ms/96 KB, painel 66 ms/172 KB) — ver [DESEMPENHO.md](docs/DESEMPENHO.md) |
| Acessibilidade (WCAG) | **comprovado** | `npm run test:a11y` **7 passos**: nome acessível em todo botão, rótulo em todo campo, **5 live regions** (inclui a da memória), Tab com anel de foco visível (2px), contraste AA medido |
| Pine Script — validação | **comprovado** | 17 achados, 13 testes, CLI + seção na página de pesquisa (E2E 6/6) |
| Pine Script — explicar/documentar | **comprovado** | `npm run pine:explain -- arquivo --live` executado num script real: fatos do validador separados da interpretação, com as quatro seções exigidas; 7 testes |
| Pine Script — geração com validação | **comprovado** | `npm run pine:gen -- "…" --live`: gerou um RSI v5 real que o validador aprovou (0 avisos); script reprovado sai com exit 1 e "NÃO usar"; 8 testes de contrato |
| Strategy Lab (métricas, IS/OOS, walk-forward, Monte Carlo, PBO/DSR) | **comprovado** | 43 testes no módulo `extension/quant`; **PBO/DSR agora calculados no caminho real**: `npm run strat:compare` reporta `PBO: N% (CSCV · combinações, blocos)` e `DSR` quando o arquivo traz `returns`/`sharpe`, e **declara o que falta** quando não traz — 4 testes de CLI. Antes o módulo existia e nenhum consumidor o chamava |
| Market Intelligence (RSI, ATR, MACD, Bollinger, EMA, VWAP, estrutura, **divergência RSI**, **padrões de candle**) | **comprovado** | 17 testes; valores, divergência e padrões (doji, martelo, estrela cadente, marubozu, engulfing, inside bar) entram no prompt com a regra citada |
| Comparação entre ativos | **comprovado** | `npm run compare-assets -- BTCUSDT ETHUSDT --tf 1h` em dados reais + botão **Comparar ativos** no painel (E2E: lado a lado e recusa do mesmo ativo); 9 testes; regra declarada, vencedor por métrica, ressalva de fontes |
| Comparação multi-timeframe | **comprovado** | `npm run compare -- BTCUSDT 15m,1h,4h` rodado em candles reais; 9 testes; alinhamento, ATR relativo e divergências citados |
| Agentes especialistas (Sofia) | **comprovado** | 13 testes + execução real com DeepSeek (3/3 pareceres, consenso 100%) + botão no painel (E2E) |
| Memória entre chat e Sofia | **comprovado** | a memória da estratégia entra no prompt do chat **e** no plano dos especialistas (antes só o chat a usava, e a resposta mudava conforme o botão); notas vazias descartadas, limite nas 10 mais recentes; 3 testes |
| Strategy Lab — comparação de estratégias | **comprovado** | `npm run strat:compare -- a.json b.json` executado: recusa períodos/custos diferentes (exit 1), ranqueia por métrica declarada e imprime o viés de seleção (`E[máx de N]σ`) e a dispersão; 11 testes |
| Watchlists e alertas | **parcial** | motor 14 testes e UI 13 passos (criar, **editar**, pausar, retomar, excluir, avaliar); limite: avaliação só ao clicar, não é alerta do TradingView |
| MCP oficial do TradingView | **bloqueado (dependência externa)** | OAuth 2.1 + PKCE + registro dinâmico implementados, 16 testes de contrato; o servidor recusa com **"É necessário um plano pago"** — `BLOCKED_BY_EXTERNAL_DEPENDENCY` documentado em `docs/MCP-TRADINGVIEW.md` |
| Opções do popup numa fonte única | **comprovado** | o popup gravava `iondvOptions` direto e deixava o registro velho (a ponte podia espelhar o valor velho por cima da escolha nova); agora passa por um caminho único com fallback declarado — 2 testes estruturais |
| Gate com prova de evidência | **comprovado** | `npm run audit:gate`: **32 verificações, 604 testes**; cada comando precisa mostrar que rodou (mínimo por suíte, marcador por script) — um glob vazio reprova em vez de passar |
| Higiene do pacote | **comprovado** | `npm run audit:orphans`: 67 arquivos, 60 referências, **0 órfãos e 0 referências quebradas**; testes que viajavam dentro de `extension/quant/` saíram do pacote |
| Aceite com autoridade única | **comprovado** | `npm run accept` delega ao gate (nada de lista paralela de comandos) e mapeia 22 vereditos em 16 critérios do §17 — 16 PASS, 2 EXTERNAL, 2 ABSENT |
| Ingestão de experimentos (pesquisa → agentes) | **comprovado** | serviço recebia `POST /experiments` e **nada enviava**; agora `npm run dz23:send` valida localmente, envia, lê de volta e compara hash do aceite com o gravado — 5 testes contra servidor real; ver [DZ23-INGEST.md](docs/DZ23-INGEST.md) |
| Todo controle executa uma ação (§13) | **comprovado** | `npm run audit:controls`: **73 controles** nas 4 telas, **0 sem referência** no JavaScript; o auditor ignora comentários e reporta markup comentado (`deepTestStrategy`) como informação, não como botão |
| Testes que realmente pegam (mutação) | **comprovado** | `npm run audit:mutation` quebra de propósito 6 módulos críticos (verificação de ação, validação de config, fire-once dos alertas, fallback, RSI, contrato dos agentes) e exige que a suíte **falhe**: **6/6 mutantes mortos**, arquivo restaurado com hash conferido |
| Pareamento automático em produção | **comprovado** | `/token` é dev-only; o painel agora pede o token ao **host nativo** (stdio, sem rede) quando `/token` não existe, e grava no registro. 2 testes do host (entrega e ausência) + nenhum token no status/log; o aviso de primeiro uso foi corrigido para dizer a verdade |
| Primeiro uso quando o gateway está fora | **comprovado** | E2E: modo on-line **esconde** o aviso; off-line mostra o aviso com `npm run gateway`, pareamento automático e token — 2 asserções |
| ID estável da extensão | **comprovado** | `key` fixo no manifest → ID `ejmflepgfmffgicdjdaigdfdcacehgma` em qualquer pasta; host, gateway e instalador concordam por **teste** (o instalador deriva da chave); mudar de pasta deixou de quebrar o pareamento |
| Launcher real do host testado | **comprovado** | `_aitna/tools/extension-tests/native-launcher.test.mjs` executa **`native-host/dz23-host.cmd` via `cmd.exe`**, como o Chrome faz, com o enquadramento de 4 bytes: responde `token`, devolve o id, erro de tipo desconhecido não mata o processo; 3 testes (skip fora do Windows) |
| Pacote verificado por dentro | **comprovado** | `npm run audit:package` abre o ZIP: manifest parseia, **todo arquivo citado existe no arquivo**, nada proibido (teste, `.env`, chave, credencial, lockfile), nenhuma entrada vazia, `key` presente. 5 testes provam que ele **reprova** pacote quebrado — e um deles achou que o helper do release ignorava `background`, `side_panel` e `options_ui` (corrigido) |
| Fiscal de segurança ampliado | **comprovado** | o scan cobria só `extension/`; passou a varrer `gateway/`, `native-host/`, `dz23/` e `mcp/` (**71 arquivos com código, 9 regras**), onde os tokens realmente circulam. Regra de token em log recalibrada: **5 formas reais de vazamento reprovam**, 2 formas legítimas (mensagem de ajuda e metadado) passam — as duas provadas por mutantes |
| Rollback ensaiado de verdade | **comprovado** | o ensaio só compilava arquivos; agora restaura a árvore inteira do backup num diretório temporário e roda **a suíte que veio com ela**: `backup:check` reporta **49/49 testes da árvore restaurada**. Ensaio que rode **zero** teste reprova (a lição do glob vazio, aplicada), e 3 testes provam que backup quebrado é reprovado |
| Exportações mortas auditadas | **comprovado** | `npm run audit:exports` conta **218 exportações** e separa as usadas só por teste das usadas por ninguém. Achou quatro capacidades anunciadas e sem consumidor — **PBO/DSR, Monte Carlo, walk-forward** e a validação **candles×gráfico** — agora ligadas no produto, e dois limites declarados e nunca aplicados (**`INDICATOR_LIMITS`**, agora respeitado por indicador, e **`MAX_LISTS`**, agora aplicado na criação de lista) e uma duplicação: o servidor carregava `providers.env` com `readFileSync` cru (erro `ENOENT`) em vez de `loadProviderEnv` (erro dizendo qual variável) |
| Relatório de overfitting no caminho real | **comprovado** | `strat:compare --montecarlo --walkforward` divide a série 70/30, chama `overfittingReport` e imprime o veredito com degradação e os avisos do módulo (`collapsed`, `oos_collapsed`); 6 testes de CLI. Antes o relatório composto existia e nenhum caminho o chamava |
| Exportações: zero órfãs com motivo | **comprovado** | 219 exportações; `nowhere: []`; 7 com **razão declarada** no próprio auditor (dado ausente na entrada, utilitário interno, API documentada). `describeRanking` deixou de ser reimplementado na tela e vem do módulo |
| Memória na tela única (§3.2) | **comprovado** | a memória por usuário/estratégia só existia no diálogo do painel; agora a tela de configurações lista os namespaces (`e2e · smc · 2 nota(s)`) e permite limpar com confirmação — E2E 15 passos |
| Números do relatório conferidos | **comprovado** | `npm run audit:numbers` compara a ENTREGA com o artefato: arquivos do ZIP, versão do manifest, quantidade de verificações do gate e **se o aceite é mais novo que a última mudança em `extension/`**. Achou quatro números velhos (cobertura, perf, páginas, a11y) e dois de contagem; todos corrigidos |
| Idioma declarado por superfície | **comprovado, com limitação assumida** | o popup e os content scripts herdados usam o catálogo (**196 chaves** em `en` e `pt_BR`); o painel, a tela de configurações e a pesquisa são **pt-BR por decisão** e estão declarados assim em `npm run i18n:check`, que agora reprova uma superfície com texto visível e sem catálogo **e** uma declarada que passe a usar o catálogo. Limitação: produto bilíngue só no que é herdado |
| **Serviço real** (Ollama local, sem custo) | **comprovado** | `npm run smoke:live` chama um modelo local (**qwen3:8b**) em três fases: (1) **streaming** — 134 eventos, 364 caracteres, RSI real citado com fato separado de interpretação; (2) **cancelamento no meio do stream** — 117 caracteres, `POST /cancel` aceito, stream cortado; (3) **agentes da Sofia** — **3/3 pareceres válidos** do contrato JSON, todos `baixa`, consenso **sim** com concordância 1,0. Prova encanamento/streaming/cancelamento/contrato, **não** a qualidade da resposta |
| Sonda de contrato da API | **comprovado** | 10 requisições malformadas contra gateway real: 10/10 recusadas com código e mensagem (`bad_request`, `unknown_provider`, `model_not_available`). A sonda achou dois defeitos que os mocks escondiam: `/chat` aceitava `stream: false` e respondia SSE, e papel de mensagem fora do contrato era **coagido a `user`** em silêncio. Ambos corrigidos com teste |
| Sonda de contrato no gate | **comprovado** | `npm run probe:api`: **21 requisições malformadas**, cada uma com status e código de erro verificados, contra gateway real com upstream falso próprio (sem rede, sem chave). Virou gate; achou 4 defeitos ao todo, incluindo rota inexistente respondendo `400 bad_request` em vez de `404 not_found` |
| Host nativo sob entrada hostil | **comprovado** | 3 casos contra o binário real: JSON inválido é recusado e o host **segue respondendo**; frame truncado espera o resto em vez de cair; cabeçalho prometendo **2 GB** era esperado para sempre (travava o host) e agora é **recusado com o limite na mensagem**, encerrando para o Chrome reiniciar |
| Config sob storage hostil | **comprovado** | 8 casos: registro `null`/número/texto/array, versão futura, campos com tipo errado, registro parcial, registro de 2 MB e **storage que lança**. Nunca lança e cai no padrão. Dois silêncios corrigidos: listas inválidas eram consertadas sem `issue`, e falha de leitura era indistinguível de "nunca configurado" — o painel voltava ao padrão sem dizer nada |
| Validador Pine sob script hostil | **comprovado** | 14 scripts hostis (vazio, unicode, byte nulo, linha de 20 mil termos, arquivo de 1 MB, aspas abertas) sem lançar. Achou uma lacuna de §7: `varip` e `calc_on_every_tick=true` — duas fontes clássicas de repintura — não geravam diagnóstico; agora geram, e a palavra em comentário não vira falso positivo |
| Métricas do laboratório conferidas à mão | **comprovado, com 2 correções** | cada número do Strategy Lab foi refeito à mão num caso controlado: PnL, médias, profit factor, expectância, Sharpe com desvio amostral e anualização por √períodos, Calmar, recovery factor, exposição. Duas métricas mentiam: **drawdown máximo** era escolhido pelo valor em dinheiro (reportava 40% escondendo um tombo de 50%) e **exposição sem dado** saía como `0%` em vez de "não sei". Ambas corrigidas, com teste que fixa as convenções |
| Estatística de overfitting conferida à mão | **comprovado** | DSR contra caso calculado a mão (SR 1, n 100, N 2 → SR0 0,051980, z 7,70195), quantil normal contra valores conhecidos, deflação por propriedade (DSR cai de 1,0000 a **0,9269** de 2 para 1000 tentativas) e PBO **0** com estratégia dominante, meio-a-meio com séries indistinguíveis |
| Indicadores conferidos à mão | **comprovado** | SMA, EMA (α 2/(n+1) a partir da semente SMA), RSI (100 em altas, 0 em quedas, ~50 em zigue-zague), ATR (range constante = ele; gap eleva), Bollinger (σ populacional, conferido a 1e-6) e VWAP (preço constante; peso por volume) batem com a conta feita **fora** do código, e todos devolvem `null` em série curta em vez de número inventado |
| Bloco do prompt declara procedência | **comprovado** | 8 asserções sobre o texto que o modelo lê: fonte, timeframe, quantidade e horário do último candle aparecem; os números do texto batem com os calculados; indicador indisponível é **omitido** (nenhum `null`/`NaN` vaza para o prompt); a limitação nomeia o indicador e o mínimo que faltou; série curta diz "indisponíveis" com o mínimo; e o bloco instrui a rotular interpretação |
| Saturação do DSR declarada | **comprovado** | quando o DSR arredonda para ≥ 0,999, o relatório emite **limitação** dizendo que o número não distingue estratégia excelente de apenas forte e aponta PBO + out-of-sample; DSR limítrofe (≥ 0,95) avisa que mais tentativas o derrubam. A limitação chega à tela (`extension/copilot/app.js` renderiza `overfitting.limitations`) |
| Nenhum segredo versionado | **comprovado** | `npm run audit:secrets` (no gate): reprova se um caminho proibido for rastreado (config do gateway, `.env`, chaves, `node_modules`, `.zip`, perfil de navegador) ou se o conteúdo de arquivo rastreado casar com `sk-…`, `AIza…`, `ghp_…`, `xox…` ou chave privada. Provado injetando um segredo e um caminho proibido: os dois reprovaram; removidos, volta a 0 |
| Permissões conferidas contra o uso | **comprovado** | `npm run audit:permissions` (no gate): cada uma das **7 permissões** e das **2 origens** do manifest precisa de evidência no código, ou de justificativa explícita quando é implícita (`unlimitedStorage`, `activeTab`). Reprova permissão sem uso, origem sem uso e `cookies` por princípio (§10). Provado declarando `notifications` e `cookies`: os três avisos apareceram |
| Nenhum arquivo de teste fora do gate | **comprovado** | `npm run audit:test-files` (no gate) compara os **59 arquivos de teste** do repositório com os padrões que o gate declara. Existe porque o gate listava três dos quatro arquivos do gateway à mão e `gateway/core.test.mjs` **nunca rodou** — ficou falhando em silêncio por 15 rodadas. Agora os testes são descobertos por glob (`gateway/*.test.mjs`) e o auditor reprova arquivo não coberto |
| Erro oferece saída, não desculpa | **comprovado** | quando o painel "Strategy Tester" do TradingView não existe, o diálogo legado agora traz um botão **"Abrir DZ23 Research"** (mesmo botão nos outros dois becos de `extension/content_scripts/tv.js`, via `ui.researchAction()` — um só lugar para rótulo e mensagem) que abre o laboratório local (backtest sobre os candles, sem depender do TradingView). 4 testes cobrem o diálogo (botão só existe com ação, rótulo certo, clique executa e fecha, ação que lança não trava) e 2 cobrem a mensagem do background. `i18n:check`: chave nova nos 2 idiomas |
| Cada diálogo com a sua saída | **comprovado** | `docs/DIALOGOS.md` lista os **12** diálogos: 8 com botão (**Abrir DZ23 Research** onde o laboratório local resolve, **Tentar novamente** onde a falha é transitória) e 4 sem botão, com o motivo escrito. Um teste roda a doc contra o catálogo e reprova se ela citar chave inexistente; outro cobre `ui.retryAction` |
| README é a porta de entrada, e confere | **comprovado** | `npm run audit:readme` (no gate): compara o que o README **afirma** (verificações, testes, critérios, externas, ausentes) com o gate e com a evidência de aceite; reprova se o README mandar instalar pela Web Store (que publica o **original**), se a atribuição a `akumidv` sumir do `docs/NOTICE.md` ou se a licença GPL deixar de ser declarada. O README antigo foi preservado em `docs/UPSTREAM-README.md` |
| Desenho no gráfico (linhas/zonas/Fibonacci) | **ausente** | exigiria a API interna do chart; não é pública |
| Notícias/fundamentos/screener | **ausente** | não há fonte licenciada integrada; não foi simulado |
| Execução de ordens | **ausente por design** | o produto analisa e sugere; nada envia ordem |

---

## 3. Resultados dos testes (executados nesta entrega)

O resumo auditável de cada critério do §17 está em [ACEITACAO.md](docs/ACEITACAO.md): `npm run accept` roda os 14 checks
internos, grava `docs/ACEITACAO.json` e declara à parte o que é **EXTERNAL** (plano do MCP, Chrome do dono) e **ABSENT**
(desenho no gráfico, notícias/fundamentos/screener). Última execução: **14/14 PASS**.


Cada comando teve exit code capturado individualmente — nenhum "verde" herdado do anterior.

| Verificação | Exit | Testes | Pass | Fail | Skip |
|---|---|---|---|---|---|
| `npm run lint` | 0 | — | — | — | — |
| `npm run i18n:check` | 0 | — | — | — | — |
| `npm run test:tools` | 0 | 273 | 272 | 0 | 1 (opt-in de rede) |
| `npm run test:gateway` | 0 | 45 | 45 | 0 | 0 |
| `npm run test:quant` | 0 | 43 | 43 | 0 | 0 |
| `npm run test:dz23` | 0 | 9 | 9 | 0 | 0 |
| `npm run test:mcp` | 0 | 12 | 12 | 0 | 0 |
| `npm run test:bridge` | 0 | 8 passos | 8 | 0 | 0 |
| `npm run test:pine-ui` | 0 | 6 passos | 6 | 0 | 0 |
| `npm run test:settings-ui` | 0 | 11 passos | 11 | 0 | 0 |
| `npm run test:e2e` | 0 | 30 asserções | 30 | 0 | 0 |
| `npm run test:mcp-tv` (contrato OAuth/MCP) | 0 | 16 | 16 | 0 | 0 |
| `npm audit` | 0 | — | 0 vulnerabilidades | — | — |
| `release:check --dev --offline` | 0 | — | pacote válido | — | — |
| `npm run audit:gate` | 0 | 567 | 567 | 0 | 0 |
| `npm run audit:orphans` | 0 | — | 67 arquivos · 60 referências · 0 órfãos | — | — |
| `npm run backup:check` | 0 | — | 177 arquivos restaurados · 51 scripts compilados | — | — |

**Total:** 14 verificações, 0 falhas.

Natureza dos testes, sem confundir as coisas:

- **Real:** gateway (HTTP local), native host (processo real), MCP OAuth (descoberta e registro contra
  `tradingview.com`), DeepSeek (3 chamadas pagas autorizadas pelo dono), candles da Binance no CLI de agentes.
- **DOM sintético:** `bridge-e2e`, `test:e2e`, `test:settings-ui`, `test:pine-ui` — páginas locais com o mesmo DOM que
  as reais usam; o que é sintético está rotulado nos próprios testes.
- **Sem prova:** comportamento contra a página real do TradingView logado e contra o MCP autorizado (aguardando).

---

## 4. Riscos e pendências

| Risco | Impacto | Mitigação |
|---|---|---|
| Seletores do TradingView mudam | detecção do gráfico para | seletores por `data-name` + fallback por URL; `bridge-e2e` cobre o formato conhecido |
| MCP oficial exige plano pago | `tools/list` real não validado | fluxo pronto e testado; limite é do servidor (plano), declarado como dependência externa |
| Alertas só avaliam ao clicar | alerta "esquecido" | declarado na UI; próximo passo é agendador com `alarms` |
| Token do gateway em `chrome.storage.local` | perfil local | não é `localStorage`, não sai da máquina; chaves de provedor nunca entram na extensão |
| Bonjour 3.0.0.10 bloqueado pela LSA | ruído no Windows, sem relação com o produto | manter bloqueio; atualizar/remover Bonjour é opção do usuário |
| Single maintainer | continuidade | documentação por módulo + 32 verificações reproduzíveis por qualquer pessoa |
| 4 avisos **moderados** de dependência (eslint → minimatch) | só desenvolvimento: `extension/` não tem dependência em runtime; `npm audit --audit-level=high` sai 0 | **não é corrigível hoje**: a faixa afetada é `minimatch <11.0.1`, o eslint 10.x fixa `^10.2.x` e o eslint 11 **não existe** no registro (última: 10.14.0). O "fix" sugerido é *downgrade* para eslint 4.0.0, recusado. Resolver quando sair eslint com minimatch ≥ 11 |

---

## 5. Instalação

```powershell
# 1. extensão
#    chrome://extensions → modo desenvolvedor → "Carregar sem compactação"
#    selecione %USERPROFILE%\Documents\tradingview-assistant-chrome-extension-main\extension

# 2. gateway (uma vez por sessão do Windows)
cd %USERPROFILE%\Documents\tradingview-assistant-chrome-extension-main
npm run gateway:dev          # reusa o token de ~/.dz23/gateway-token

# 3. native host (opcional: deixa o gateway subir sozinho)
npm run host:install
#    NÃO passe --extension-id: o instalador deriva o ID da chave do manifest.
#    Um ID errado faz o host recusar a extensão de verdade (allowed_origins).
#    reinicie o Chrome depois

# 4. verificação
npm run test:tools ; npm run test:e2e
```

## 6. Configuração

Ver `docs/CONFIGURACAO.md`. Resumo: um registro (`dz23.config.v1`), pareamento automático em desenvolvimento, provedor
padrão selecionado em ⚙, chaves no **gateway** (`~/.dz23/providers.env` ou variáveis do usuário).

## 7. Rollback

```powershell
# voltar a extensão
#   chrome://extensions → remover → carregar a pasta de um snapshot em %USERPROFILE%\Documents\dz23-backups\
# remover o native host
npm run host:uninstall
# apagar a configuração e o pareamento
#   DevTools do painel → chrome.storage.local.remove('dz23.config.v1')
#   del "$env:USERPROFILE\.dz23\gateway-token"   (o próximo gateway:dev gera outro)
```

Backups: `%USERPROFILE%\Documents\dz23-backups\tv-assistant-*` (nenhum foi excluído).

Versionamento: desde 2026-10-31 o projeto tem histórico Git — commits `ab10b8e` (entrega v2.17.0) e `c651194` (guarda de
segredos) — e remoto **privado** em https://github.com/LMPrado-DZ23/dz23-tradingview-assistant, com autorização explícita
do dono. Procedimento de volta atrás em [ROLLBACK.md](docs/ROLLBACK.md).

## 8. Automação e repetibilidade

```powershell
npm run lint ; npm run i18n:check
npm run test:tools ; npm run test:gateway ; npm run test:quant ; npm run test:dz23 ; npm run test:mcp
npm run test:mcp-tv ; npm run test:bridge ; npm run test:pine-ui ; npm run test:settings-ui ; npm run test:e2e
npm audit ; npm run release:check -- --dev --offline
npm run pine:check -- script.pine
npm run agents -- "pergunta" --symbol BTCUSDT --interval 1h [--live]
npm run tv:mcp -- login | status | tools | call <tool> '{}'
```

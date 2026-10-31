# DZ23 Quant Research Platform — relatório de entrega

Versão do artefato: **2.16.0** · Data: 2026-10-29/30 · Repositório local (não é repositório git: sem branch/commit).
Backup do estado inicial: `C:\Users\lmpra\Documents\dz23-backups\tv-assistant-20261029-225005`.

## O que existe agora

| Etapa | Entrega | Evidência |
|---|---|---|
| Prioritário | `gateway/` (serviço local, Node stdlib) + `extension/copilot/` (painel lateral) | 32 testes de gateway; UI em Chrome headless (streaming, histórico, parar/copiar/regenerar/avaliar) |
| 1 — auditoria/hardening | 10 itens fechados: origem exata nos dois lados do bridge, `err` fora de escopo, Plotly sob demanda, confirmação no "apagar tudo", API de storage, globais implícitos, testes de regressão, CI com testes+i18n+lint, ESLint, códigos de erro (`handler_failed`, `unknown_action`) | 128 testes de extensão/ferramentas; popup nas 2 línguas, 86 slots, 0 não resolvido |
| 2 — motor quant | `extension/quant/`: métricas documentadas, split IS/OOS, walk-forward, robustez de parâmetros, Monte Carlo semeado, PBO (CSCV) + Deflated Sharpe, ponte com o resultado real | **43 testes** com valores calculáveis à mão; `extension/quant/metrics.mjs` (fórmulas no código) |
| 3 — UI de pesquisa | `extension/research/`: CSV → Top 15, heatmap 2D, avisos, experimento JSON | Chrome headless: 5 combinações, heatmap com `—` para célula ausente, contrato válido, 0 erro de app |
| 4 — contrato JSON | `extension/quant/contract.mjs` — schema `1.0.0`, validação com `path`, serialização estável, resumo para agentes | testes de contrato + usado pela UI e pela ponte |
| 6 — empacotamento | `dist/tradingview-assistant-2.16.0.zip` (45 arquivos, manifest na raiz, sem `node_modules`/`.git`/`gateway`) | verificado por extração: 25 referências do manifest todas presentes |

## Como rodar

```powershell
# 1. copiloto (opcional: só se quiser IA)
$env:DZ23_GATEWAY_TOKEN = [guid]::NewGuid().ToString()
$env:OPENAI_API_KEY = "..."          # ou DEEPSEEK_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY
npm run gateway                       # http://127.0.0.1:8777

# 2. extensão
# chrome://extensions → modo desenvolvedor → "Carregar sem compactação" → pasta extension/
# popup → "Abrir copiloto" (painel lateral) ou "Abrir pesquisa"

# 3. verificação
npm run i18n:check
npm run test:tools        # 128
npm run test:gateway      # 32
npm run test:quant        # 43
npm run lint
node _aitna/tools/release/cli.mjs check --offline
```

## Contrato do experimento (resumo)

`schema_version: 1.0.0`; campos obrigatórios: `experiment_id`, `strategy_id`, `strategy_version`, `asset`,
`timeframe`, `data_provider`, `data_license_reference`, `period`, `parameters`, `metrics`, `costs`,
`in_sample`/`out_of_sample` (ou `null` com aviso), `robustness`, `overfitting`, `warnings`, `engine_version`,
`created_at`. `validateExperiment` devolve todos os erros com `path`; `serializeExperiment` é estável por bytes.

## Limitações estatísticas (declaradas, não escondidas)

- Uma execução de backtest **não** permite IS/OOS nem PBO/DSR: a ponte grava `null` + aviso `no_out_of_sample` /
  `no_trial_series`. É preciso rodar um segundo período.
- PBO e DSR assumem trials comparáveis e ~independentes; parâmetros correlacionados tornam ambos otimistas.
- Sharpe/Sortino são por trade salvo `periodsPerYear` explícito; sem capital inicial as métricas percentuais são
  `null` com motivo.
- Nada aqui prevê retorno futuro; simulações são distribuições, não garantias.

## BLOCKED_BY_EXTERNAL_DEPENDENCY

1. **Teste live dos provedores de IA** — sem credenciais nesta máquina. Integração implementada e testada contra
   provedor simulado por HTTP real; o teste live é `POST /test` com a chave do dono.
2. **Branch git / commit / push** — a pasta não é um repositório; nada foi versionado (decisão do dono).
3. **`npm run release:pack`** — o CLI `zip` não existe no Windows desta máquina. O pacote foi gerado com
   `Compress-Archive` e verificado por extração; a ferramenta oficial do projeto continua sem rodar aqui.
4. **Integração Hermes / TradingView real** — não testada; o contrato JSON está pronto para o consumo, mas
   nenhum agente DZ23 foi conectado e nenhum teste com a página real do TradingView foi executado.
5. **UI E2E como extensão carregada** — o Chrome 137+ desativa `--load-extension`; a UI foi verificada por página
   servida em HTTP, com gateway real. Falta o teste manual com a extensão instalada.

## O que NÃO foi feito (e não foi maquiado)

- Nenhuma execução de ordens reais (por design).
- Nenhum scraping ou captura de dados restritos do TradingView.
- Atalhos de teclado, anexos de arquivo no chat e servidores MCP da seção 4 do pedido: **não implementados**.
  O `botão` correspondente também não existe — preferi a ausência à opção decorativa.
- Memória por usuário/estratégia além do histórico de conversas e do contexto por conversa: **não implementada**.

---

## Auditoria final (v2.16.0, estado atual)

| Item | Entrega | Testes |
|---|---|---|
| 1 · manifest.key dev/release + MV3 | `--dev` no `release:check`/`pack`; release exige a chave; MV3 validado | `release:check --dev` → **ok: true** |
| 2 · gateway + diagnóstico | `/diagnose` (credential/auth/streaming/cancel) + botão na UI; `DZ23_PROVIDER_ENV` para credenciais fora do repo | **37** |
| 3 · chat | anexos (tipo/tamanho/truncamento), atalhos (⌘/Ctrl+Enter, ⌘/Ctrl+K, Esc), memória por usuário/estratégia, recuperação de conversas | **memória 11 · anexos 12 · conversas 9** |
| 4 · MCP | registro com lista explícita de ferramentas, política allow/ask/deny, confirmação humana, isolamento por token, log sem argumentos, CLI | **12** |
| 5 · DZ23/Hermes | ingestão autenticada, validação no servidor, idempotência, conflito 409, canônico serializado | **9** |
| 6 · git/release | git local, `.gitignore` sem secrets, `release:pack` nativo (Windows), integridade verificada por extração | pacote verificado |
| 7 · testes | lint 0 erro · 160 + 37 + 43 + 12 + 9 = **261 testes** | 0 falha |
| 8 · relatório | este documento | — |

Pacote: `assistant-ext.zip` (raiz, gitignored) · 45 arquivos · manifest na raiz · 25 referências presentes.

### BLOCKED_BY_EXTERNAL_DEPENDENCY

1. **Testes live dos provedores** — sem credenciais válidas. As chaves coladas em chat foram tratadas como
   comprometidas e **não foram usadas nem gravadas**; o fluxo é o arquivo local `~/.dz23/providers.env`.
2. **Instalação manual no Chrome** — exige ação do dono (Chrome 137+ bloqueia `--load-extension`); a UI foi
   verificada por página servida em HTTP com gateway real.
3. **Integração Hermes** — o contrato e o endpoint de ingestão existem e são testados; o lado do agente não foi
   conectado.

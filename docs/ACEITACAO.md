# Critérios de aceitação — relatório auditável

`npm run accept` **delega ao gate único** (`npm run audit:gate`), mapeia os vereditos para cada critério do §17, grava
`docs/ACEITACAO.json` e imprime o resultado. Não existe uma segunda lista de comandos para divergir da real — foi o que
aconteceu duas vezes antes desta mudança (uma suíte que mudou de lugar, um caminho errado).

Um `PASS` sem execução é impossível: o gate exige **prova** de cada comando (mínimo de testes por suíte, marcador de saída
por script) e o JSON registra o gate, a quantidade de testes e o tempo.

Última execução: **2026-10-31**, `{"ok":true,"gateGates":22,"totalTests":567,"criteria":16,"pass":16,"fail":0,"external":2,"absent":2}`.

| Veredito | Significado |
|---|---|
| **PASS** | o gate rodou aqui, produziu a evidência declarada e passou |
| **EXTERNAL** | depende de algo fora desta máquina/sessão (plano pago, o Chrome do dono) |
| **ABSENT** | não implementado, por design ou porque a API/fonte não existe |

## Resultado

| # | Critério (§17) | Gate(s) que prova(m) | Veredito |
|---|---|---|---|
| 1 | Configuração centralizada, popup e copiloto juntos | `tools` | **PASS** |
| 2 | Gateway inicia pelo mecanismo suportado e sobrevive ao host | `gateway` | **PASS** |
| 3 | CORS e tokens protegidos | `security` | **PASS** |
| 4 | Invariantes de segurança (§10) | `security` | **PASS** |
| 5 | Pareamento, streaming, candles, contexto, ações verificáveis | `e2e` | **PASS** |
| 6 | Contexto lido do DOM real do TradingView | `bridge` | **PASS** |
| 7 | Pine: validar, gerar, explicar | `tools` | **PASS** |
| 8 | Strategy Lab reproduzível + comparação com viés | `quant` + `strategy` | **PASS** |
| 9 | Desempenho: estático e páginas reais | `perf-static` + `perf-pages` | **PASS** |
| 10 | Acessibilidade medida (WCAG) | `a11y` | **PASS** |
| 11 | Telas: configurações, watchlists, alertas, pesquisa, contraste | `settings-ui` + `pine-ui` + `contrast` | **PASS** |
| 12 | Documentação coerente | `docs` | **PASS** |
| 13 | Nenhum arquivo órfão ou referência quebrada | `orphans` | **PASS** |
| 14 | Backup íntegro e rollback ensaiado | `backup` | **PASS** |
| 15 | Pacote de distribuição íntegro | `release` | **PASS** |
| 16 | Dependências sem vulnerabilidade alta + código sem erro de lint | `audit` + `lint` | **PASS** |

Os 22 gates incluem ainda `i18n` (toda chave usada existe nos três idiomas) e `mcp`, que sustentam os critérios acima sem
linha própria.

## O que não é PASS — e por quê

| Critério | Veredito | Motivo declarado |
|---|---|---|
| MCP oficial: `tools/list` com token real | **EXTERNAL** | o servidor responde *"É necessário um plano pago"* para esta conta |
| Extensão carregada no Chrome do usuário após as mudanças | **EXTERNAL** | exige `chrome://extensions → ↻` pelo dono; o Chrome 155 não aceita `--load-extension` |
| Desenhar linhas/zonas/Fibonacci, layouts, aplicar Pine no gráfico | **ABSENT** | sem API pública; exigiria automação do DOM do chart, não verificável aqui |
| Notícias, fundamentos, calendário econômico, eventos corporativos | **ABSENT** | sem fonte licenciada integrada; não foi simulado |

## Como ler isso

- As linhas `EXTERNAL` não são falhas do produto: são dependências que o ambiente não fornece. O código para elas existe
  e está testado (16 testes de contrato do OAuth; o fluxo pronto para rodar quando houver plano).
- As linhas `ABSENT` são decisões, não pendências esquecidas: cada uma exigiria burlar controle de acesso ou automatizar o
  DOM do gráfico — o §6 proíbe o primeiro e o §5 alerta contra o segundo como única forma de integração.
- **Não há PASS por ausência de teste.** O gate reprova um comando que sai com 0 sem produzir evidência; foi assim que um
  glob vazio foi descoberto (ver `docs/ENTREGA.md`, seção de higiene).
- Avisos **moderados** de dependência (4, todos dev-only via eslint) aparecem na matriz de riscos da entrega; o
  `--audit-level=high` do gate cobre o que chega ao produto.

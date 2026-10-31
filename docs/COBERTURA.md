# Cobertura de testes

Medida com o Node de cobertura do V8 via `c8`, sobre a suíte que exercita os módulos puros (`_aitna/tools/extension-tests`).

## `npm run test:coverage`

```powershell
npm run test:coverage        # falha se cair abaixo dos limites
```

| Métrica | Hoje | Limite (falha abaixo) |
|---|---|---|
| Statements | **94,17%** (5 305/5 633) | 92% |
| Branches | **77,72%** (1 874/2 411) | 68% |
| Functions | **83,38%** (296/355) | 80% |

Os limites estão abaixo do atual de propósito: são guarda de regressão, não vaidade. Um PR que quebre 30 asserts derruba a
cobertura e o comando sai com código 1.

### Por que o número caiu de 97,45% para 94,17%

Não foi perda de teste: foi **escopo maior na conta**. Os testes passaram a importar as próprias ferramentas de auditoria
(`audit:package`, `audit:gate`, `audit:mutation`, o remetente do `dz23`) para provar que elas reprovam o que devem reprovar.
Esses arquivos entram na medição e são exercitados só nos caminhos testados — `_aitna/tools/release/lib.mjs` (45%), `dz23/ingest.mjs` (76%),
`_aitna/tools/strategy/compare.mjs` (83%), `_aitna/tools/audit/package.mjs` (77%). O código de produto continua com módulos em 100%: `extension/copilot/memory.js`,
`extension/quant/metrics.mjs`, `extension/quant/montecarlo.mjs`, `extension/lib/agents.js`.

Preferi o número honesto ao número bonito: excluir as ferramentas da medição inflaria a métrica e esconderia justamente o
código que passou a existir para **fiscalizar** o resto.

## O que a medição encontrou (e foi corrigido)

A primeira medição mostrou **`extension/quant/montecarlo.mjs` com 31,42% de statements e 33,33% de funções** — o módulo
que sustenta a alegação de "Monte Carlo" no Strategy Lab estava quase sem teste. Escrevi 11 casos cobrindo:

- determinismo do PRNG (mesma semente → mesma sequência e mesmo relatório);
- sementes diferentes → distribuições diferentes;
- **propriedade do bootstrap**: `E[soma de n sorteios] = n × média da amostra` (não "a soma é preservada" — com reposição
  ela não é, e meu primeiro teste estava errado nisso);
- `blockSize` = tamanho da amostra → rotação, que **aí sim** preserva a soma; `blockSize` intermediário → distribuição;
- capital inicial e a regra de ruína (`equity <= capital × threshold`);
- sequência de perdas consecutivas limitada pelo tamanho da amostra;
- percentis monotônicos e dentro do observado;
- recusa de amostra vazia e de iterações inválidas (0, fracionário, > 100 000).

Resultado: **100% statements, 94,87% branches, 100% functions** nesse módulo.

Efeito no total: statements de 94,82% → **96,79%**; funções de 83,64% → **85,13%**.

## Limites desta medição

- Cobre os **módulos puros**. As telas (`.html`/`extension/page-context.js`) e o conteúdo injetado em página são exercitados por
  E2E com DOM sintético, que não entra no cálculo de cobertura de linha.
- `native-host/host.mjs` aparece com ~78% porque parte do comportamento é exercitada por processo real (E2E), não por unidade.
- Branch coverage é o número mais baixo e o mais honesto: caminhos de erro que ainda não têm teste dedicado
  (`extension/quant/metrics.mjs` 53% de branches é o próximo alvo natural).
- `c8` é baixado via `npx` na primeira execução (**precisa de rede uma vez**); depois fica em cache. Por isso este comando
  **não** faz parte do gate obrigatório, que continua rodando offline.

## O que a segunda medição encontrou

Depois do Monte Carlo, o alvo era `extension/lib/config.js` (73,62% de branches), e escrever os testes de resiliência
revelou **dois defeitos reais** — não de teste:

1. **Storage que nunca chama o callback travava o boot para sempre.** Extensão despejada ou porta morta deixava o painel
   esperando indefinidamente. Agora leitura e gravação têm **prazo de 800 ms**, as duas leituras legadas correm em
   paralelo e, se o storage não respondeu, a gravação é pulada com aviso: pior caso **1,6 s** em vez de infinito.
2. **Configuração gravada como texto JSON era descartada.** `validateConfig` recebia a string e respondia
   "config não é um objeto", jogando fora dados do usuário. Agora o texto é interpretado antes de validar e regravado como
   objeto; texto inválido cai na recuperação normal, com aviso.

Cobertura do módulo: statements 94,36% → **96,87%**, branches 73,62% → **83,49%**.

Os testes também corrigiram três expectativas minhas: `save()` grava mais de uma vez, o cache em memória vale após uma
gravação que falhou (mas um `load()` seguinte relê o storage e volta aos padrões), e "gravar uma vez" era simplesmente
falso. Cada uma está comentada no arquivo para não ser "consertada" de volta.

## O que a terceira medição encontrou

Os dois alvos seguintes eram `extension/lib/config.js` e `extension/quant/metrics.mjs`. Ambos agora estão em **100% de
statements** (branches 88,23% e 87,62%), e o trabalho rendeu testes que faltavam em números que o leitor lê direto:

- **Retorno anualizado composto**: +21% em dois anos é **10,0% ao ano**, não 10,5% (a divisão simples mentiria). Também
  testado com prejuízo (-19% em dois anos → -10%), e nulo **com motivo** quando falta capital ou período — nunca zero.
- **Exposão de tempo**: metade do período exposto = 50%; sobreposição de trades aparece como está (200%), porque o número
  é dado, não erro de conta.
- **Calmar** = anualizado / drawdown%, nulo quando falta denominador.
- **Reparo campo a campo** da configuração: `gateway` inválido volta ao padrão **preservando usuário e alertas**; `ai`
  inválido volta ao padrão **preservando gateway e token**; URL inválida e token não-texto são corrigidos
  individualmente. É literalmente a promessa escrita no módulo ("repaired field by field, never thrown away") — agora
  com prova.

## O que a quarta medição encontrou

Alvo seguinte: `extension/copilot/memory.js` (88,07%), o módulo de memória por usuário e por estratégia. **100% de
statements, 89,47% de branches**. O que ficou provado:

- **isolamento real, não filtro**: a chave contém usuário *e* estratégia, então a memória da Ana não aparece para o Bruno
  nem ao listar estratégias — o teste consulta as duas pontas;
- **storage que recusa gravar** devolve `{ ok: false, reason }` e o chat continua; **storage ausente** também é recusado
  com motivo, e nada é inventado;
- **entrada corrompida** no storage é descartada, sem propagar erro;
- limites de quantidade e de tamanho de nota são aplicados (truncar, não rejeitar);
- **caminho real do navegador**: sem storage explícito o módulo usa `localStorage`, e um `localStorage` que lança no
  acesso (modo privado, storage bloqueado) deixa a memória efêmera em vez de quebrar o painel.

Meu primeiro erro aqui foi adivinhar a API (`remember/recall/forget`): os nomes reais são `add/list/replace/clear`.
Seis testes falharam de uma vez com `TypeError: not a function` — e foi o teste que apontou, não o compilador.

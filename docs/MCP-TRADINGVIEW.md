# MCP oficial do TradingView — integração e limite de plano

## O que foi descoberto do servidor (execução real, 2026-10-30)

| Passo | Resposta observada |
|---|---|
| `POST https://mcp.tradingview.com/mcp` sem token | `401` + `WWW-Authenticate: Bearer resource_metadata="https://mcp.tradingview.com/.well-known/oauth-protected-resource/mcp"` |
| `GET /.well-known/oauth-protected-resource/mcp` | `{"resource":"https://mcp.tradingview.com/mcp","authorization_servers":["https://www.tradingview.com"],"bearer_methods_supported":["header"]}` |
| `GET https://www.tradingview.com/.well-known/oauth-authorization-server` | authorize, token, **register**, revoke; `code_challenge_methods_supported:["S256"]`; `token_endpoint_auth_methods_supported:["none", ...]`; `scopes_supported:["mcp:read","mcp:tools"]` |
| `POST /mcp/oauth/register` | cliente público criado (ex.: `RKMhGY_oaox3qWlHiR1Zbp4eaRvH5_6H`) |
| `GET /mcp/oauth/authorize?...` com PKCE | **"É necessário um plano pago. Você está conectado, mas a conexão … ao servidor TradingView MCP requer um plano pago ativo."** |

Esse último passo é a fronteira: **o MCP oficial exige plano pago ativo**. A conta usada está autenticada e no plano
TV Free. Não é falha de configuração do DZ23 — é o servidor recusando pelo plano.

## O que está implementado e testado (independe do plano)

- `mcp/tradingview-oauth.mjs` — descoberta de metadados, **registro dinâmico**, PKCE S256, URL de autorização com
  `resource`, troca de código, renovação por `refresh_token`, normalização e expiração com margem.
- `mcp/tradingview-client.mjs` — JSON-RPC sobre HTTP com bearer, aceita resposta **JSON e SSE**, `initialize`,
  `tools/list`, `tools/call`, `ping`; **401 vira `AuthRequired`** (com `resource_metadata`) e não é repetido; erro
  JSON-RPC x erro HTTP distinguidos; retry só de transporte.
- `mcp/tradingview-cli.mjs` — `login | status | tools | call | logout`; callback em `127.0.0.1` com validação de
  `state`; token em `~/.dz23/tradingview-mcp.json` (modo 0600, fora do repositório); a URL de autorização exata é salva
  em `~/.dz23/tradingview-authorize-url.json`.
- **16 testes de contrato** (`npm run test:mcp-tv`): PKCE, registro, troca, renovação, expiração, JSON/SSE, 401 sem
  retry, erro HTTP, sem token não chama a rede, retry de transporte, servidor HTTP real.

## Bug real encontrado no caminho

Abrir o navegador com `cmd /c start <url>` no Windows faz o `cmd` interpretar `&` como separador: a URL chegava cortada
no primeiro `&` e o servidor respondia **"Parâmetro client_id ausente"**. Corrigido para
`rundll32.exe url.dll,FileProtocolHandler` (argumento único, sem shell). A URL completa também passou a ser salva em
arquivo para cópia sem truncamento.

## Como retomar quando houver plano pago

```powershell
npm run tv:mcp -- login     # autorize no navegador; o token é gravado em ~/.dz23
npm run tv:mcp -- status    # mostra escopo e validade, nunca o token
npm run tv:mcp -- tools     # lista as ferramentas que o servidor realmente oferece
npm run tv:mcp -- call <tool> '{"arg":1}'
```

Quando a autorização concluir, a lista de ferramentas é a **fonte de verdade** do que existe naquele plano — este
documento não presume catálogo.

## Limite declarado

`BLOCKED_BY_EXTERNAL_DEPENDENCY`: autorização do MCP oficial impossível nesta conta (plano pago ativo exigido pelo
servidor). O produto **não depende** desse MCP: contexto do gráfico, candles, métricas, Pine, Strategy Lab, agentes,
watchlists e alertas funcionam sem ele, e o mesmo canal serve para qualquer outra fonte MCP compatível.

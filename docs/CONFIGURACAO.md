# Configuração (DZ23)

Uma única fonte de verdade: **`dz23.config.v1`** em `chrome.storage.local`. O painel do copiloto, o popup e o
popup-bridge leem e escrevem o mesmo registro; os formatos antigos são migrados uma vez, sem serem apagados.

## Registro

```json
{
  "version": 1,
  "gateway": { "url": "http://127.0.0.1:8777", "token": "" },
  "ai": { "provider": "deepseek", "model": "deepseek-chat", "modelsByProvider": { "deepseek": ["deepseek-chat"] } },
  "user": "local",
  "popup": { "options": { "optParamName": "Total PnL" } },
  "meta": { "migratedAt": "2026-10-30T...", "migratedFrom": ["dz23.copilot.v2", "iondvOptions"] }
}
```

| Campo | Regra de validação | Se inválido |
|---|---|---|
| `gateway.url` | texto iniciando em `http(s)://` | volta ao padrão `http://127.0.0.1:8777` |
| `gateway.token` | texto | vira `""` (o pareamento devolve um novo) |
| `ai.provider` | `[a-z0-9-]` | vira `""` |
| `ai.model` | texto | vira `""` |
| `ai.modelsByProvider` | objeto | vira `{}` |
| `user` | texto não vazio | vira `"local"` |
| `popup.options` | objeto | vira `{}` |
| `version` | inteiro igual a 1 | lido como 1 |

Chaves desconhecidas **sobrevivem** (um build novo pode gravar campos que um antigo não conhece).

## Migração

Na primeira leitura sem `dz23.config.v1`:

1. `dz23.copilot.v2` (localStorage, painel) → `gateway`, `ai`, `user`.
2. `iondvOptions` (chrome.storage.local, popup) → `popup.options` (o `tabId` transitório é descartado).
3. O resultado é validado e gravado em `dz23.config.v1`; as chaves antigas **permanecem**.
4. A segunda leitura vê o registro novo e não migra de novo (idempotente; há teste para isso).

Se o JSON legado estiver corrompido, o painel abre com os padrões e registra o problema em `console.warn`; nada quebra.

## Tela única

`extension/settings/index.html` é a **interface central**. Ela contém, nesta ordem:

| Seção | O que resolve |
|---|---|
| Gateway | URL, token, testar conexão, iniciar pelo host nativo, origem permitida |
| Provedores de IA | lista com "configurado/não", testar e diagnosticar cada um, provedor e modelo padrão |
| Conta e preferências | usuário das notas e da memória |
| Watchlists | criar, adicionar/remover ativos, comparar listas, ranking de oportunidades |
| Alertas do DZ23 | criar, editar, pausar, retomar, excluir, avaliar agora |
| Memória | every namespace `usuário · estratégia · N nota(s)`, com limpar (confirmação) |
| Diagnóstico | registro/versão/migração/token/health e **uso por provedor** (latência, falhas, tokens) |
| Segurança | bind em loopback, allowlist de origem, CSP, onde o token vive |

Abre por: popup **⚙** no cabeçalho, botão **Configurações completas** no diálogo do copiloto, ou `chrome://extensions →
Opções` (o manifest declara `options_ui`). Teste: `npm run test:settings-ui` (gateway falso, `chrome.storage` em memória,
cliques reais, 15 passos).

### O que **não** fica na tela única, e por quê

O §3.2 pede uma tela central, não uma cópia de tudo. Estes três são **contextuais por conversa** e vivem no painel, no
diálogo de contexto:

| Item | Onde | Por que não é configuração global |
|---|---|---|
| Estratégia e notas do experimento | painel, diálogo de contexto | descrevem a análise daquela conversa; duas abas podem analisar estratégias diferentes ao mesmo tempo |
| Ativo e timeframe | painel | vêm do gráfico ativo, não de uma preferência salva |
| Memória por estratégia | editada no painel, **listada na tela única** | o namespace depende da estratégia da conversa; a tela única mostra e limpa o que existe |

Não há tela concorrente: as duas superfícies leem o mesmo `dz23.config.v1` (memória em chaves
`dz23.memory.v1:<usuário>:<estratégia>`, escritas pelo painel e lidas/limpas pela tela única). O popup continua com suas
opções de tarefa, espelhadas em `iondvOptions`, sem tela própria de gateway/provedores.

## Leitura e escrita

- Painel: `extension/lib/config.js` (`createConfigStore`, `toSettings`, `fromSettings`). As conversas continuam em
  localStorage (`dz23.copilot.v2` como cache do histórico), as **configurações** vão para o registro único.
- Popup: `extension/lib/config-bridge.js` mantém `iondvOptions` como espelho, para que um build antigo continue
  funcionando; ao abrir, `ready` garante que o espelho existe antes de restaurar os campos.
- Pareamento: `GET /token` só responde em desenvolvimento; o painel busca o token no `boot()` e grava no registro.

## Reset e diagnóstico

- Trocar tudo: DevTools do painel → `chrome.storage.local.remove('dz23.config.v1')` → recarregar (a migração roda de
  novo a partir do legado, que não é apagado).
- O diálogo ⚙ → **Testar conexão** chama `/health` e `/providers` com os valores atuais e diz o que falhou.
- Testes: `_aitna/tools/extension-tests/config.test.mjs` (11) e `_aitna/tools/extension-tests/config.integration.test.mjs` (3).

## Limites conhecidos

- A migração é local ao perfil do Chrome; não há sincronização entre máquinas (o token é por instalação).
- O token fica em `chrome.storage.local` (não é `localStorage`, mas também não é DPAPI). A chave do provedor **nunca**
  entra na extensão: ela vive no processo do gateway (`~/.dz23/providers.env` ou variáveis de ambiente do Windows).

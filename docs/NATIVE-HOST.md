# Inicialização automática do gateway (Native Messaging)
> **O ID não depende da pasta.** O manifest da extensão carrega uma chave pública (`key`), então o ID é sempre
> `ejmflepgfmffgicdjdaigdfdcacehgma` — o mesmo do `allowed_origins` do host e da allowlist do gateway. O instalador
> deriva esse ID da chave; não é preciso copiar nada de `chrome://extensions`.
>
> **Ao atualizar de uma versão sem `key`**: o ID muda. Recarregue a extensão, reinstale o host
> (`node native-host/install.mjs`) e refaça o pareamento — o token vem pelo host, sem digitação. Configurações guardadas
> sob o ID antigo não são herdadas (o armazenamento é por extensão); o registro único recomeça dos padrões e da migração legada.


O Chrome não permite que uma extensão inicie processos. A solução suportada é um **Native Messaging host**: um
executável registrado pelo usuário que fala com a extensão por stdio. O DZ23 usa isso para subir e supervisionar o
gateway em `127.0.0.1:8777`.

```
extensão (painel)  --dz23:gateway:ensure-->  background.js  --connectNative-->  com.dz23.gateway
                                                                                      │
                                                                        spawn node gateway/server.mjs
                                                                                      │
                                                                        GET /health (prova real)
```

## Instalação (uma vez, por usuário)

```powershell
cd %USERPROFILE%\Documents\tradingview-assistant-chrome-extension-main
node native-host/install.mjs --extension-id ejmflepgfmffgicdjdaigdfdcacehgma
```

O instalador:

1. grava `native-host/manifest.json` com `allowed_origins` **exatamente** o ID da extensão (nenhuma outra origem é aceita);
2. grava `native-host/dz23-host.cmd` (o Chrome precisa de um caminho executável; o launcher chama `node host.mjs`);
3. registra `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dz23.gateway` → caminho do manifesto.

`HKCU` = sem elevação, sem serviço, sem tarefa agendada. Reinicie o Chrome depois de instalar.

Descobrir o ID: `chrome://extensions` → modo desenvolvedor → cartão do DZ23. O ID é estável para o mesmo caminho de
pasta (extensão sem compactação); se você mover a pasta, reinstale com o novo ID.

## Comandos

| Ação | Comando |
|---|---|
| Instalar | `node native-host/install.mjs` (o ID é derivado da `key` do manifest) |
| Ver o que será escrito | `node native-host/install.mjs --dry-run` |
| Sobrescrever o ID (caso raro) | `node native-host/install.mjs --extension-id <32 letras a-p>` |
| Remover | `node native-host/install.mjs --uninstall` |
| Diagnóstico | `node native-host/install.mjs --dry-run` e, na tela de configurações, **Rodar diagnóstico** |

## Ciclo de vida

- **start**: o host checa `/health`; se já houver gateway no ar, responde `already: true` (não duplica). Se não houver,
  faz `spawn` de `gateway/server.mjs` **detached** e espera o health responder (até 12 s). Só depois informa sucesso —
  nunca "conectado" porque o processo foi criado.
- **sobrevivência**: o gateway é do usuário, não do host. Ele é iniciado `detached` e continua no ar quando o Chrome
  fecha o canal. Fechar o painel não derruba a IA.
- **stop**: só encerra o que o host iniciou (`owned`). Se o gateway foi subido por `npm run gateway:dev`, o `stop` recusa
  com "o gateway não foi iniciado por este host" — evita que o painel mate um processo que não é dele.
- **status**: distingue três estados: nada no ar, algo no ar mas não é filho do host, filho do host. O `health` traz
  `protocol`, `providers` e `configured` reais.

## Chaves dos provedores

O Chrome inicia o host com o **ambiente dele**, que pode não ter as variáveis do usuário. Por isso o host:

1. carrega `~\.dz23\providers.env` se existir;
2. para `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY`
   e `GROQ_API_KEY` ausentes, lê o valor de `HKCU\Environment` (a variável que você já definiu).

Nada é copiado para arquivo novo e o token do gateway nunca aparece em log (o host mascara UUIDs antes de guardar as
últimas linhas).

## Segurança

- `allowed_origins` aceita **apenas** `chrome-extension://<id>/` — outra extensão instalada não consegue falar com o host.
- O host não aceita comandos arbitrários: `status`, `start`, `stop`, `diagnose`. Não executa shell nem recebe caminhos.
- O gateway continua com token obrigatório, CORS por allowlist e bind em `127.0.0.1`.
- O host roda com o seu usuário (sem elevação).

## Desinstalação e rollback

```powershell
node native-host/install.mjs --uninstall     # remove registro, manifesto e launcher
```

O `--uninstall` **não** encerra um gateway em execução — encerre manualmente se quiser. As chaves e o token permanecem
em `~\.dz23\`. Rollback completo = desinstalar o host, `npm run gateway:dev` e seguir usando o painel como antes (o
pareamento automático continua funcionando).

## Limitações conhecidas

- Só **Chrome/Chromium**; outros navegadores exigem o próprio registro de host.
- O host não se registra sozinho: a instalação é um passo explícito (por segurança, nada escreve no registro sem você).
- Não há watchdog: se o gateway cair depois de iniciado, o próximo `status` mostra `running: false` e o painel volta a
  "gateway off-line"; um novo `ensure` sobe de novo.
- Testes automatizados: `_aitna/tools/extension-tests/native-host.test.mjs` (3 casos, processo real + gateway falso).

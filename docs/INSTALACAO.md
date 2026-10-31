# Instalação

Do zero até o copiloto respondendo. Cada comando abaixo foi **executado nesta máquina** e o resultado observado está
registrado — nada aqui é instrução copiada de documentação antiga.

## Pré-requisitos

| Item | Verificado | Observação |
|---|---|---|
| Windows | 10/11 | o gateway e o native host usam caminhos e registro do Windows |
| Node.js | **v24.22.1** | `node --version`. v22+ funciona; nada usa API experimental |
| Chrome | 137+ | o carregamento sem compactação exige modo desenvolvedor |
| Chrome for Testing | em `_aitna/.browser/` | baixado por `npx puppeteer browsers install`; **não** está no Git |

## 1. Extensão

```powershell
# chrome://extensions → modo desenvolvedor → "Carregar sem compactação"
# selecione a pasta: C:\Users\lmpra\Documents\tradingview-assistant-chrome-extension-main\extension
```

O ID é **fixo** por causa da `key` no manifest: `ejmflepgfmffgicdjdaigdfdcacehgma`. Mover a pasta para outro caminho
**não** muda o ID, então a configuração do usuário e o pareamento sobrevivem.

## 2. Gateway

```powershell
cd C:\Users\lmpra\Documents\tradingview-assistant-chrome-extension-main
npm run gateway:dev
```

Resultado observado:

```
[gateway] http://127.0.0.1:8777
[gateway] token para o copiloto: …
```

O processo fica em primeiro plano e **sai quando você o encerra** (Ctrl+C); o `npm run gateway:dev` não deixa gateway
órfão. Para checar: `Invoke-RestMethod http://127.0.0.1:8777/health` → `status=ok, providers=9`.

## 3. Native host (opcional — deixa o gateway subir sozinho)

```powershell
npm run host:install
# reinicie o Chrome depois
```

**Não passe `--extension-id`.** O instalador deriva o ID da chave do manifest e acerta sozinho. Passar um ID errado faz o
host **recusar** a extensão de verdade (a origem não entra em `allowed_origins`) — é uma armadilha silenciosa. A flag existe
apenas para instalação manual de outro ID.

Desinstalar: `node native-host/install.mjs --uninstall`.

## 4. Provedor de IA

As chaves ficam no **gateway**, nunca na extensão: `~/.dz23/providers.env` ou variáveis de usuário do Windows. Depois, em
⚙ → Provedores, escolha o provedor e o modelo. Sem chave, o provedor local (Ollama) continua funcionando de graça.

## 5. Verificação

```powershell
npm run verify          # gate com evidência + pacote + conferência dos números do relatório
npm run test:e2e        # Chrome real, painel real, gateway de teste (executado: exit 0)
npm run smoke:live      # modelo local de verdade (skip declarado se não houver Ollama)
```

Se algum falhar, **não** ajuste o teste: leia a saída, que sempre diz o que faltou.

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Painel diz "gateway offline" | gateway não está rodando | `npm run gateway:dev` ou reabra o Chrome com o host instalado |
| Painel diz "não pareado" | token ausente no registro | o pareamento é automático em desenvolvimento; use ⚙ → Diagnóstico para ver o estado do token |
| `test:e2e` falha com "chrome.exe não encontrado" | Chrome for Testing ausente | `npx puppeteer browsers install chrome` (cai em `_aitna/.browser/`) |
| Ação no gráfico "não confirmada" | o gráfico não respondeu à releitura | recarregue a aba do TradingView; o painel nunca declara sucesso sem reler o estado |

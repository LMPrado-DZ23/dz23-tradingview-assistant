# Rollback e recuperação

Três formas de voltar atrás, da mais rápida para a mais completa. Escolha a que corresponde ao tamanho do problema — e nunca
"conserte" apagando o histórico.

## 1. Voltar a extensão que estava carregada no Chrome (segundos)

O Chrome guarda a versão desempacotada anterior em `chrome://extensions`. Quando o código novo não abre o painel:

1. `chrome://extensions` → cartão do DZ23 → **↻ Recarregar**.
2. Se continuar quebrado, desabilite a extensão, restaure a pasta a partir do pacote anterior (`assistant-ext.zip` guardado
   antes da mudança) e recarregue.
3. A configuração do usuário **não** é perdida: ela vive em `chrome.storage.local`, ligada ao ID fixo
   `ejmflepgfmffgicdjdaigdfdcacehgma`, que não muda entre versões.

## 2. Voltar o código com Git (minutos)

O repositório tem histórico desde 2026-10-31 (remoto privado
`https://github.com/LMPrado-DZ23/dz23-tradingview-assistant`). Um commit quebrado não é motivo para editar arquivos à mão:

```powershell
cd %USERPROFILE%\Documents\tradingview-assistant-chrome-extension-main

git log --oneline -10          # veja onde você está e o que quer recuperar
git revert <hash>              # desfaz UM commit criando outro (preserva o histórico)
# ou, para voltar tudo a um ponto conhecido:
git checkout <hash> -- .       # traz os arquivos daquele ponto para a árvore de trabalho
```

`git revert` é o padrão: desfaz o efeito e mantém o registro de que houve problema — o que o `history` precisa para
auditoria. `git reset --hard` **apaga** o trabalho não commitado: só use se você tem certeza de que não precisa dele.

Depois de qualquer volta atrás, prove que o estado é sadio:

```powershell
npm run verify     # gate com evidência + pacote + conferência dos números do relatório
```

## 3. Voltar pelo backup da pasta inteira (último recurso)

Backups completos, nunca excluídos: `%USERPROFILE%\Documents\dz23-backups\tv-assistant-*`.

Cada backup é uma cópia íntegra da árvore e **executa a própria suíte** para provar que é recuperável:

```powershell
npm run backup:check
```

## O que o rollback NÃO desfaz

| Item | Por quê |
|---|---|
| Configuração do usuário (`chrome.storage.local`) | é dado do dono, não do código; sobrevive ao rollback de propósito |
| Token do gateway (arquivo de configuração local em `gateway/`) | fora do versionamento (segredo); rotate com `node native-host/install.mjs` se comprometido |
| Segredo que já foi commitado | fica no histórico mesmo depois de apagado — revogue a chave, não apenas remova o arquivo |
| Migração de configuração já aplicada | `dz23.config.v1` é idempotente; voltar versão não "desmigra" |

## Regras

1. **Não apague backup** para liberar espaço nem para "limpar".
2. **Não use `git reset --hard`** em trabalho não commitado sem antes conferir `git status`.
3. **Não declare recuperação sem rodar** `npm run verify` no estado restaurado.
4. Se o problema é um segredo exposto: revogar a credencial vem **antes** de qualquer limpeza de histórico.

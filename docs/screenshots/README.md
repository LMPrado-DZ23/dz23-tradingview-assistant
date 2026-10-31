# Capturas de tela

Evidência visual do produto, gerada pelas ferramentas de `_aitna/tools/e2e/`. **Não é mock nem maquete**: cada imagem é o
Chrome for Testing abrindo a extensão real com um gateway de teste respondendo.

Regenerar de propósito:

```powershell
npm run docs:screenshots
```

As verificações normais (`npm run test:a11y`, `npm run perf:check`, `npm run audit:gate`) gravam em pasta temporária e
**não** reescrevem estas imagens — só o comando acima escreve aqui, para a árvore ficar limpa depois do gate.

| Arquivo | O que mostra | Ferramenta |
|---|---|---|
| `01-copilot-420.png` | painel do copiloto na largura compacta (420 px) | `_aitna/tools/e2e/copilot-e2e.mjs` |
| `02-contexto-preview.png` | prévia do contexto que vai para o modelo | `_aitna/tools/e2e/copilot-e2e.mjs` |
| `03-painel-390.png` | painel na largura estreita (390 px) | `_aitna/tools/e2e/copilot-e2e.mjs` |
| `04-configuracoes.png` | tela única de configurações | `_aitna/tools/e2e/copilot-e2e.mjs` |
| `05-popup-dz23.png` | popup na aba do DZ23 | `_aitna/tools/e2e/popup-shot.mjs` |
| `06-popup-resultados.png` | popup na aba de resultados | `_aitna/tools/e2e/popup-shot.mjs` |
| `07-pine-research.png` | área de Pine Script / pesquisa | `_aitna/tools/e2e/research-pine.mjs` |
| `08-settings-page.png` | configurações com as 8 seções | `_aitna/tools/e2e/settings-page.mjs` |
| `09-settings-dialog.png` | diálogo de configuração (foco preso) | `_aitna/tools/e2e/settings-page.mjs` |
| `popup-tab-1..5.png` | abas do assistente original, uma por função | `_aitna/tools/e2e/popup-shot.mjs` |

## Regra

Imagem de evidência envelhece: se a interface mudou e a captura não, a captura **mente**. Ao mudar qualquer tela, rode
`npm run docs:screenshots` e confira o diff antes de commitar.

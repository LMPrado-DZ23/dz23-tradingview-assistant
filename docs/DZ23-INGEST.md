# Ingestão de experimentos (dz23)

Serviço local que recebe um experimento do contrato versionado e grava **um arquivo por experimento** em
`dz23/data/`. Bind em `127.0.0.1` apenas, token obrigatório, validação repetida no servidor (ele nunca confia no cliente).

## Subir

```powershell
$env:DZ23_INGEST_TOKEN = "escolha-um-segredo"
npm run dz23:ingest            # 127.0.0.1:8788
```

Variáveis: `DZ23_INGEST_PORT` (padrão 8788) e `DZ23_INGEST_DATA` (padrão `dz23/data`).

## Enviar um experimento

```powershell
npm run dz23:send -- experiments/btc-1h.json
```

O remetente valida o arquivo **antes** de enviar, compara o hash do aceite com o da releitura e só sai com 0 se o que foi
gravado é o que foi enviado. Sem token, o comando para antes de tentar (exit 2).

## Rotas

| Rota | Efeito |
|---|---|
| `GET /health` | estado do serviço |
| `POST /experiments` | validação + gravação; 201 novo, 200 replay idêntico, 409 conflito de conteúdo, 422 contrato |
| `GET /experiments/:id` | devolve o experimento com o hash e o horário de recebimento |

## Por que existe

É a metade que faltava do hand-off pesquisa → agentes: o serviço aceitava experimentos desde o início, mas **nada os
enviava**. O remetente é a outra ponta, testada contra o servidor real (5 testes).

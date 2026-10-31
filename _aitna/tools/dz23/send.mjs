#!/usr/bin/env node
// Sends an experiment to the local DZ23 ingest service — the missing half of the research → agents hand-off.
//
//   npm run dz23:send -- experiments/btc-1h.json
//   DZ23_INGEST_TOKEN=... npm run dz23:send -- experiments/btc-1h.json --url http://127.0.0.1:8788
//
// The file is validated here first, so a bad payload fails with a readable reason instead of a 400 from the server.
// The server validates again (it never trusts a client), and stores one file per experiment. Exit 0 only when the
// stored copy is read back with the same hash.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { validateExperiment, serializeExperiment } from '../../../extension/quant/contract.mjs'

const USAGE = `uso: node _aitna/tools/dz23/send.mjs <arquivo.json> [--url http://127.0.0.1:8788] [--token T]

O token também pode vir de DZ23_INGEST_TOKEN. O arquivo precisa ser um experimento válido do contrato versionado.`

function parseArgs (argv) {
  const args = { file: null, url: process.env.DZ23_INGEST_URL ?? 'http://127.0.0.1:8788', token: process.env.DZ23_INGEST_TOKEN ?? '' }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--url')
      args.url = argv[++index]
    else if (item === '--token')
      args.token = argv[++index]
    else if (!item.startsWith('--') && !args.file)
      args.file = item
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (!args.file) {
  console.error(USAGE)
  process.exit(2)
}

let raw
try {
  raw = JSON.parse(readFileSync(args.file, 'utf8'))
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: `não consegui ler ${args.file}: ${String(error.message).slice(0, 120)}` }))
  process.exit(2)
}

// Validação local: mesma função do contrato, para o erro nascer perto do arquivo.
const local = validateExperiment(raw)
if (!local.ok) {
  console.error(JSON.stringify({ ok: false, error: 'experimento inválido', problems: (local.errors ?? local.problems ?? []).slice(0, 8) }, null, 2))
  process.exit(1)
}
if (!args.token) {
  console.error(JSON.stringify({ ok: false, error: 'sem token: defina DZ23_INGEST_TOKEN ou passe --token' }))
  process.exit(2)
}

const body = JSON.stringify(raw)
const payloadHash = createHash('sha256').update(serializeExperiment(raw)).digest('hex')

const response = await fetch(`${args.url.replace(/\/$/, '')}/experiments`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${args.token}` },
  body,
}).catch((error) => ({ ok: false, status: 0, json: async () => ({ error: { message: `gateway inalcançável: ${error.message}` } }) }))

const answer = await response.json().catch(() => ({}))
if (!response.ok) {
  console.error(JSON.stringify({ ok: false, status: response.status, error: answer?.error ?? answer }, null, 2))
  process.exit(1)
}

// Confirma lendo de volta: aceito não é o mesmo que gravado.
// O servidor responde com `experiment_id` e calcula o hash do corpo bruto — comparo os hashes dele
// (o do aceite e o da leitura), não um hash meu, senão estaria comparando coisas diferentes.
const id = answer.experiment_id ?? answer.id ?? ''
const stored = id
  ? await fetch(`${args.url.replace(/\/$/, '')}/experiments/${encodeURIComponent(id)}`, {
    headers: { authorization: `Bearer ${args.token}` },
  }).then((item) => item.json()).catch(() => null)
  : null

const storedValid = Boolean(stored?.experiment) && validateExperiment(stored.experiment).ok
const sameHash = Boolean(stored?.hash) && stored.hash === answer.hash

console.log(JSON.stringify({
  ok: storedValid && sameHash,
  id: id || null,
  bytes: Buffer.byteLength(body),
  payloadHash,
  acceptedHash: answer.hash ?? null,
  storedHash: stored?.hash ?? null,
  storedValid,
  readBack: Boolean(stored?.experiment),
}, null, 2))
process.exit(storedValid && sameHash ? 0 : 1)

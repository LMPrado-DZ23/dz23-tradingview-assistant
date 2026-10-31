// The research → agents hand-off: the ingest service existed with POST /experiments and nothing could send to it.
// These tests drive the sender against a real ingest server started in-process, then read the stored copy back.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createExperiment } from '../../../extension/quant/contract.mjs'
import { createIngest } from '../../../dz23/ingest.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const SEND = join(ROOT, '_aitna/tools/dz23/send.mjs')
const TOKEN = 'send-test-token'

function experiment (overrides = {}) {
  return createExperiment({
    strategyId: 'smc-breakout',
    strategyVersion: '1.0.0',
    asset: 'BTCUSDT',
    timeframe: '1h',
    dataProvider: 'binance-public',
    dataLicenseReference: 'public-market-data',
    period: { from: '2024-01-01T00:00:00Z', to: '2024-12-31T00:00:00Z' },
    parameters: { length: 20 },
    metrics: { netProfit: 1200 },
    costs: { commissionPct: 0.04, slippagePct: 0.01 },
    createdAt: '2025-01-05T10:00:00.000Z',
    ...overrides,
  })
}

async function withIngest (run) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dz23-send-'))
  const { server } = createIngest({ authToken: TOKEN, dataDir, logger: { log: () => {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    return await run({ baseUrl, dataDir })
  } finally {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dataDir, { recursive: true, force: true })
  }
}

function runSender (args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [SEND, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout ?? ''}${stderr ?? ''}` })
    })
  })
}

test('envia um experimento válido, grava no ingest e confirma pela releitura', async () => {
  await withIngest(async ({ baseUrl, dataDir }) => {
    const file = join(dataDir, 'experimento.json')
    const payload = experiment()
    writeFileSync(file, JSON.stringify(payload))
    const result = await runSender([file, '--url', baseUrl, '--token', TOKEN])
    assert.equal(result.code, 0, result.output)
    const summary = JSON.parse(result.output)
    assert.equal(summary.ok, true)
    assert.equal(summary.readBack, true, 'confirma lendo de volta, não só o 201')
    assert.equal(summary.storedValid, true)
    assert.equal(summary.acceptedHash, summary.storedHash, 'o hash do aceite é o mesmo da releitura (servidor concorda consigo)')
    assert.ok(summary.id, 'devolve o id do experimento')
  })
})

test('experimento inválido falha localmente, antes de chegar ao servidor', async () => {
  await withIngest(async ({ baseUrl, dataDir }) => {
    const file = join(dataDir, 'invalido.json')
    const payload = { ...experiment(), schema_version: 'dz23.experiment.v0' }
    writeFileSync(file, JSON.stringify(payload))
    const result = await runSender([file, '--url', baseUrl, '--token', TOKEN])
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.output)
    assert.equal(summary.ok, false)
    assert.match(summary.error, /inválido/)
    assert.ok(summary.problems.length > 0, 'diz o que está errado, com caminho')
  })
})

test('sem token não tenta enviar', async () => {
  const result = await runSender(['arquivo-inexistente.json'], { DZ23_INGEST_TOKEN: '' })
  assert.equal(result.code, 2)
  assert.match(result.output, /não consegui ler/)
})

test('token errado é recusado pelo servidor, com o status real', async () => {
  await withIngest(async ({ baseUrl, dataDir }) => {
    const file = join(dataDir, 'ok.json')
    writeFileSync(file, JSON.stringify(experiment()))
    const result = await runSender([file, '--url', baseUrl, '--token', 'errado'])
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.output)
    assert.equal(summary.ok, false)
    assert.equal(summary.status, 401, 'propaga o status, não inventa sucesso')
  })
})

test('servidor fora do ar é reportado sem lançar', async () => {
  await withIngest(async ({ dataDir }) => {
    const file = join(dataDir, 'ok.json')
    writeFileSync(file, JSON.stringify(experiment()))
    // porta fechada de propósito
    const result = await runSender([file, '--url', 'http://127.0.0.1:1', '--token', TOKEN])
    assert.equal(result.code, 1)
    const summary = JSON.parse(result.output)
    assert.equal(summary.ok, false)
  })
})

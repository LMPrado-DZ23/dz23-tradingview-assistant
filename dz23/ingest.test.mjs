import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createExperiment, serializeExperiment } from '../extension/quant/contract.mjs'
import { createIngest } from './ingest.mjs'

// The ingest service is the hand-off to the DZ23 agents: it must accept a valid experiment once, replay it
// idempotently, refuse a conflicting one, and never accept a payload it did not validate itself.

const TOKEN = 'ingest-test-token'
const dirs = []
const servers = []
after(() => {
  for (const server of servers) server.close()
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

async function start () {
  const dataDir = mkdtempSync(join(tmpdir(), 'dz23-ingest-'))
  dirs.push(dataDir)
  const { server } = createIngest({ authToken: TOKEN, dataDir, logger: { log: () => {} } })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, dataDir }
}

const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

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

const post = (baseUrl, body, headers = auth) => fetch(`${baseUrl}/experiments`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })

test('a valid experiment is stored once and answered with its id and hash', async () => {
  const { baseUrl, dataDir } = await start()
  const payload = experiment()
  const response = await post(baseUrl, payload)
  const body = await response.json()
  assert.equal(response.status, 201)
  assert.equal(body.ok, true)
  assert.equal(body.experiment_id, payload.experiment_id)
  assert.match(body.hash, /^[a-f0-9]{64}$/)
  assert.deepEqual(readdirSync(dataDir), [`${payload.experiment_id}.json`])
  const stored = JSON.parse(readFileSync(join(dataDir, `${payload.experiment_id}.json`), 'utf8'))
  assert.equal(stored.experiment.metrics.netProfit, 1200)
  assert.equal(stored.canonical, serializeExperiment(payload), 'the canonical form is what a consumer can hash')
})

test('the same payload sent twice is a replay, not a duplicate error', async () => {
  const { baseUrl, dataDir } = await start()
  const payload = experiment()
  assert.equal((await post(baseUrl, payload)).status, 201)
  const replay = await post(baseUrl, payload)
  assert.equal(replay.status, 200)
  assert.equal((await replay.json()).replayed, true)
  assert.equal(readdirSync(dataDir).length, 1)
})

test('the same experiment_id with other content is a conflict', async () => {
  const { baseUrl } = await start()
  const payload = experiment()
  await post(baseUrl, payload)
  const changed = { ...payload, metrics: { ...payload.metrics, netProfit: 999 } }
  const response = await post(baseUrl, changed)
  assert.equal(response.status, 409)
  assert.equal((await response.json()).error.code, 'experiment_conflict')
})

test('an experiment that breaks the contract is refused with every path', async () => {
  const { baseUrl, dataDir } = await start()
  const broken = experiment()
  broken.strategy_id = ''
  broken.metrics.netProfit = Number.NaN
  const response = await post(baseUrl, broken)
  const body = await response.json()
  assert.equal(response.status, 422)
  assert.equal(body.error.code, 'invalid_experiment')
  const paths = body.error.details.map((detail) => detail.path)
  assert.ok(paths.includes('strategy_id'), paths.join(','))
  assert.ok(paths.includes('metrics.netProfit'), paths.join(','))
  assert.equal(readdirSync(dataDir).length, 0, 'a refused experiment is not stored')
})

test('without the bearer token nothing is accepted nor read', async () => {
  const { baseUrl } = await start()
  const anonymous = await post(baseUrl, experiment(), { 'content-type': 'application/json' })
  assert.equal(anonymous.status, 401)
  const wrong = await post(baseUrl, experiment(), { authorization: 'Bearer nope', 'content-type': 'application/json' })
  assert.equal(wrong.status, 401)
  const read = await fetch(`${baseUrl}/experiments/anything`)
  assert.equal(read.status, 401)
})

test('a stored experiment can be read back, and an unknown id is 404', async () => {
  const { baseUrl } = await start()
  const payload = experiment()
  await post(baseUrl, payload)
  const read = await fetch(`${baseUrl}/experiments/${payload.experiment_id}`, { headers: auth })
  const body = await read.json()
  assert.equal(read.status, 200)
  assert.equal(body.experiment.experiment_id, payload.experiment_id)
  const missing = await fetch(`${baseUrl}/experiments/does-not-exist`, { headers: auth })
  assert.equal(missing.status, 404)
})

test('malformed JSON, an empty body and an oversized payload are refused', async () => {
  const { baseUrl } = await start()
  assert.equal((await post(baseUrl, '{not json')).status, 400)
  assert.equal((await post(baseUrl, '')).status, 400)
  const huge = JSON.stringify({ ...experiment(), metrics: { netProfit: 1, padding: 'x'.repeat(2 * 1024 * 1024) } })
  const response = await post(baseUrl, huge)
  assert.equal(response.status, 413)
})

test('the health endpoint answers without a token and counts what is stored', async () => {
  const { baseUrl } = await start()
  const empty = await (await fetch(`${baseUrl}/health`)).json()
  assert.equal(empty.stored, 0)
  await post(baseUrl, experiment())
  const after = await (await fetch(`${baseUrl}/health`)).json()
  assert.equal(after.stored, 1)
})

test('the service refuses to start without a token', () => {
  assert.throws(() => createIngest({ authToken: '', dataDir: tmpdir() }), /token/)
})

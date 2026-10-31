// Fallback chain and usage ledger: rules, ordering and bounded recording.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProviderChain, createUsageLedger, isFallbackable, recordUsage, runWithFallback, summarizeUsage, USAGE_LIMIT,
} from './fallback.mjs'

const providers = [
  { id: 'deepseek', enabled: true, configured: true },
  { id: 'openai', enabled: true, configured: false },
  { id: 'ollama', enabled: true, configured: true },
  { id: 'antropico', enabled: false, configured: true },
]

test('só falhas do provedor justificam fallback', () => {
  for (const code of ['timeout', 'upstream_error', 'rate_limited', 'provider_unavailable'])
    assert.equal(isFallbackable(code), true, code)
  for (const code of ['bad_request', 'unauthorized', 'model_not_available', 'unknown_provider', 'cancelled'])
    assert.equal(isFallbackable(code), false, code)
})

test('cadeia: pedido primeiro, depois só provedores habilitados e configurados', () => {
  assert.deepEqual(buildProviderChain(providers, { provider: 'deepseek', fallback: true }), ['deepseek', 'ollama'])
  assert.deepEqual(buildProviderChain(providers, { provider: 'deepseek', fallback: ['openai', 'ollama'] }), ['deepseek', 'ollama'])
  assert.deepEqual(buildProviderChain(providers, { provider: 'ollama' }), ['ollama'])
  assert.equal(buildProviderChain(providers, { provider: 'deepseek', fallback: ['nope'] }).length, 1)
  assert.throws(() => buildProviderChain(providers, { provider: 'inexistente' }), /unknown/)
  assert.throws(() => buildProviderChain(providers, { provider: 'antropico' }), /unknown or disabled/, 'provedor desabilitado é erro, não fallback silencioso')
})

test('sem provedor pedido, o primeiro configurado abre a cadeia', () => {
  assert.deepEqual(buildProviderChain(providers, { fallback: true }).slice(0, 1), ['deepseek'])
})

test('fallback tenta o próximo quando o erro permite e o texto não foi entregue', async () => {
  const calls = []
  const result = await runWithFallback({
    chain: ['a', 'b', 'c'],
    attempt: async (provider) => {
      calls.push(provider)
      if (provider === 'a')
        throw Object.assign(new Error('boom'), { code: 'upstream_error' })
      return { provider }
    },
  })
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(result.used, 'b')
  assert.equal(result.attempts, 2)
})

test('não faz fallback depois de entregar texto (não duplica resposta parcial)', async () => {
  const calls = []
  await assert.rejects(() => runWithFallback({
    chain: ['a', 'b'],
    attempt: async (provider) => {
      calls.push(provider)
      throw Object.assign(new Error('caiu no meio'), { code: 'upstream_error', delivered: true })
    },
  }), /caiu no meio/)
  assert.deepEqual(calls, ['a'])
})

test('não faz fallback para erro de pedido (queimaria cota à toa)', async () => {
  const calls = []
  await assert.rejects(() => runWithFallback({
    chain: ['a', 'b'],
    attempt: async (provider) => {
      calls.push(provider)
      throw Object.assign(new Error('modelo não existe'), { code: 'model_not_available' })
    },
  }), /modelo/)
  assert.deepEqual(calls, ['a'])
})

test('após esgotar a cadeia, o erro carrega as tentativas', async () => {
  const error = await runWithFallback({
    chain: ['a', 'b'],
    attempt: async (provider) => {
      throw Object.assign(new Error(`falhou ${provider}`), { code: 'timeout' })
    },
  }).catch((caught) => caught)
  assert.match(error.message, /falhou b/)
  assert.deepEqual(error.attempts, [{ provider: 'a', ok: false, code: 'timeout' }, { provider: 'b', ok: false, code: 'timeout' }])
})

test('onFallback recebe de onde e para onde', async () => {
  const switches = []
  await runWithFallback({
    chain: ['a', 'b'],
    attempt: async (provider) => {
      if (provider === 'a')
        throw Object.assign(new Error('x'), { code: 'timeout' })
      return { ok: true }
    },
    onFallback: (from, to) => switches.push(`${from}->${to}`),
  })
  assert.deepEqual(switches, ['a->b'])
})

test('ledger é limitado e agrega por provedor', () => {
  const ledger = createUsageLedger(3)
  for (let index = 0; index < 5; index += 1)
    recordUsage(ledger, { provider: 'deepseek', ok: index % 2 === 0, ms: 100, inputTokens: 10, outputTokens: 20 })
  assert.equal(ledger.entries.length, 3, 'janela limitada')
  const summary = summarizeUsage(ledger)
  assert.equal(summary.window, 3)
  assert.equal(summary.limit, 3)
  assert.equal(summary.providers.deepseek.attempts, 3)
  assert.equal(summary.providers.deepseek.inputTokens, 30)
  assert.equal(summary.providers.deepseek.averageMs, 100)
  assert.ok(summary.last)
})

test('resumo separa sucesso de falha e guarda o último código de erro', () => {
  const ledger = createUsageLedger(10)
  recordUsage(ledger, { provider: 'ollama', ok: true, ms: 40 })
  recordUsage(ledger, { provider: 'ollama', ok: false, code: 'timeout', ms: 5000 })
  recordUsage(ledger, { provider: 'deepseek', ok: true, ms: 900 })
  const summary = summarizeUsage(ledger)
  assert.equal(summary.providers.ollama.ok, 1)
  assert.equal(summary.providers.ollama.failed, 1)
  assert.equal(summary.providers.ollama.lastError, 'timeout')
  assert.equal(summary.providers.ollama.averageMs, 2520)
  assert.equal(summary.providers.deepseek.attempts, 1)
})

test('limite padrão é o declarado', () => {
  assert.equal(createUsageLedger().limit, USAGE_LIMIT)
})

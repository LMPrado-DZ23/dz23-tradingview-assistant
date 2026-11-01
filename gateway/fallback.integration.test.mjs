// Fallback over real HTTP: the first provider fails with 500, the second answers, and the usage ledger records both.
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createServer } from 'node:http'
import { createGateway } from './server.mjs'

const TOKEN = 'test-token-1234567890'
const servers = []
after(() => {
  for (const server of servers)
    server.close()
})

async function listen (server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

function fakeUpstream ({ broken = false } = {}) {
  return createServer(async (request, response) => {
    // O corpo precisa ser consumido antes de responder (senão o socket fica pendurado) e é aqui que ele vira conferência:
    // um provedor falso que aceita requisição vazia esconde um gateway que parou de mandar o payload. Antes o corpo era
    // acumulado numa variável que ninguém lia — parecia conferido, não era.
    let bytes = 0
    for await (const chunk of request)
      bytes += chunk.length
    if (bytes === 0) {
      response.writeHead(400, { 'content-type': 'text/plain' })
      response.end('empty body')
      return
    }
    if (broken) {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('upstream exploded')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"choices":[{"delta":{"content":"do segundo"}}]}\n\n')
    response.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2}}\n\n')
    response.write('data: [DONE]\n\n')
    response.end()
  })
}

test('troca de provedor no meio do pedido, e o consumo registra as duas tentativas', async () => {
  const brokenUrl = await listen(fakeUpstream({ broken: true }))
  const healthyUrl = await listen(fakeUpstream())
  const gateway = createGateway({
    config: {
      host: '127.0.0.1',
      port: 0,
      authToken: TOKEN,
      timeoutMs: 2000,
      rateLimit: { capacity: 50, refillPerSecond: 50 },
      providers: {
        openai: { baseUrl: `${brokenUrl}/v1`, apiKey: 'sk-test', models: ['gpt-test'], defaultModel: 'gpt-test' },
        'openai-compatible': { baseUrl: `${healthyUrl}/v1`, apiKey: 'compat', models: ['compat-model'], defaultModel: 'compat-model' },
      },
    },
    env: {},
  })
  const address = await gateway.listen()
  servers.push(gateway.server)
  const base = `http://127.0.0.1:${address.port}`
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }

  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ provider: 'openai', fallback: ['openai-compatible'], messages: [{ role: 'user', content: 'oi' }] }),
  })
  assert.equal(response.status, 200)
  const body = await response.text()
  const events = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))

  const start = events.find((event) => event.type === 'start')
  assert.deepEqual(start.fallbacks, ['openai-compatible'], 'o cliente sabe quem é o reserva')

  const notice = events.find((event) => event.type === 'notice')
  assert.equal(notice.code, 'provider_fallback')
  assert.equal(notice.from, 'openai')
  assert.equal(notice.to, 'openai-compatible')

  const deltas = events.filter((event) => event.type === 'delta').map((event) => event.text).join('')
  assert.equal(deltas, 'do segundo', 'o texto veio do provedor reserva')
  assert.ok(events.some((event) => event.type === 'done'), 'a resposta terminou normalmente')

  const usage = await fetch(`${base}/usage`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((item) => item.json())
  assert.equal(usage.providers.openai.failed, 1)
  assert.equal(usage.providers['openai-compatible'].ok, 1)
  assert.ok(usage.providers['openai-compatible'].averageMs >= 0)
})

test('sem fallback pedido, o erro do provedor chega como erro (comportamento antigo)', async () => {
  const brokenUrl = await listen(fakeUpstream({ broken: true }))
  const gateway = createGateway({
    config: {
      host: '127.0.0.1',
      port: 0,
      authToken: TOKEN,
      timeoutMs: 2000,
      rateLimit: { capacity: 50, refillPerSecond: 50 },
      providers: {
        openai: { baseUrl: `${brokenUrl}/v1`, apiKey: 'sk-test', models: ['gpt-test'], defaultModel: 'gpt-test' },
      },
    },
    env: {},
  })
  const address = await gateway.listen()
  servers.push(gateway.server)
  const base = `http://127.0.0.1:${address.port}`
  const response = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'openai', messages: [{ role: 'user', content: 'oi' }] }),
  })
  const body = await response.text()
  const events = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  const error = events.find((event) => event.type === 'error')
  assert.ok(error, 'sem fallback, o erro é reportado')
  assert.equal(error.error.code, 'upstream_error')
  assert.ok(!events.some((event) => event.type === 'notice'), 'nenhuma troca anunciada')
})

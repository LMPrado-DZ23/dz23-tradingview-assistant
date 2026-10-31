import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createGateway } from './server.mjs'
import { parseEnvFile } from './core.mjs'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real HTTP on both sides: a fake provider that speaks the three wire formats and the failure modes the gateway
// has to classify. No external network, no credential, and nothing is stubbed inside the gateway itself.

const servers = []
after(() => {
  for (const server of servers) server.close()
})

async function listen (server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function startFakeProvider () {
  const calls = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    let raw = ''
    for await (const chunk of request) raw += chunk
    calls.push({ path: url.pathname, search: url.search, headers: request.headers, body: raw ? JSON.parse(raw) : null })

    if (url.pathname.startsWith('/fail/')) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
      return
    }
    if (url.pathname.startsWith('/broken/')) {
      response.writeHead(500, { 'content-type': 'text/plain' })
      response.end('upstream exploded')
      return
    }
    if (url.pathname.startsWith('/slow/')) {
      await sleep(1500)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
      return
    }
    if (url.pathname.startsWith('/stall/')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: {"choices":[{"delta":{"content":"oi"}}]}\n\n')
      await sleep(5000)
      response.end('data: [DONE]\n\n')
      return
    }
    if (url.pathname === '/openai/chat/completions') {
      if (calls.at(-1).body?.stream === false) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { choices: [{ delta: { content: 'Olá' } }] },
        { choices: [{ delta: { content: ', mundo' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      ]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
        await sleep(5)
      }
      response.write('data: [DONE]\n\n')
      response.end()
      return
    }
    if (url.pathname === '/anthropic/messages') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Olá' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: ' da Anthropic' } },
        { type: 'message_stop' },
      ]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
        await sleep(5)
      }
      response.end()
      return
    }
    if (url.pathname.startsWith('/gemini/models/')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of [
        { candidates: [{ content: { parts: [{ text: 'Olá' }] } }] },
        { candidates: [{ content: { parts: [{ text: ' do Gemini' }] }, finishReason: 'STOP' }] },
      ]) {
        response.write(`data: ${JSON.stringify(event)}\n\n`)
        await sleep(5)
      }
      response.end()
      return
    }
    if (url.pathname === '/plain/chat/completions') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found')
  })
  return { url: await listen(server), calls }
}

const TOKEN = 'test-token-value'

function baseConfig (fake, overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 0,
    authToken: TOKEN,
    timeoutMs: 800,
    rateLimit: { capacity: 200, refillPerSecond: 200 },
    providers: {
      openai: { baseUrl: `${fake.url}/openai`, apiKey: 'sk-openai-test', models: ['gpt-test'], defaultModel: 'gpt-test' },
      anthropic: { baseUrl: `${fake.url}/anthropic`, apiKey: 'an-test', models: ['claude-test'], defaultModel: 'claude-test' },
      gemini: { baseUrl: `${fake.url}/gemini`, apiKey: 'gm-test', models: ['gemini-test'], defaultModel: 'gemini-test' },
      ollama: { baseUrl: `${fake.url}/slow`, models: ['slow-model'], defaultModel: 'slow-model' },
      openrouter: { baseUrl: `${fake.url}/fail`, apiKey: 'or-test', models: ['or-model'], defaultModel: 'or-model' },
      'openai-compatible': { baseUrl: `${fake.url}/plain`, apiKey: 'compat-test', models: ['compat-model'], defaultModel: 'compat-model' },
    },
    ...overrides,
  }
}

async function startGateway (config, env = {}) {
  const gateway = createGateway({ config, env })
  const address = await gateway.listen()
  servers.push(gateway.server)
  return { gateway, baseUrl: `http://127.0.0.1:${address.port}` }
}

const authorized = (extra = {}) => ({ authorization: `Bearer ${TOKEN}`, ...extra })

async function collectChat (baseUrl, body, headers = authorized()) {
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const events = text
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data:'))
    .map((block) => JSON.parse(block.slice(5).trim()))
  return { status: response.status, contentType: response.headers.get('content-type'), events, text }
}

test('the health endpoint answers without a token and counts configured providers', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/health`)
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.status, 'ok')
  // Every provider of the fixture has a key except Ollama, which is local and therefore usable without one
  assert.equal(body.configured, 6)
})

test('every other route requires the bearer token', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  for (const headers of [{}, { authorization: 'Bearer wrong-token' }]) {
    const response = await fetch(`${baseUrl}/providers`, { headers })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'unauthorized')
  }
})

test('the provider list never exposes a credential', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/providers`, { headers: authorized() })
  const body = await response.json()
  assert.equal(response.status, 200)
  const openai = body.providers.find((provider) => provider.id === 'openai')
  assert.equal(openai.configured, true)
  assert.equal(JSON.stringify(body).includes('sk-openai-test'), false)
  const deepseek = body.providers.find((provider) => provider.id === 'deepseek')
  assert.equal(deepseek.configured, false, 'a provider without a key is never reported as connected')
})

test('an OpenAI-compatible answer streams as normalized events', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const { status, contentType, events } = await collectChat(baseUrl, {
    provider: 'openai',
    messages: [{ role: 'user', content: 'oi' }],
  })
  assert.equal(status, 200)
  assert.match(contentType, /text\/event-stream/)
  assert.equal(events[0].type, 'start')
  assert.equal(events[0].provider, 'openai')
  const deltas = events.filter((event) => event.type === 'delta').map((event) => event.text).join('')
  assert.equal(deltas, 'Olá, mundo')
  const done = events.find((event) => event.type === 'done')
  assert.equal(done.text, 'Olá, mundo')
  assert.equal(events.some((event) => event.type === 'usage'), true)
})

test('the Anthropic and Gemini adapters stream the same event shape', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))

  const anthropic = await collectChat(baseUrl, { provider: 'anthropic', messages: [{ role: 'user', content: 'oi' }] })
  assert.equal(anthropic.events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'Olá da Anthropic')
  assert.equal(anthropic.events.some((event) => event.type === 'done'), true)
  const anthropicCall = fake.calls.at(-1)
  assert.equal(anthropicCall.headers['x-api-key'], 'an-test')
  assert.equal(anthropicCall.headers['anthropic-version'], '2023-06-01')

  const gemini = await collectChat(baseUrl, { provider: 'gemini', messages: [{ role: 'user', content: 'oi' }] })
  assert.equal(gemini.events.filter((event) => event.type === 'delta').map((event) => event.text).join(''), 'Olá do Gemini')
  const geminiCall = fake.calls.at(-1)
  assert.match(geminiCall.path, /:streamGenerateContent$/)
  assert.match(geminiCall.search, /alt=sse/)
  assert.match(geminiCall.search, /key=gm-test/)
})

test('a rejected credential is reported as auth_failed, and the key stays out of the message', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const { events, text } = await collectChat(baseUrl, { provider: 'openrouter', messages: [{ role: 'user', content: 'oi' }] })
  const error = events.find((event) => event.type === 'error')
  assert.equal(error.error.code, 'auth_failed')
  assert.equal(error.error.provider, 'openrouter')
  assert.equal(text.includes('or-test'), false)
})

test('an upstream 500 is classified as upstream_error', async () => {
  const fake = await startFakeProvider()
  const config = baseConfig(fake)
  config.providers.openrouter = { baseUrl: `${fake.url}/broken`, apiKey: 'or-test', models: ['or-model'], defaultModel: 'or-model' }
  const { baseUrl } = await startGateway(config)
  const { events } = await collectChat(baseUrl, { provider: 'openrouter', messages: [{ role: 'user', content: 'oi' }] })
  assert.equal(events.find((event) => event.type === 'error').error.code, 'upstream_error')
})

test('a provider that does not answer in time yields a timeout', async () => {
  const fake = await startFakeProvider()
  const config = baseConfig(fake, { timeoutMs: 200 })
  const { baseUrl } = await startGateway(config)
  const { events } = await collectChat(baseUrl, { provider: 'ollama', messages: [{ role: 'user', content: 'oi' }] })
  assert.equal(events.find((event) => event.type === 'error').error.code, 'timeout')
})

test('a running answer can be cancelled', async () => {
  const fake = await startFakeProvider()
  const config = baseConfig(fake, { timeoutMs: 10_000 })
  config.providers.openai = { baseUrl: `${fake.url}/stall`, apiKey: 'sk-openai-test', models: ['gpt-test'], defaultModel: 'gpt-test' }
  const { baseUrl } = await startGateway(config)

  const requestId = 'req-cancel-1'
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'openai', requestId, messages: [{ role: 'user', content: 'oi' }] }),
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  // Wait for the first delta, then cancel from the outside
  while (!seen.includes('"type":"delta"')) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value, { stream: true })
  }
  const cancel = await fetch(`${baseUrl}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ requestId }),
  })
  assert.equal(cancel.status, 200)
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    seen += decoder.decode(value, { stream: true })
  }
  assert.match(seen, /"type":"cancelled"/)
})

test('a cancellation for an unknown request is refused', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ requestId: 'nope' }),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'bad_request')
})

test('a request that cannot be routed is refused before any stream starts', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'nope', messages: [{ role: 'user', content: 'oi' }] }),
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, 'unknown_provider')
})

test('a message without content is refused before any stream starts', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'openai', messages: [{ role: 'user', content: '  ' }] }),
  })
  assert.equal(response.status, 400)
  assert.equal((await response.json()).error.code, 'bad_request')
})

test('the connection test performs a real request and reports latency', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'openai-compatible' }),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true)
  assert.equal(body.sample, 'pong')
  assert.equal(typeof body.latencyMs, 'number')
  assert.equal(JSON.stringify(body).includes('compat-test'), false)
})

test('a malformed body is bad_request, an unknown route is not_found', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const badJson = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: '{not json',
  })
  assert.equal(badJson.status, 400)

  const unknownRoute = await fetch(`${baseUrl}/nope`, { headers: authorized() })
  // Rota errada não é corpo malformado: 404 com código próprio, para o cliente saber o que corrigir.
  assert.equal(unknownRoute.status, 404)
  assert.equal((await unknownRoute.json()).error.code, 'not_found')
})

test('an origin that is not the extension or localhost is refused', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/providers`, {
    headers: authorized({ origin: 'https://evil.example' }),
  })
  assert.equal(response.status, 403)
})

test('the rate limit answers 429 with a retry delay', async () => {
  const fake = await startFakeProvider()
  const config = baseConfig(fake, { rateLimit: { capacity: 1, refillPerSecond: 0.01 } })
  const { baseUrl } = await startGateway(config)
  const first = await fetch(`${baseUrl}/providers`, { headers: authorized() })
  assert.equal(first.status, 200)
  const second = await fetch(`${baseUrl}/providers`, { headers: authorized() })
  assert.equal(second.status, 429)
  assert.equal((await second.json()).error.code, 'rate_limited')
  assert.ok(Number(second.headers.get('retry-after')) >= 1)
})

test('the gateway refuses to start without a token', () => {
  assert.throws(() => createGateway({ config: { authToken: '', providers: {} }, env: {} }), /token/)
})

test('the provider diagnosis reports credential, auth, streaming and cancel', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'openai' }),
  })
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.equal(body.ok, true, JSON.stringify(body.checks))
  const names = body.checks.map((check) => check.name)
  assert.deepEqual(names, ['credential', 'auth', 'streaming', 'cancel'])
  assert.ok(body.checks.every((check) => check.ok === true))
})

test('the diagnosis stops at the credential when the provider is not configured', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'deepseek' }),
  })
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.equal(body.checks.length, 1)
  assert.equal(body.checks[0].name, 'credential')
  assert.match(body.checks[0].detail, /DEEPSEEK_API_KEY/)
})

test('a rejected credential fails the auth step and stops the diagnosis', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'openrouter' }),
  })
  const body = await response.json()
  assert.equal(body.ok, false)
  assert.deepEqual(body.checks.map((check) => check.name), ['credential', 'auth'])
  assert.equal(body.checks[1].ok, false)
  assert.match(body.checks[1].detail, /auth_failed/)
  assert.equal(JSON.stringify(body).includes('or-test'), false, 'the key never appears in a diagnosis')
})
test('a credential placed in a local env file configures the provider and never leaks', async () => {
  const fake = await startFakeProvider()
  const config = baseConfig(fake)
  config.providers.deepseek = { baseUrl: `${fake.url}/openai`, models: ['deepseek-chat'], defaultModel: 'deepseek-chat' }
  const envFile = parseEnvFile([
    '# C:\\Users\\lmpra\\.dz23\\providers.env',
    'export DEEPSEEK_API_KEY="sk-from-the-local-file"',
  ].join('\n'))
  const { baseUrl } = await startGateway(config, envFile)

  const list = await (await fetch(`${baseUrl}/providers`, { headers: authorized() })).json()
  const deepseek = list.providers.find((provider) => provider.id === 'deepseek')
  assert.equal(deepseek.configured, true, 'the key from the file is picked up')
  assert.equal(JSON.stringify(list).includes('sk-from-the-local-file'), false)

  const diagnosis = await (await fetch(`${baseUrl}/diagnose`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'deepseek' }),
  })).json()
  assert.equal(diagnosis.checks[0].ok, true, 'credential step passes from the file')
  assert.equal(diagnosis.checks[1].ok, true, 'auth reaches the fake provider')
  assert.equal(JSON.stringify(diagnosis).includes('sk-from-the-local-file'), false)
})
// --- origin policy ------------------------------------------------------------------------------------------
// The gateway must accept the authorised extension and nothing else: no prefix match, no wildcard.

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

test('CORS: the exact extension origin is accepted, another extension is refused', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway({ ...baseConfig(fake), allowedOrigins: [EXT_ORIGIN] })
  const allowed = await fetch(`${baseUrl}/health`, { headers: { origin: EXT_ORIGIN } })
  assert.equal(allowed.status, 200)
  const other = await fetch(`${baseUrl}/health`, { headers: { origin: 'chrome-extension://otheridotheridotheridotherid' } })
  assert.equal(other.status, 403)
  assert.equal((await other.json()).error.message, 'this origin is not allowed')
})

test('CORS: an external origin and a malformed origin are refused', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway({ ...baseConfig(fake), allowedOrigins: [EXT_ORIGIN] })
  for (const origin of ['https://evil.example', 'chrome-extension://', 'not a url', 'http://127.0.0.1:3000']) {
    const response = await fetch(`${baseUrl}/health`, { headers: { origin } })
    assert.equal(response.status, 403, `${origin} should be refused`)
  }
})

test('CORS: localhost is refused in production and accepted in development', async () => {
  const fake = await startFakeProvider()
  const production = await startGateway({ ...baseConfig(fake), allowedOrigins: [EXT_ORIGIN], dev: false })
  assert.equal((await fetch(`${production.baseUrl}/health`, { headers: { origin: 'http://127.0.0.1:5173' } })).status, 403)
  const development = await startGateway({ ...baseConfig(fake), dev: true })
  assert.equal((await fetch(`${development.baseUrl}/health`, { headers: { origin: 'http://127.0.0.1:5173' } })).status, 200)
  assert.equal((await fetch(`${development.baseUrl}/health`, { headers: { origin: 'http://localhost' } })).status, 200)
})

test('CORS: without a list and without dev mode, every browser origin is refused', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  assert.equal((await fetch(`${baseUrl}/health`, { headers: { origin: EXT_ORIGIN } })).status, 403)
  assert.equal((await fetch(`${baseUrl}/health`, { headers: { origin: 'http://127.0.0.1:9' } })).status, 403)
  // a request with no Origin header is a local tool, not a browser: allowed, as before
  assert.equal((await fetch(`${baseUrl}/health`)).status, 200)
})

test('CORS: an allowed origin still needs the bearer token on protected routes', async () => {
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway({ ...baseConfig(fake), allowedOrigins: [EXT_ORIGIN] })
  const anonymous = await fetch(`${baseUrl}/providers`, { headers: { origin: EXT_ORIGIN } })
  assert.equal(anonymous.status, 401)
  const wrong = await fetch(`${baseUrl}/providers`, { headers: { origin: EXT_ORIGIN, authorization: 'Bearer nope' } })
  assert.equal(wrong.status, 401)
  const allowed = await fetch(`${baseUrl}/providers`, { headers: { origin: EXT_ORIGIN, ...authorized() } })
  assert.equal(allowed.status, 200)
  const chat = await fetch(`${baseUrl}/chat`, { method: 'POST', headers: { origin: EXT_ORIGIN, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(chat.status, 401)
})

test('GET /token pairs in development and is absent in production', async () => {
  const base = {
    authToken: 'test-token',
    timeoutMs: 5000,
    rateLimit: { capacity: 50, refillPerSecond: 10 },
    providers: {},
    allowedOrigins: null,
  }
  const dev = createGateway({ config: { ...base, dev: true }, env: {} })
  await dev.listen(0)
  const devPort = dev.server.address().port
  try {
    const paired = await fetch(`http://127.0.0.1:${devPort}/token`)
    assert.equal(paired.status, 200)
    const body = await paired.json()
    assert.equal(body.dev, true)
    assert.equal(body.token, 'test-token')
  } finally {
    await dev.close()
  }

  const production = createGateway({ config: { ...base, dev: false, allowedOrigins: ['chrome-extension://abcdefghijklmnop'] }, env: {} })
  await production.listen(0)
  const productionPort = production.server.address().port
  try {
    const refused = await fetch(`http://127.0.0.1:${productionPort}/token`, { headers: { origin: 'chrome-extension://abcdefghijklmnop' } })
    assert.equal(refused.status, 404)
    assert.match((await refused.json()).error.message, /development/)
  } finally {
    await production.close()
  }
})


test('origem de extensão estranha é recusada mesmo em desenvolvimento', async () => {
  const fake = await startFakeProvider()
  const dev = await startGateway({ ...baseConfig(fake), dev: true, extensionId: 'ejmflepgfmffgicdjdaigdfdcacehgma' })
  const known = await fetch(`${dev.baseUrl}/health`, { headers: { origin: 'chrome-extension://ejmflepgfmffgicdjdaigdfdcacehgma' } })
  assert.equal(known.status, 200, 'a extensão do produto entra')

  const foreign = await fetch(`${dev.baseUrl}/health`, { headers: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })
  assert.equal(foreign.status, 403, 'outra extensão instalada não entra, nem em dev')

  const token = await fetch(`${dev.baseUrl}/token`, { headers: { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } })
  assert.equal(token.status, 403, 'e não consegue parear')
})

test('em desenvolvimento o localhost continua aceito (UI servida por http)', async () => {
  const fake = await startFakeProvider()
  const dev = await startGateway({ ...baseConfig(fake), dev: true })
  for (const origin of ['http://127.0.0.1:1234', 'http://localhost:5000']) {
    const response = await fetch(`${dev.baseUrl}/health`, { headers: { origin } })
    assert.equal(response.status, 200, origin)
  }
  const external = await fetch(`${dev.baseUrl}/health`, { headers: { origin: 'https://exemplo.com' } })
  assert.equal(external.status, 403)
})

test('arquivo de provedores ausente dá erro claro, não ENOENT cru', async () => {
  // Antes o servidor chamava readFileSync direto: o usuário via "ENOENT", sem saber qual variável configurar.
  const { loadProviderEnv } = await import('./core.mjs')
  assert.throws(
    () => loadProviderEnv(join(tmpdir(), 'nao-existe-providers.env'), (path) => readFileSync(path, 'utf8')),
    (error) => error.code === 'bad_request' && /could not read DZ23_PROVIDER_ENV/.test(error.message),
  )
})

test('arquivo de provedores válido entrega as chaves', async () => {
  const { loadProviderEnv } = await import('./core.mjs')
  const dir = mkdtempSync(join(tmpdir(), 'dz23-providers-'))
  const path = join(dir, 'providers.env')
  writeFileSync(path, 'DEEPSEEK_API_KEY=sk-local\n# nota\n')
  const loaded = loadProviderEnv(path, (file) => readFileSync(file, 'utf8'))
  assert.deepEqual(Object.keys(loaded), ['DEEPSEEK_API_KEY'])
  rmSync(dir, { recursive: true, force: true })
})

test('/chat recusa stream:false com mensagem clara (não ignora o parâmetro)', async () => {
  // Descoberto por um smoke real: o cliente pedia JSON, recebia SSE e ficava sem texto, sem erro nenhum.
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: authorized(),
    body: JSON.stringify({ provider: 'openai', stream: false, messages: [{ role: 'user', content: 'oi' }] }),
  })
  assert.equal(response.status, 400)
  const body = await response.json()
  assert.equal(body.error.code, 'bad_request')
  assert.match(String(body.error.message), /always streams/)
})

test('papel de mensagem fora do contrato é recusado, não coagido a "user"', async () => {
  // Achado por sonda de API: `role: "hacker"` virava `user` em silêncio — o chamador tinha a intenção reescrita.
  const fake = await startFakeProvider()
  const { baseUrl } = await startGateway(baseConfig(fake))
  for (const role of ['hacker', 'tool', undefined]) {
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: authorized(),
      body: JSON.stringify({ provider: 'openai', messages: [{ role, content: 'oi' }] }),
    })
    assert.equal(response.status, 400, `role ${String(role)} deveria ser recusado`)
    const body = await response.json()
    assert.equal(body.error.code, 'bad_request')
    assert.match(String(body.error.message), /role must be one of/)
  }
})

test('requestId já em uso é recusado, não aceito em silêncio', async () => {
  // Antes: dois pedidos com o mesmo id coexistiam e o /cancel abortava só o segundo — o primeiro ficava órfão,
  // sem meio de cancelar. Recusar o duplicado é a proteção contra replay do §3.5.
  // O provedor /stall segura o stream aberto, então o primeiro pedido continua registrado: nada de corrida.
  const fake = await startFakeProvider()
  const config = baseConfig(fake, { timeoutMs: 10_000 })
  config.providers.openai = { baseUrl: `${fake.url}/stall`, apiKey: 'sk-openai-test', models: ['gpt-test'], defaultModel: 'gpt-test' }
  const { baseUrl } = await startGateway(config)

  const chat = (requestId) => fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ provider: 'openai', requestId, messages: [{ role: 'user', content: 'oi' }] }),
  })

  const first = chat('id-repetido')
  await sleep(150)                       // o primeiro já está registrado e transmitindo
  const second = await chat('id-repetido')

  assert.equal(second.status, 400, 'o duplicado precisa ser recusado enquanto o primeiro roda')
  const json = await second.json()
  assert.equal(json.error.code, 'bad_request')
  assert.match(String(json.error.message), /already running/)

  // e o primeiro continua cancelável pelo id — é o que protege contra órfão
  const cancel = await fetch(`${baseUrl}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authorized() },
    body: JSON.stringify({ requestId: 'id-repetido' }),
  })
  assert.equal(cancel.status, 200)
  assert.equal((await cancel.json()).cancelled, 'id-repetido')
  await first.catch(() => null)
})

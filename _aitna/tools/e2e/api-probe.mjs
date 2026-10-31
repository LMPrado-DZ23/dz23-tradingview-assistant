#!/usr/bin/env node
// API contract probe: what a careless client gets when it sends the wrong thing.
//
// Two real defects came out of ad-hoc versions of this probe — `/chat` ignored `stream: false` and answered SSE, and an
// invalid message role was silently coerced to `user`. Both were invisible to 600 mock-based tests, because a mock honours
// the parameter you send it. This file keeps the probe permanent: every route, every malformed shape, the expected status
// code asserted instead of eyeballed.
//
// It starts its own fake upstream, so it needs no provider, no key and no network.
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PORT = Number(process.env.DZ23_PROBE_PORT ?? 8793)
const TOKEN = 'probe-token-0123456789'

// Upstream falso: responde SSE no caminho bom e 500 no caminho quebrado.
const upstream = createServer((request, response) => {
  if (request.url.startsWith('/quebrado')) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end('boom')
    return
  }
  if (!request.url.startsWith('/ok')) {
    response.writeHead(404).end('no')
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n')
  response.end('data: [DONE]\n\n')
})
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`

const work = mkdtempSync(join(tmpdir(), 'dz23-probe-'))
const configPath = join(work, 'gateway.json')
writeFileSync(configPath, JSON.stringify({
  port: PORT,
  authToken: TOKEN,
  timeoutMs: 5000,
  rateLimit: { capacity: 200, refillPerSecond: 50 },
  providers: {
    openai: { baseUrl: `${upstreamUrl}/ok/`, apiKey: 'sk-probe-0123456789abcdef', models: ['probe-model'], defaultModel: 'probe-model' },
    'openai-compatible': { baseUrl: `${upstreamUrl}/ok/`, apiKey: 'sk-probe-0123456789abcdef', models: ['probe-model'], defaultModel: 'probe-model' },
    gemini: { baseUrl: `${upstreamUrl}/quebrado/`, apiKey: 'AIza-probe-0123456789abcdefghij', models: ['probe-model'], defaultModel: 'probe-model' },
  },
}))

const gateway = join(ROOT, 'gateway/server.mjs')
const child = execFile(process.execPath, [gateway], {
  env: { ...process.env, DZ23_GATEWAY_CONFIG: configPath, DZ23_GATEWAY_TOKEN: TOKEN, DZ23_GATEWAY_PORT: String(PORT), DZ23_GATEWAY_DEV: '' },
})
let log = ''
child.stdout?.on('data', (chunk) => { log += chunk })
child.stderr?.on('data', (chunk) => { log += chunk })

const cleanup = () => {
  try { child.kill() } catch { /* já morreu */ }
  try { upstream.close() } catch { /* já fechou */ }
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let up = false
for (let attempt = 0; attempt < 60 && !up; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(800) })
    up = response.ok
  } catch {
    await sleep(100)
  }
}
if (!up) {
  console.log(JSON.stringify({ passed: false, error: 'gateway não subiu', log: log.slice(-200) }))
  process.exit(1)
}

const call = async (path, { method = 'POST', body, headers = {} } = {}) => {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch { /* SSE ou texto puro */ }
  return { status: response.status, text, json }
}

const message = [{ role: 'user', content: 'oi' }]
const cases = [
  // rota ausente / método errado
  { name: 'rota inexistente', path: '/nada', method: 'GET', expect: 404 },
  { name: 'GET em /chat', path: '/chat', method: 'GET', expect: 404 },
  // corpo inválido de /chat
  { name: 'corpo vazio', path: '/chat', body: {}, expect: 400, code: 'bad_request' },
  { name: 'provedor desconhecido', path: '/chat', body: { provider: 'nao-existe', messages: message }, expect: 400, code: 'unknown_provider' },
  { name: 'sem mensagens', path: '/chat', body: { provider: 'openai' }, expect: 400, code: 'bad_request' },
  { name: 'mensagens vazias', path: '/chat', body: { provider: 'openai', messages: [] }, expect: 400, code: 'bad_request' },
  { name: 'mensagens não-array', path: '/chat', body: { provider: 'openai', messages: 'texto' }, expect: 400, code: 'bad_request' },
  { name: 'conteúdo vazio', path: '/chat', body: { provider: 'openai', messages: [{ role: 'user', content: ' ' }] }, expect: 400, code: 'bad_request' },
  { name: 'papel inválido', path: '/chat', body: { provider: 'openai', messages: [{ role: 'hacker', content: 'oi' }] }, expect: 400, code: 'bad_request' },
  { name: 'papel ausente', path: '/chat', body: { provider: 'openai', messages: [{ content: 'oi' }] }, expect: 400, code: 'bad_request' },
  { name: 'modelo indisponível', path: '/chat', body: { provider: 'openai', model: 'nao-existe', messages: message }, expect: 400, code: 'model_not_available' },
  { name: 'stream:false é recusado (rota é SSE)', path: '/chat', body: { provider: 'openai', stream: false, messages: message }, expect: 400, code: 'bad_request' },
  // cancelamento
  { name: 'cancel sem requestId', path: '/cancel', body: {}, expect: 400, code: 'bad_request' },
  { name: 'cancel com id desconhecido', path: '/cancel', body: { requestId: 'nao-existe' }, expect: 400, code: 'bad_request' },
  // teste de conexão e diagnóstico
  { name: 'test sem provedor', path: '/test', body: {}, expect: 400 },
  { name: 'test provedor desconhecido', path: '/test', body: { provider: 'nao-existe' }, expect: 400, code: 'unknown_provider' },
  { name: 'diagnose sem provedor', path: '/diagnose', body: {}, expect: 400 },
  // autenticação
  { name: 'sem token', path: '/providers', method: 'GET', expect: 401, omitAuth: true },
  { name: 'token errado', path: '/providers', method: 'GET', expect: 401, badToken: true },
  // origens
  { name: 'origem estranha é recusada', path: '/providers', method: 'GET', expect: 403, origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/' },
  // rotas públicas
  { name: 'health sem token', path: '/health', method: 'GET', expect: 200, omitAuth: true },
]

const results = []
for (const testCase of cases) {
  const headers = {}
  if (testCase.omitAuth)
    delete headers.authorization
  if (testCase.badToken)
    headers.authorization = 'Bearer token-errado'
  if (testCase.origin)
    headers.origin = testCase.origin
  const options = { method: testCase.method ?? 'POST', headers }
  if (testCase.omitAuth)
    options.headers.authorization = undefined
  const response = await fetch(`http://127.0.0.1:${PORT}${testCase.path}`, {
    method: testCase.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(testCase.omitAuth ? {} : { authorization: testCase.badToken ? 'Bearer token-errado' : `Bearer ${TOKEN}` }),
      ...(testCase.origin ? { origin: testCase.origin } : {}),
    },
    body: testCase.method === 'GET' ? undefined : JSON.stringify(testCase.body ?? {}),
  }).catch((error) => ({ status: 0, text: async () => String(error.message), json: async () => null }))
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch { /* não é JSON */ }
  const problems = []
  if (response.status !== testCase.expect)
    problems.push(`status ${response.status}, esperado ${testCase.expect}`)
  if (testCase.code && json?.error?.code !== testCase.code)
    problems.push(`código ${JSON.stringify(json?.error?.code ?? null)}, esperado ${testCase.code}`)
  if (!testCase.code && json?.error && !json.error.message)
    problems.push('erro sem mensagem')
  results.push({ name: testCase.name, status: response.status, problems })
}

const width = Math.max(...results.map((item) => item.name.length))
for (const item of results)
  console.log(`${item.problems.length ? 'FAIL' : 'ok  '}  ${String(item.status).padEnd(3)}  ${item.name.padEnd(width)}${item.problems.length ? `  ← ${item.problems.join('; ')}` : ''}`)

const failures = results.filter((item) => item.problems.length)
console.log(JSON.stringify({ passed: failures.length === 0, cases: results.length, failures: failures.map((item) => item.name) }))
process.exit(failures.length === 0 ? 0 : 1)

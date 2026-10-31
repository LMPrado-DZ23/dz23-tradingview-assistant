import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { POLICY, callGated, createClient, createRegistry, authorize } from './core.mjs'

// The MCP client is a security boundary: registration, isolation, per-tool policy, confirmation and audit are
// each pinned here against a fake JSON-RPC server.

const servers = []
after(() => { for (const server of servers) server.close() })

async function startMcp ({ token = 'mcp-token', delayMs = 0 } = {}) {
  const calls = []
  const server = createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    calls.push({ id: body.id, method: body.method, params: body.params, authorization: request.headers.authorization })
    if (token && request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: 'unauthorized' } }))
      return
    }
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
    const reply = (result) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
    }
    if (body.method === 'initialize')
      return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } })
    if (body.method === 'tools/list')
      return reply({ tools: [{ name: 'quote', description: 'price' }, { name: 'order', description: 'places an order' }] })
    if (body.method === 'tools/call') {
      if (body.params?.name === 'boom') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such tool' } }))
        return
      }
      return reply({ content: [{ type: 'text', text: `${body.params.name}:ok` }] })
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'method not found' } }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  return { url: `http://127.0.0.1:${server.address().port}`, calls }
}

function registryFor (url, overrides = {}) {
  return createRegistry([{
    name: 'local',
    url,
    token: 'mcp-token',
    allowedTools: ['quote', 'order'],
    policies: { quote: POLICY.allow, order: POLICY.ask },
    ...overrides,
  }])
}

test('registration refuses a server without a name, a url or an explicit tool list', () => {
  assert.throws(() => createRegistry([{ url: 'http://x' }]), /name/)
  assert.throws(() => createRegistry([{ name: 'a', url: 'not a url', allowedTools: ['x'] }]), /valid url/)
  assert.throws(() => createRegistry([{ name: 'a', url: 'ftp://x', allowedTools: ['x'] }]), /http/)
  assert.throws(() => createRegistry([{ name: 'a', url: 'http://x' }]), /allows no tools/)
  assert.throws(() => createRegistry([{ name: 'a', url: 'http://x', allowedTools: ['y'] }, { name: 'a', url: 'http://y', allowedTools: ['y'] }]), /duplicated/)
})

test('the registry describes servers without revealing the token', () => {
  const registry = registryFor('http://127.0.0.1:1')
  const described = registry.describe()
  assert.equal(described[0].tokenConfigured, true)
  assert.equal(JSON.stringify(described).includes('mcp-token'), false)
  assert.deepEqual(described[0].tools, [{ name: 'quote', policy: 'allow' }, { name: 'order', policy: 'ask' }])
})

test('the policy refuses a tool outside the list and asks for the ones marked ask', () => {
  const registry = registryFor('http://127.0.0.1:1')
  const server = registry.get('local')
  assert.equal(authorize(server, 'quote').decision, 'allow')
  assert.equal(authorize(server, 'order').decision, 'ask')
  assert.equal(authorize(server, 'shell').decision, 'deny')
})

test('initialize and tools/list talk JSON-RPC to the server', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url)
  const client = createClient(registry.get('local'))
  const init = await client.initialize()
  assert.equal(init.protocolVersion, '2024-11-05')
  const tools = await client.listTools()
  assert.deepEqual(tools.map((tool) => tool.name), ['quote', 'order'])
  assert.equal(mcp.calls[0].method, 'initialize')
  assert.equal(mcp.calls[0].authorization, 'Bearer mcp-token')
})

test('an allowed tool runs and its result is returned', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url)
  const result = await callGated(registry, { server: 'local', tool: 'quote', arguments: { symbol: 'BTCUSDT' } })
  assert.equal(result.ok, true)
  assert.equal(result.result.content[0].text, 'quote:ok')
})

test('a tool marked ask does not reach the network without confirmation', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url)
  const result = await callGated(registry, { server: 'local', tool: 'order', arguments: { side: 'buy' } })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'confirmation_required')
  assert.equal(mcp.calls.length, 0, 'nothing left the process')
  const confirmed = await callGated(registry, { server: 'local', tool: 'order', arguments: { side: 'buy' }, confirmed: true })
  assert.equal(confirmed.ok, true)
  assert.equal(mcp.calls.length, 1)
})

test('a tool outside the allow list is denied before any request', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url)
  const result = await callGated(registry, { server: 'local', tool: 'shell', confirmed: true })
  assert.equal(result.code, 'tool_denied')
  assert.equal(mcp.calls.length, 0)
})

test('a JSON-RPC error becomes a typed failure, not a crash', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url, { allowedTools: ['boom'], policies: { boom: POLICY.allow } })
  const result = await callGated(registry, { server: 'local', tool: 'boom' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'rpc_error')
})

test('a rejected token is auth_failed', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url, { token: 'wrong-token' })
  const result = await callGated(registry, { server: 'local', tool: 'quote' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'auth_failed')
})

test('a slow server times out with its own code', async () => {
  const mcp = await startMcp({ delayMs: 300 })
  const registry = registryFor(mcp.url, { timeoutMs: 50 })
  const result = await callGated(registry, { server: 'local', tool: 'quote' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'timeout')
})

test('every decision is logged without the arguments', async () => {
  const mcp = await startMcp()
  const registry = registryFor(mcp.url)
  const entries = []
  await callGated(registry, { server: 'local', tool: 'quote', arguments: { secret: 'não-logar' } }, { log: (entry) => entries.push(entry) })
  await callGated(registry, { server: 'local', tool: 'order' }, { log: (entry) => entries.push(entry) })
  assert.ok(entries.some((entry) => entry.ok === true && entry.method === 'tools/call'))
  assert.ok(entries.some((entry) => entry.decision === 'ask' && entry.ok === false))
  assert.equal(JSON.stringify(entries).includes('não-logar'), false, 'arguments never reach the log')
})

test('an unknown server is a typed error', async () => {
  const registry = registryFor('http://127.0.0.1:1')
  assert.throws(() => registry.get('nope'), /unknown MCP server/)
  const result = await callGated(registry, { server: 'nope', tool: 'quote' }).catch((error) => ({ ok: false, code: error.code }))
  assert.equal(result.code, 'unknown_server')
})

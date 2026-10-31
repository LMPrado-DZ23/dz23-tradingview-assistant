// OAuth 2.1 + MCP client contract tests, against a fake authorization server and a fake MCP endpoint.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import {
  buildAuthorizeUrl, createPkce, describeTokens, discoverEndpoints, exchangeCode, isExpired, normalizeTokensForTest,
  randomState, refreshAccessToken, registerClient,
} from '../../../mcp/tradingview-oauth.mjs'
import { AuthRequired, McpError, createMcpClient, parseResponse, summarizeInitialize } from '../../../mcp/tradingview-client.mjs'

const metadata = {
  issuer: 'https://www.tradingview.com',
  authorization_endpoint: 'https://www.tradingview.com/mcp/oauth/authorize',
  token_endpoint: 'https://www.tradingview.com/mcp/oauth/token',
  registration_endpoint: 'https://www.tradingview.com/mcp/oauth/register',
  revocation_endpoint: 'https://www.tradingview.com/mcp/oauth/revoke',
  code_challenge_methods_supported: ['S256'],
  scopes_supported: ['mcp:read', 'mcp:tools'],
}

test('descobre endpoints e recusa metadados incompletos', () => {
  const endpoints = discoverEndpoints(metadata)
  assert.equal(endpoints.authorize, metadata.authorization_endpoint)
  assert.equal(endpoints.token, metadata.token_endpoint)
  assert.equal(endpoints.register, metadata.registration_endpoint)
  assert.deepEqual(endpoints.pkceMethods, ['S256'])
  assert.throws(() => discoverEndpoints({ authorization_endpoint: 'https://x' }), /token_endpoint/)
  assert.throws(() => discoverEndpoints({ authorization_endpoint: 'http://inseguro', token_endpoint: 'https://y' }), /authorization_endpoint/)
})

test('PKCE: verifier e challenge S256 no formato base64url', async () => {
  const pkce = await createPkce()
  assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/)
  assert.match(pkce.challenge, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(pkce.method, 'S256')
  const other = await createPkce()
  assert.notEqual(other.verifier, pkce.verifier, 'cada login gera um verifier novo')
  assert.match(randomState(), /^[A-Za-z0-9_-]{22}$/)
})

test('URL de autorização carrega os parâmetros exigidos', async () => {
  const pkce = await createPkce()
  const url = new URL(buildAuthorizeUrl({ endpoints: discoverEndpoints(metadata), clientId: 'cli-1', redirectUri: 'http://127.0.0.1:9999/callback', state: 'st', challenge: pkce.challenge }))
  assert.equal(url.searchParams.get('response_type'), 'code')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('code_challenge'), pkce.challenge)
  assert.equal(url.searchParams.get('resource'), 'https://mcp.tradingview.com/mcp')
  assert.equal(url.searchParams.get('scope'), 'mcp:read mcp:tools')
})

test('registro dinâmico manda cliente público e devolve client_id', async () => {
  const requests = []
  const fakeFetch = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 201, json: async () => ({ client_id: 'abc123', client_secret: undefined }) }
  }
  const result = await registerClient({ registerEndpoint: metadata.registration_endpoint, redirectUri: 'http://127.0.0.1:1/callback', fetchImpl: fakeFetch })
  assert.equal(result.clientId, 'abc123')
  assert.equal(requests[0].body.token_endpoint_auth_method, 'none')
  assert.deepEqual(requests[0].body.redirect_uris, ['http://127.0.0.1:1/callback'])
  assert.deepEqual(requests[0].body.grant_types, ['authorization_code', 'refresh_token'])
})

test('troca de código envia PKCE e normaliza o token', async () => {
  let seen = null
  const fakeFetch = async (url, options) => {
    seen = new URLSearchParams(options.body)
    return { ok: true, status: 200, json: async () => ({ access_token: 'tok', refresh_token: 'ref', token_type: 'Bearer', expires_in: 3600, scope: 'mcp:read mcp:tools' }) }
  }
  const tokens = await exchangeCode({ tokenEndpoint: metadata.token_endpoint, clientId: 'cli', code: 'code-1', verifier: 'verifier-1', redirectUri: 'http://127.0.0.1:1/callback', fetchImpl: fakeFetch })
  assert.equal(seen.get('grant_type'), 'authorization_code')
  assert.equal(seen.get('code_verifier'), 'verifier-1')
  assert.equal(seen.get('redirect_uri'), 'http://127.0.0.1:1/callback')
  assert.equal(tokens.accessToken, 'tok')
  assert.ok(tokens.expiresAt > Date.now())
  assert.equal(isExpired(tokens), false)
  assert.match(describeTokens(tokens), /escopos mcp:read mcp:tools/)
})

test('erro do servidor de token vira mensagem clara', async () => {
  const fakeFetch = async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant', error_description: 'code expired' }) })
  await assert.rejects(() => exchangeCode({ tokenEndpoint: metadata.token_endpoint, clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1/cb', fetchImpl: fakeFetch }), /code expired/)
})

test('renovação usa o refresh_token e trata ausência', async () => {
  let seen = null
  const fakeFetch = async (url, options) => {
    seen = new URLSearchParams(options.body)
    return { ok: true, status: 200, json: async () => ({ access_token: 'novo', expires_in: 60 }) }
  }
  const fresh = await refreshAccessToken({ tokenEndpoint: metadata.token_endpoint, clientId: 'c', refreshToken: 'ref', fetchImpl: fakeFetch })
  assert.equal(seen.get('grant_type'), 'refresh_token')
  assert.equal(fresh.accessToken, 'novo')
  assert.equal(fresh.refreshToken, null, 'sem refresh novo, mantém o anterior fora desta função')
  await assert.rejects(() => refreshAccessToken({ tokenEndpoint: 'https://x', clientId: 'c', refreshToken: null, fetchImpl: fakeFetch }), /refresh_token/)
})

test('isExpired aplica margem de segurança', () => {
  const now = 1_700_000_000_000
  assert.equal(isExpired({ accessToken: 't', expiresAt: now + 30_000 }, 60_000, () => now), true)
  assert.equal(isExpired({ accessToken: 't', expiresAt: now + 120_000 }, 60_000, () => now), false)
  assert.equal(isExpired({ accessToken: 't', expiresAt: null }, 60_000, () => now), false)
  assert.equal(isExpired({}, 60_000, () => now), true)
})

test('parseResponse aceita JSON e SSE', () => {
  assert.deepEqual(parseResponse('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}').result, { ok: true })
  const sse = 'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n'
  assert.deepEqual(parseResponse(sse, 'text/event-stream').result, { tools: [] })
  assert.throws(() => parseResponse('não é json'), /JSON/)
  assert.throws(() => parseResponse('data: {quebrado}\n\n', 'text/event-stream'), /SSE/)
})

test('cliente: initialize, tools/list e tools/call', async () => {
  const calls = []
  const fakeFetch = async (url, options) => {
    const body = JSON.parse(options.body)
    calls.push(body)
    const responses = {
      initialize: { protocolVersion: '2025-06-18', serverInfo: { name: 'tv-mcp', version: '1.2.3' }, capabilities: { tools: {} } },
      'notifications/initialized': {},
      'tools/list': { tools: [{ name: 'market_data', description: 'candles' }, { name: 'screener' }] },
      'tools/call': { content: [{ type: 'text', text: 'ok' }] },
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: responses[body.method] }) }
  }
  const client = createMcpClient({ getToken: () => 'tok', fetchImpl: fakeFetch })
  const init = await client.initialize()
  assert.match(summarizeInitialize(init), /tv-mcp 1\.2\.3/)
  const tools = await client.listTools()
  assert.deepEqual(tools.tools.map((tool) => tool.name), ['market_data', 'screener'])
  const called = await client.callTool('market_data', { symbol: 'BTCUSDT' })
  assert.equal(called.content[0].text, 'ok')
  assert.equal(calls.find((call) => call.method === 'tools/call').params.arguments.symbol, 'BTCUSDT')
})

test('cliente: 401 vira AuthRequired com resource_metadata, sem retry', async () => {
  let attempts = 0
  const fakeFetch = async () => {
    attempts += 1
    return { ok: false, status: 401, headers: { get: () => 'Bearer resource_metadata="https://mcp.tradingview.com/.well-known/oauth-protected-resource/mcp"' } }
  }
  const client = createMcpClient({ getToken: () => 'tok', fetchImpl: fakeFetch })
  await assert.rejects(() => client.listTools(), (error) => {
    assert.ok(error instanceof AuthRequired)
    assert.match(error.resourceMetadata, /oauth-protected-resource/)
    return true
  })
  assert.equal(attempts, 1, 'não repete um 401')
})

test('cliente: erro JSON-RPC e erro HTTP são distintos', async () => {
  const rpcError = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'invalid params' } }) })
  await assert.rejects(() => createMcpClient({ getToken: () => 't', fetchImpl: rpcError }).listTools(), (error) => error instanceof McpError && error.code === -32602)
  const httpError = async () => ({ ok: false, status: 500, headers: { get: () => 'application/json' }, text: async () => 'boom' })
  await assert.rejects(() => createMcpClient({ getToken: () => 't', fetchImpl: httpError }).listTools(), (error) => error instanceof McpError && error.status === 500)
})

test('cliente: sem token não chama a rede', async () => {
  let called = false
  const fakeFetch = async () => { called = true }
  await assert.rejects(() => createMcpClient({ getToken: () => null, fetchImpl: fakeFetch }).listTools(), (error) => error instanceof AuthRequired)
  assert.equal(called, false)
})

test('cliente: falha de transporte tenta uma vez e reporta', async () => {
  let attempts = 0
  const fakeFetch = async () => {
    attempts += 1
    throw new Error('ECONNRESET')
  }
  const client = createMcpClient({ getToken: () => 't', fetchImpl: fakeFetch, retries: 1 })
  await assert.rejects(() => client.ping(), /transporte/)
  assert.equal(attempts, 2)
})

test('cliente fala com um servidor HTTP de verdade (JSON e SSE)', async () => {
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += chunk })
    request.on('end', () => {
      const body = JSON.parse(raw)
      if (body.method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'real' }] } })}\n\n`)
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { ok: true } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/mcp`
  try {
    const client = createMcpClient({ url, getToken: () => 'tok' })
    assert.deepEqual(await client.listTools(), { tools: [{ name: 'real' }] })
    assert.deepEqual(await client.ping(), { ok: true })
  } finally {
    server.close()
  }
})

test('normalizeTokensForTest expõe a normalização para inspeção', () => {
  const tokens = normalizeTokensForTest({ access_token: 'a', expires_in: 10 })
  assert.equal(tokens.accessToken, 'a')
  assert.equal(tokens.refreshToken, null)
  assert.ok(tokens.expiresAt > Date.now())
})

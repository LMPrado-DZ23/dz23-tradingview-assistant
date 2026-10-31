// TradingView MCP client: JSON-RPC over HTTP with a bearer token.
//
// Behaviour that matters for honesty:
//  - a 401 is not retried blindly: it raises `AuthRequired` with the resource_metadata URL, so the caller can re-run
//    the OAuth flow instead of hammering the endpoint;
//  - the response may be JSON or an SSE stream (`text/event-stream`); both are parsed, and the JSON-RPC envelope is
//    validated;
//  - every request has a timeout and a bounded retry for transport errors only (not for 4xx).

export class AuthRequired extends Error {
  constructor (message, { resourceMetadata = null } = {}) {
    super(message)
    this.name = 'AuthRequired'
    this.code = 'auth_required'
    this.resourceMetadata = resourceMetadata
  }
}

export class McpError extends Error {
  constructor (message, { code = null, status = null, data = null } = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.status = status
    this.data = data
  }
}

// Parses either a plain JSON body or an SSE body, returning the JSON-RPC message.
export function parseResponse (text, contentType = '') {
  const raw = String(text ?? '').trim()
  if (!raw)
    throw new McpError('resposta vazia')
  if (String(contentType).includes('text/event-stream') || raw.startsWith('event:') || raw.startsWith('data:')) {
    const messages = []
    for (const block of raw.split(/\n\n+/)) {
      const dataLines = block.split('\n').filter((line) => line.startsWith('data:'))
      if (!dataLines.length)
        continue
      const payload = dataLines.map((line) => line.slice(5).trim()).join('\n')
      try {
        messages.push(JSON.parse(payload))
      } catch {
        /* ignora frames que não são JSON */
      }
    }
    const response = messages.find((message) => message && (message.result || message.error || message.jsonrpc))
    if (!response)
      throw new McpError('SSE sem mensagem JSON-RPC')
    return response
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new McpError('resposta não é JSON', { data: raw.slice(0, 200) })
  }
}

export function createMcpClient ({
  url = 'https://mcp.tradingview.com/mcp',
  getToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
  retries = 1,
  now = () => Date.now(),
} = {}) {
  let nextId = 1

  async function request (method, params = {}, { notification = false } = {}) {
    const token = typeof getToken === 'function' ? await getToken() : getToken
    if (!token)
      throw new AuthRequired('sem token: é preciso autorizar o MCP da TradingView')
    const id = notification ? undefined : nextId++
    const payload = { jsonrpc: '2.0', method, params }
    if (id !== undefined)
      payload.id = id
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2025-06-18',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (response.status === 401) {
          const header = response.headers?.get?.('www-authenticate') ?? ''
          const resourceMetadata = /resource_metadata="([^"]+)"/.exec(header)?.[1] ?? null
          throw new AuthRequired('token recusado pelo MCP da TradingView', { resourceMetadata })
        }
        if (response.status === 204 || notification)
          return { ok: true, status: response.status }
        const text = await response.text()
        const contentType = response.headers?.get?.('content-type') ?? ''
        if (!response.ok)
          throw new McpError(`HTTP ${response.status}`, { status: response.status, data: text.slice(0, 300) })
        const message = parseResponse(text, contentType)
        if (message.error)
          throw new McpError(message.error.message ?? 'erro JSON-RPC', { code: message.error.code, data: message.error.data })
        return message.result
      } catch (error) {
        lastError = error
        if (error instanceof AuthRequired || error instanceof McpError)
          throw error
        // transporte: uma nova tentativa, depois desiste com o motivo real
        if (attempt === retries)
          throw new McpError(`falha de transporte: ${error?.message ?? error}`, { data: { attempts: attempt + 1 } })
        await new Promise((resolve) => setTimeout(resolve, 300))
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError ?? new McpError('falha desconhecida')
  }

  return {
    request,
    async initialize (clientInfo = { name: 'dz23', version: '2.17.0' }) {
      const result = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo })
      await request('notifications/initialized', {}, { notification: true }).catch(() => {})
      return result
    },
    listTools: (cursor = undefined) => request('tools/list', cursor ? { cursor } : {}),
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args }),
    ping: () => request('ping', {}),
  }
}

export function summarizeInitialize (result) {
  if (!result)
    return 'sem resposta de initialize'
  const server = result.serverInfo ?? {}
  return `${server.name ?? 'servidor'} ${server.version ?? ''} · protocolo ${result.protocolVersion ?? '?'} · capacidades: ${Object.keys(result.capabilities ?? {}).join(', ') || 'nenhuma'}`
}

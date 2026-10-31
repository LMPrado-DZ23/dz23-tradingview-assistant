// DZ23 MCP — a small, explicit client for Model Context Protocol servers.
//
// The security model is the point here: every server is registered with its own URL, its own token and the exact
// tools it may run; each call is authorized before it leaves the process, a tool marked "ask" needs a human
// confirmation passed by the caller, and every decision is logged without arguments (they can carry secrets).
//
// Transport: JSON-RPC 2.0 over HTTP (the Streamable HTTP transport), one request per POST.

export const MCP_PROTOCOL_VERSION = '2024-11-05'
export const MCP_CLIENT = { name: 'dz23-copilot', version: '1.0.0' }

export const POLICY = { allow: 'allow', ask: 'ask', deny: 'deny' }

export class McpError extends Error {
  constructor (code, message, details = {}) {
    super(message)
    this.name = 'McpError'
    this.code = code
    this.server = details.server ?? null
  }
}

/**
 * A server registration: name, endpoint, token and the tools it is allowed to expose.
 * `policies` maps a tool name to allow / ask / deny; a tool absent from `allowedTools` is denied, never "maybe".
 */
export function createRegistry (servers = []) {
  const names = new Set()
  const entries = servers.map((server) => {
    if (!server?.name || typeof server.name !== 'string')
      throw new McpError('bad_registration', 'every MCP server needs a name')
    if (names.has(server.name))
      throw new McpError('bad_registration', `duplicated MCP server "${server.name}"`)
    names.add(server.name)
    let url
    try {
      url = new URL(server.url)
    } catch {
      throw new McpError('bad_registration', `MCP server "${server.name}" has no valid url`)
    }
    if (!['http:', 'https:'].includes(url.protocol))
      throw new McpError('bad_registration', `MCP server "${server.name}" must use http(s)`)
    const allowedTools = [...new Set(server.allowedTools ?? [])]
    if (!allowedTools.length)
      throw new McpError('bad_registration', `MCP server "${server.name}" allows no tools (isolation needs an explicit list)`)
    const policies = Object.fromEntries(allowedTools.map((tool) => [tool, server.policies?.[tool] ?? POLICY.ask]))
    return {
      name: server.name,
      url: url.toString(),
      token: server.token ?? '',
      tokenEnv: server.tokenEnv ?? null,
      allowedTools,
      policies,
      timeoutMs: Number(server.timeoutMs) > 0 ? Number(server.timeoutMs) : 10_000,
    }
  })
  return {
    servers: entries,
    get (name) {
      const server = entries.find((entry) => entry.name === name)
      if (!server)
        throw new McpError('unknown_server', `unknown MCP server "${name}"`)
      return server
    },
    // What a UI can show without revealing a token
    describe () {
      return entries.map((server) => ({
        name: server.name,
        url: server.url,
        tools: server.allowedTools.map((tool) => ({ name: tool, policy: server.policies[tool] })),
        tokenConfigured: Boolean(server.token || (server.tokenEnv && process.env[server.tokenEnv])),
      }))
    },
  }
}

export function authorize (server, tool) {
  if (!server.allowedTools.includes(tool))
    return { decision: POLICY.deny, reason: `"${tool}" is not in the tool list of "${server.name}"` }
  const policy = server.policies[tool] ?? POLICY.ask
  return { decision: policy, reason: policy === POLICY.ask ? `"${tool}" requires human confirmation` : `"${tool}" is allowed` }
}

export function createClient (server, { fetchImpl = fetch, log = () => {} } = {}) {
  const token = server.token || (server.tokenEnv ? process.env[server.tokenEnv] : '') || ''
  let nextId = 1

  async function rpc (method, params = {}) {
    const id = nextId++
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), server.timeoutMs)
    let response
    try {
      response = await fetchImpl(server.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      const timedOut = controller.signal.aborted
      log({ server: server.name, method, ms: Date.now() - startedAt, ok: false, code: timedOut ? 'timeout' : 'network_error' })
      throw new McpError(timedOut ? 'timeout' : 'network_error', timedOut ? 'the MCP server did not answer in time' : `could not reach the MCP server: ${error.message}`, { server: server.name })
    }
    clearTimeout(timer)
    if (!response.ok) {
      log({ server: server.name, method, ms: Date.now() - startedAt, ok: false, code: response.status === 401 ? 'auth_failed' : 'http_error' })
      throw new McpError(response.status === 401 ? 'auth_failed' : 'http_error', `MCP server "${server.name}" answered HTTP ${response.status}`, { server: server.name })
    }
    const payload = await response.json().catch(() => null)
    if (!payload || payload.jsonrpc !== '2.0')
      throw new McpError('invalid_response', 'the MCP server sent a payload that is not JSON-RPC 2.0', { server: server.name })
    if (payload.error)
      throw new McpError('rpc_error', `MCP error ${payload.error.code}: ${payload.error.message}`, { server: server.name })
    log({ server: server.name, method, ms: Date.now() - startedAt, ok: true })
    return payload.result
  }

  return {
    server,
    initialize: () => rpc('initialize', { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: MCP_CLIENT }),
    listTools: async () => (await rpc('tools/list', {})).tools ?? [],
    callTool: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    rpc,
  }
}

/**
 * One call, gated: the policy decides before any network access, and an "ask" tool only runs with an explicit
 * confirmation from the caller (a UI dialog, a CLI flag). The result never contains the token.
 */
export async function callGated (registry, { server: serverName, tool, arguments: args = {}, confirmed = false }, { log = () => {} } = {}) {
  const server = registry.get(serverName)
  const decision = authorize(server, tool)
  if (decision.decision === POLICY.deny) {
    log({ server: serverName, tool, decision: 'deny', ok: false })
    return { ok: false, code: 'tool_denied', reason: decision.reason }
  }
  if (decision.decision === POLICY.ask && !confirmed) {
    log({ server: serverName, tool, decision: 'ask', ok: false })
    return { ok: false, code: 'confirmation_required', reason: decision.reason }
  }
  try {
    const client = createClient(server, { log })
    const result = await client.callTool(tool, args)
    log({ server: serverName, tool, decision: decision.decision, ok: true })
    return { ok: true, result }
  } catch (error) {
    log({ server: serverName, tool, decision: decision.decision, ok: false, code: error.code })
    return { ok: false, code: error.code ?? 'error', reason: error.message }
  }
}

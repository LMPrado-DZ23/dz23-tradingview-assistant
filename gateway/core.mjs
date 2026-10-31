// DZ23 AI Gateway — provider-independent core.
//
// The wire format of a provider is the only place its name appears: everything else in the gateway and in the
// copilot speaks one normalized event stream (delta / usage / done / error) and one error vocabulary.
// This file has no I/O: it builds requests, parses streamed answers, routes a request and redacts secrets.

export const PROTOCOL_VERSION = 1

export const ERROR = {
  unauthorized: 'unauthorized',
  bad_request: 'bad_request',
  not_found: 'not_found',
  unknown_provider: 'unknown_provider',
  provider_not_configured: 'provider_not_configured',
  provider_disabled: 'provider_disabled',
  model_not_available: 'model_not_available',
  auth_failed: 'auth_failed',
  rate_limited: 'rate_limited',
  upstream_error: 'upstream_error',
  network_error: 'network_error',
  timeout: 'timeout',
  cancelled: 'cancelled',
  invalid_response: 'invalid_response',
}

// Providers the gateway knows how to talk to. A provider with `custom: true` has no default endpoint: the owner
// configures baseUrl and models, which is what "openai-compatible endpoint" means here.
export const PROVIDER_CATALOG = [
  {
    id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1',
    envKey: 'OPENAI_API_KEY', models: ['gpt-4o-mini', 'gpt-4o', 'o4-mini'], defaultModel: 'gpt-4o-mini',
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    id: 'deepseek', label: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    envKey: 'DEEPSEEK_API_KEY', models: ['deepseek-chat', 'deepseek-reasoner'], defaultModel: 'deepseek-chat',
    docs: 'https://api-docs.deepseek.com',
  },
  {
    id: 'anthropic', label: 'Anthropic Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',
    envKey: 'ANTHROPIC_API_KEY', models: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-sonnet-4-20250514', docs: 'https://docs.anthropic.com/en/api/messages',
  },
  {
    id: 'gemini', label: 'Google Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    envKey: 'GEMINI_API_KEY', models: ['gemini-2.0-flash', 'gemini-1.5-pro'], defaultModel: 'gemini-2.0-flash',
    docs: 'https://ai.google.dev/api/generate-content',
  },
  {
    id: 'ollama', label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    envKey: 'OLLAMA_API_KEY', local: true, models: ['qwen3:8b', 'llama3.2'], defaultModel: 'qwen3:8b',
    docs: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
  },
  {
    id: 'ollama-cloud', label: 'Ollama Cloud', kind: 'openai', baseUrl: 'https://ollama.com/v1',
    envKey: 'OLLAMA_CLOUD_API_KEY', models: [], defaultModel: null, docs: 'https://ollama.com',
  },
  {
    id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY', models: [], defaultModel: null, docs: 'https://openrouter.ai/docs',
  },
  {
    id: 'openai-compatible', label: 'OpenAI-compatible endpoint', kind: 'openai', baseUrl: '',
    envKey: 'OPENAI_COMPATIBLE_API_KEY', custom: true, models: [], defaultModel: null,
    docs: 'https://platform.openai.com/docs/api-reference/chat',
  },
  {
    id: 'anthropic-compatible', label: 'Anthropic-compatible endpoint', kind: 'anthropic', baseUrl: '',
    envKey: 'ANTHROPIC_COMPATIBLE_API_KEY', custom: true, models: [], defaultModel: null,
    docs: 'https://docs.anthropic.com/en/api/messages',
  },
]


export function catalogEntry (id) {
  return PROVIDER_CATALOG.find((entry) => entry.id === id) ?? null
}

// Configuration of one provider wins over the catalog; a credential is only "present" when a key exists, and a
// local provider (Ollama on this machine) is usable without one.
export function resolveProvider (entry, providerConfig = {}, env = {}) {
  const apiKey = providerConfig.apiKey || env[providerConfig.apiKeyEnv || entry.envKey] || ''
  const baseUrl = String(providerConfig.baseUrl ?? entry.baseUrl ?? '').replace(/\/+$/, '')
  const models = [...new Set([...(providerConfig.models ?? []), ...(entry.models ?? [])])]
  const defaultModel = providerConfig.defaultModel ?? entry.defaultModel ?? models[0] ?? null
  const enabled = providerConfig.enabled !== false && Boolean(baseUrl)
  return {
    id: entry.id,
    label: providerConfig.label ?? entry.label,
    kind: entry.kind,
    baseUrl,
    models,
    defaultModel,
    enabled,
    local: Boolean(entry.local),
    custom: Boolean(entry.custom),
    docs: entry.docs ?? null,
    headers: { ...(providerConfig.headers ?? {}) },
    configured: Boolean(apiKey) || Boolean(entry.local),
    apiKey,
    timeoutMs: Number(providerConfig.timeoutMs) > 0 ? Number(providerConfig.timeoutMs) : null,
  }
}

export function resolveProviders (config = {}, env = {}) {
  const configured = config.providers ?? {}
  return PROVIDER_CATALOG.map((entry) => resolveProvider(entry, configured[entry.id] ?? {}, env))
}

// What the copilot may see: no credential, ever, and no claim stronger than "a key exists"
export function publicProvider (provider) {
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    models: provider.models,
    defaultModel: provider.defaultModel,
    configured: provider.configured,
    enabled: provider.enabled,
    local: provider.local,
    custom: provider.custom,
    docs: provider.docs,
  }
}

export class GatewayError extends Error {
  constructor (code, message, details = {}) {
    super(message)
    this.name = 'GatewayError'
    this.code = code
    this.status = details.status ?? statusFor(code)
    this.retryAfterMs = details.retryAfterMs ?? null
    this.provider = details.provider ?? null
  }
}

function statusFor (code) {
  switch (code) {
    case ERROR.unauthorized: return 401
    case ERROR.bad_request: return 400
    case ERROR.not_found: return 404
    case ERROR.unknown_provider: return 400
    case ERROR.provider_not_configured: return 409
    case ERROR.provider_disabled: return 409
    case ERROR.model_not_available: return 400
    case ERROR.rate_limited: return 429
    case ERROR.auth_failed: return 502
    case ERROR.timeout: return 504
    case ERROR.cancelled: return 499
    default: return 502
  }
}

// Picks the provider and the model of a request. A provider that is not configured is never used as a fallback:
// "first configured provider" is the only automatic choice, and it is reported in the response.
export function route (providers, request = {}) {
  const enabled = providers.filter((provider) => provider.enabled)
  let provider
  if (request.provider) {
    provider = enabled.find((item) => item.id === request.provider)
    if (!provider)
      throw new GatewayError(ERROR.unknown_provider, `unknown or disabled provider "${request.provider}"`)
  } else {
    provider = enabled.find((item) => item.configured)
    if (!provider)
      throw new GatewayError(ERROR.provider_not_configured, 'no provider has a credential yet; configure one in the gateway')
  }
  if (!provider.configured)
    throw new GatewayError(ERROR.provider_not_configured,
      `provider "${provider.id}" has no credential; set ${provider.id.toUpperCase()}_API_KEY or add its key to the gateway config`)
  const model = request.model || provider.defaultModel
  if (!model)
    throw new GatewayError(ERROR.bad_request, `provider "${provider.id}" has no default model: send one explicitly`)
  if (provider.models.length && !provider.models.includes(model))
    throw new GatewayError(ERROR.model_not_available, `model "${model}" is not in the model list of "${provider.id}"`)
  return { provider, model }
}

export function normalizeMessages (messages) {
  if (!Array.isArray(messages) || !messages.length)
    throw new GatewayError(ERROR.bad_request, 'messages must be a non-empty array')
  if (messages.length > 200)
    throw new GatewayError(ERROR.bad_request, 'a conversation of more than 200 messages is refused')
  return messages.map((message) => {
    if (!message || typeof message !== 'object')
      throw new GatewayError(ERROR.bad_request, 'every message must be an object { role, content }')
    const allowed = ['system', 'user', 'assistant']
    if (!allowed.includes(message.role))
      throw new GatewayError(ERROR.bad_request, `message role must be one of ${allowed.join(', ')} (got ${JSON.stringify(message.role)})`)
    const role = message.role
    const content = typeof message.content === 'string' ? message.content : ''
    if (!content.trim())
      throw new GatewayError(ERROR.bad_request, `message with role "${role}" has no content`)
    if (content.length > 100_000)
      throw new GatewayError(ERROR.bad_request, 'a single message is limited to 100000 characters')
    return { role, content }
  })
}

function splitSystem (messages, explicitSystem) {
  const system = [explicitSystem, ...messages.filter((message) => message.role === 'system').map((message) => message.content)]
    .filter(Boolean)
    .join('\n\n')
  const dialog = messages.filter((message) => message.role !== 'system')
  return { system, dialog }
}

// The request of one provider, in its own wire format. Nothing here reads the environment or the network.
export function buildChatRequest (provider, options = {}) {
  const { model } = options
  const messages = normalizeMessages(options.messages)
  const stream = options.stream !== false
  const temperature = typeof options.temperature === 'number' ? options.temperature : undefined
  const maxTokens = Number(options.maxTokens) > 0 ? Math.floor(Number(options.maxTokens)) : undefined
  const { system, dialog } = splitSystem(messages, options.system)

  if (provider.kind === 'openai') {
    const body = { model, messages: system ? [{ role: 'system', content: system }, ...dialog] : dialog, stream }
    if (temperature !== undefined) body.temperature = temperature
    if (maxTokens !== undefined) body.max_tokens = maxTokens
    return {
      url: `${provider.baseUrl}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
        ...(provider.headers ?? {}),
      },
      body,
    }
  }

  if (provider.kind === 'anthropic') {
    const body = {
      model,
      messages: dialog.map((message) => ({ role: message.role === 'assistant' ? 'assistant' : 'user', content: message.content })),
      max_tokens: maxTokens ?? 1024,
      stream,
    }
    if (system) body.system = system
    if (temperature !== undefined) body.temperature = temperature
    return {
      url: `${provider.baseUrl}/messages`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        ...(provider.apiKey ? { 'x-api-key': provider.apiKey } : {}),
        ...(provider.headers ?? {}),
      },
      body,
    }
  }

  if (provider.kind === 'gemini') {
    const contents = dialog.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }))
    const body = { contents }
    if (system) body.systemInstruction = { parts: [{ text: system }] }
    if (temperature !== undefined) body.generationConfig = { temperature }
    const action = stream ? 'streamGenerateContent' : 'generateContent'
    const params = []
    if (stream) params.push('alt=sse')
    if (provider.apiKey) params.push(`key=${encodeURIComponent(provider.apiKey)}`)
    const suffix = params.length ? `?${params.join('&')}` : ''
    return {
      url: `${provider.baseUrl}/models/${encodeURIComponent(model)}:${action}${suffix}`,
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(provider.headers ?? {}) },
      body,
    }
  }

  throw new GatewayError(ERROR.bad_request, `provider kind "${provider.kind}" is not implemented`)
}

// Server-sent events arrive in arbitrary pieces: this buffers until a whole event is available.
export class SseDecoder {
  constructor () {
    this.buffer = ''
  }

  push (chunk) {
    this.buffer += String(chunk).replace(/\r\n/g, '\n')
    const payloads = []
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary)
      this.buffer = this.buffer.slice(boundary + 2)
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n')
      if (data)
        payloads.push(data)
      boundary = this.buffer.indexOf('\n\n')
    }
    return payloads
  }
}

// One provider wire payload -> normalized events. Unknown or empty payloads yield no event, never a guess.
export function eventsFromPayload (kind, payload) {
  const text = String(payload).trim()
  if (!text)
    return []
  if (text === '[DONE]')
    return [{ type: 'done' }]
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new GatewayError(ERROR.invalid_response, 'the provider sent a payload that is not JSON')
  }

  if (kind === 'openai') {
    const events = []
    const delta = json.choices?.[0]?.delta?.content
    if (typeof delta === 'string' && delta)
      events.push({ type: 'delta', text: delta })
    const messageText = json.choices?.[0]?.message?.content
    if (typeof messageText === 'string' && messageText && !delta)
      events.push({ type: 'delta', text: messageText })
    if (json.usage)
      events.push({ type: 'usage', usage: { inputTokens: json.usage.prompt_tokens ?? null, outputTokens: json.usage.completion_tokens ?? null } })
    const finish = json.choices?.[0]?.finish_reason
    if (finish)
      events.push({ type: 'done', reason: finish })
    return events
  }

  if (kind === 'anthropic') {
    if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta' && json.delta.text)
      return [{ type: 'delta', text: json.delta.text }]
    if (json.type === 'message_delta' && json.usage)
      return [{ type: 'usage', usage: { inputTokens: json.usage.input_tokens ?? null, outputTokens: json.usage.output_tokens ?? null } }]
    if (json.type === 'message_stop')
      return [{ type: 'done' }]
    if (json.type === 'error')
      throw new GatewayError(ERROR.upstream_error, json.error?.message ?? 'the provider reported an error')
    return []
  }

  if (kind === 'gemini') {
    const events = []
    const parts = json.candidates?.[0]?.content?.parts ?? []
    for (const part of parts) {
      if (typeof part.text === 'string' && part.text)
        events.push({ type: 'delta', text: part.text })
    }
    if (json.usageMetadata)
      events.push({ type: 'usage', usage: { inputTokens: json.usageMetadata.promptTokenCount ?? null, outputTokens: json.usageMetadata.candidatesTokenCount ?? null } })
    const finish = json.candidates?.[0]?.finishReason
    if (finish && finish !== 'FINISH_REASON_UNSPECIFIED')
      events.push({ type: 'done', reason: finish })
    return events
  }

  throw new GatewayError(ERROR.bad_request, `provider kind "${kind}" has no stream decoder`)
}

// A non-streamed answer, for the connection test and for providers called without streaming
export function textFromResponse (kind, json) {
  if (kind === 'openai')
    return json.choices?.[0]?.message?.content ?? ''
  if (kind === 'anthropic')
    return (json.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('')
  if (kind === 'gemini')
    return (json.candidates?.[0]?.content?.parts ?? []).map((part) => part.text ?? '').join('')
  return ''
}

// Every secret that could reach a log, an error message or the browser is replaced before it does.
export function redact (value, secrets = []) {
  let text = String(value ?? '')
  for (const secret of secrets) {
    if (secret && secret.length >= 4)
      text = text.split(secret).join('[redacted]')
  }
  text = text.replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
  text = text.replace(/(authorization:\s*bearer\s+)\S+/gi, '$1[redacted]')
  text = text.replace(/(x-api-key:\s*)\S+/gi, '$1[redacted]')
  return text
}

export function secretsOf (providers) {
  return providers.map((provider) => provider.apiKey).filter(Boolean)
}

// Maps an upstream HTTP failure onto the gateway vocabulary. A 401/403 means the credential is wrong, which is
// the owner's problem to fix and must not be reported as "the provider is down".
export function errorFromUpstream (providerId, status, bodyText) {
  const detail = redact(String(bodyText ?? '').slice(0, 500))
  if (status === 401 || status === 403)
    return new GatewayError(ERROR.auth_failed, `provider "${providerId}" rejected the credential (HTTP ${status}): ${detail}`, { provider: providerId })
  if (status === 429)
    return new GatewayError(ERROR.rate_limited, `provider "${providerId}" is rate limiting (HTTP 429): ${detail}`, { provider: providerId, retryAfterMs: 2000 })
  return new GatewayError(ERROR.upstream_error, `provider "${providerId}" failed (HTTP ${status}): ${detail}`, { provider: providerId })
}

// Provider credentials can live in a local file outside the repository, so nothing secret ever enters the tree:
//   DZ23_PROVIDER_ENV=C:\Users\<user>\.dz23\providers.env   node gateway/server.mjs
// Format: KEY=VALUE lines, # comments, optional "export ", optional single/double quotes around the value.
export function parseEnvFile (text) {
  const values = {}
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#'))
      continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match)
      continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1)
    values[match[1]] = value
  }
  return values
}

export function loadProviderEnv (path, readFile = null) {
  if (!path)
    return {}
  let text
  try {
    text = readFile ? readFile(path) : null
  } catch (error) {
    throw new GatewayError(ERROR.bad_request, `could not read DZ23_PROVIDER_ENV at "${path}": ${error.message}`)
  }
  if (text === null)
    return {}
  return parseEnvFile(text)
}

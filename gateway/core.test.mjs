import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ERROR,
  GatewayError,
  PROVIDER_CATALOG,
  SseDecoder,
  buildChatRequest,
  parseEnvFile,
  errorFromUpstream,
  eventsFromPayload,
  normalizeMessages,
  publicProvider,
  redact,
  resolveProviders,
  route,
} from './core.mjs'

// The core has no I/O: every rule of the gateway (routing, wire format, stream parsing, redaction) is pinned here.

function providers (config = {}, env = {}) {
  return resolveProviders(config, env)
}

test('a provider without a credential is not configured, except a local one', () => {
  const list = providers()
  const openai = list.find((provider) => provider.id === 'openai')
  const ollama = list.find((provider) => provider.id === 'ollama')
  assert.equal(openai.configured, false)
  assert.equal(ollama.configured, true, 'Ollama on this machine needs no key')
  assert.equal(ollama.local, true)
})

test('a key from the environment or the config marks the provider configured', () => {
  const fromEnv = providers({}, { OPENAI_API_KEY: 'sk-test' })
  assert.equal(fromEnv.find((provider) => provider.id === 'openai').configured, true)
  const fromConfig = providers({ providers: { deepseek: { apiKey: 'dk-test' } } })
  assert.equal(fromConfig.find((provider) => provider.id === 'deepseek').configured, true)
})

test('a custom endpoint adds its base URL, models and headers', () => {
  const list = providers({
    providers: {
      'openai-compatible': {
        baseUrl: 'http://127.0.0.1:1234/v1/',
        apiKey: 'local-key',
        models: ['local-model'],
        headers: { 'x-tenant': 'dz23' },
      },
    },
  })
  const custom = list.find((provider) => provider.id === 'openai-compatible')
  assert.equal(custom.baseUrl, 'http://127.0.0.1:1234/v1')
  assert.deepEqual(custom.models, ['local-model'])
  assert.deepEqual(custom.headers, { 'x-tenant': 'dz23' })
  assert.equal(custom.configured, true)
})

test('the public view of a provider never carries the credential', () => {
  const provider = providers({ providers: { openai: { apiKey: 'sk-secret-value' } } }).find((item) => item.id === 'openai')
  const view = publicProvider(provider)
  assert.equal('apiKey' in view, false)
  assert.equal(JSON.stringify(view).includes('sk-secret-value'), false)
  assert.equal(view.configured, true)
})

test('routing refuses an unknown, disabled or unconfigured provider', () => {
  const list = providers({ providers: { openai: { apiKey: 'k' } } })
  assert.throws(() => route(list, { provider: 'nope' }), (error) => error.code === ERROR.unknown_provider)
  const disabled = providers({ providers: { openai: { apiKey: 'k', enabled: false } } })
  assert.throws(() => route(disabled, { provider: 'openai' }), (error) => error.code === ERROR.unknown_provider)
  const onlyLocalDisabled = providers({ providers: { ollama: { enabled: false } } })
  assert.throws(() => route(onlyLocalDisabled, {}), (error) => error.code === ERROR.provider_not_configured)
})

test('routing picks the requested model, the provider default, and checks the model list', () => {
  const list = providers({ providers: { openai: { apiKey: 'k', models: ['gpt-4o-mini'], defaultModel: 'gpt-4o-mini' } } })
  assert.equal(route(list, { provider: 'openai' }).model, 'gpt-4o-mini')
  assert.equal(route(list, { provider: 'openai', model: 'gpt-4o-mini' }).model, 'gpt-4o-mini')
  assert.throws(() => route(list, { provider: 'openai', model: 'not-in-list' }),
    (error) => error.code === ERROR.model_not_available)
})

test('a message list is validated before it reaches a provider', () => {
  assert.throws(() => normalizeMessages([]), (error) => error.code === ERROR.bad_request)
  assert.throws(() => normalizeMessages([{ role: 'user', content: '   ' }]), (error) => error.code === ERROR.bad_request)
  assert.throws(() => normalizeMessages([{ role: 'user', content: 'x'.repeat(100_001) }]),
    (error) => error.code === ERROR.bad_request)
  // papel fora de system/user/assistant é RECUSADO, não coagido: coagir reescrevia a intenção do chamador
  assert.throws(() => normalizeMessages([{ role: 'tool', content: ' hi ' }]),
    (error) => error.code === ERROR.bad_request && /role must be one of/.test(error.message))
  assert.deepEqual(normalizeMessages([{ role: 'user', content: ' hi ' }]), [{ role: 'user', content: ' hi ' }])
})

test('an OpenAI-compatible request carries the bearer key and the system message', () => {
  const provider = providers({ providers: { deepseek: { apiKey: 'dk-1' } } }).find((item) => item.id === 'deepseek')
  const request = buildChatRequest(provider, {
    model: 'deepseek-chat',
    messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'oi' }],
    maxTokens: 10,
    temperature: 0,
  })
  assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions')
  assert.equal(request.headers.authorization, 'Bearer dk-1')
  assert.equal(request.body.model, 'deepseek-chat')
  assert.equal(request.body.stream, true)
  assert.equal(request.body.max_tokens, 10)
  assert.deepEqual(request.body.messages.map((message) => message.role), ['system', 'user'])
})

test('an Anthropic-compatible request uses x-api-key, a version header and top-level system', () => {
  const provider = providers({ providers: { anthropic: { apiKey: 'an-1' } } }).find((item) => item.id === 'anthropic')
  const request = buildChatRequest(provider, {
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'system', content: 'rule' }, { role: 'user', content: 'oi' }],
  })
  assert.equal(request.url, 'https://api.anthropic.com/v1/messages')
  assert.equal(request.headers['x-api-key'], 'an-1')
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.body.system, 'rule')
  assert.equal(request.body.max_tokens, 1024, 'Anthropic requires max_tokens')
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'oi' }])
})

test('a Gemini request keeps the key in the query and maps roles to contents', () => {
  const provider = providers({ providers: { gemini: { apiKey: 'gm-1' } } }).find((item) => item.id === 'gemini')
  const request = buildChatRequest(provider, {
    model: 'gemini-2.0-flash',
    messages: [{ role: 'assistant', content: 'antes' }, { role: 'user', content: 'agora' }],
    system: 'ctx',
  })
  assert.match(request.url, /models\/gemini-2\.0-flash:streamGenerateContent\?alt=sse&key=gm-1$/)
  assert.deepEqual(request.body.contents.map((item) => item.role), ['model', 'user'])
  assert.deepEqual(request.body.systemInstruction, { parts: [{ text: 'ctx' }] })
})

test('the SSE decoder splits events across arbitrary chunks and ignores comments', () => {
  const decoder = new SseDecoder()
  assert.deepEqual(decoder.push(': keepalive\n\ndata: {"a":'), [])
  assert.deepEqual(decoder.push('1}\n\ndata: [DONE]\n\n'), ['{"a":1}', '[DONE]'])
  assert.deepEqual(decoder.push('data: {"b":2}\r\n\r\n'), ['{"b":2}'])
})

test('each provider payload becomes the same normalized events', () => {
  assert.deepEqual(eventsFromPayload('openai', JSON.stringify({ choices: [{ delta: { content: 'olá' } }] })),
    [{ type: 'delta', text: 'olá' }])
  assert.deepEqual(eventsFromPayload('openai', JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })),
    [{ type: 'done', reason: 'stop' }])
  assert.deepEqual(eventsFromPayload('openai', '[DONE]'), [{ type: 'done' }])
  assert.deepEqual(eventsFromPayload('anthropic', JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'oi' } })),
    [{ type: 'delta', text: 'oi' }])
  assert.deepEqual(eventsFromPayload('anthropic', JSON.stringify({ type: 'message_stop' })), [{ type: 'done' }])
  assert.deepEqual(eventsFromPayload('gemini', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })),
    [{ type: 'delta', text: 'ok' }])
  assert.throws(() => eventsFromPayload('openai', 'not json'), (error) => error.code === ERROR.invalid_response)
  assert.throws(() => eventsFromPayload('anthropic', JSON.stringify({ type: 'error', error: { message: 'boom' } })),
    (error) => error.code === ERROR.upstream_error)
})

test('a secret never survives redaction', () => {
  const redacted = redact('key sk-1234567890 / authorization: Bearer abc.def / url?key=sk-1234567890&x=1', ['sk-1234567890'])
  assert.equal(redacted.includes('sk-1234567890'), false)
  assert.equal(redacted.includes('abc.def'), false)
  assert.match(redacted, /\[redacted\]/)
})

test('an upstream failure is classified, not flattened into "error"', () => {
  assert.equal(errorFromUpstream('openai', 401, 'bad key').code, ERROR.auth_failed)
  assert.equal(errorFromUpstream('openai', 429, 'slow down').code, ERROR.rate_limited)
  assert.equal(errorFromUpstream('openai', 500, 'boom').code, ERROR.upstream_error)
  assert.equal(new GatewayError(ERROR.timeout, 'x').status, 504)
  assert.equal(new GatewayError(ERROR.unauthorized, 'x').status, 401)
})

test('the catalog covers every provider the mission names', () => {
  const ids = PROVIDER_CATALOG.map((entry) => entry.id)
  for (const required of ['openai', 'deepseek', 'anthropic', 'gemini', 'ollama', 'ollama-cloud', 'openrouter', 'openai-compatible', 'anthropic-compatible'])
    assert.ok(ids.includes(required), `${required} is missing from the catalog`)
})

test('the provider env file is read as key/value, without comments or quotes', () => {
  const values = parseEnvFile([
    '# credenciais locais',
    'export DEEPSEEK_API_KEY="sk-dk-1"',
    'OPENROUTER_API_KEY=sk-or-2',
    '',
    'this line is not an assignment',
    'EMPTY=',
  ].join('\n'))
  assert.deepEqual(values, { DEEPSEEK_API_KEY: 'sk-dk-1', OPENROUTER_API_KEY: 'sk-or-2', EMPTY: '' })
})
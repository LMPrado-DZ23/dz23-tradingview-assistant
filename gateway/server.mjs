// DZ23 AI Gateway — local HTTP service that holds the provider credentials.
//
// The browser never sees an API key: the copilot talks to this process on 127.0.0.1 with a bearer token, and the
// gateway turns one request into one normalized event stream. Node standard library only.
//
//   node gateway/server.mjs            (reads gateway/config.json)
//   DZ23_GATEWAY_TOKEN=... node gateway/server.mjs
import { loadProviderEnv } from './core.mjs'
import { createServer } from 'node:http'
import { readFileSync as readEnvFile } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ERROR,
  PROTOCOL_VERSION,
  SseDecoder,
  GatewayError,
  buildChatRequest,
  errorFromUpstream,
  eventsFromPayload,
  normalizeMessages,
  publicProvider,
  redact,
  resolveProviders,
  route,
  secretsOf,
  textFromResponse,
} from './core.mjs'
import { buildProviderChain, createUsageLedger, isFallbackable, recordUsage, summarizeUsage } from './fallback.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DEFAULT_EXTENSION_ID = 'ejmflepgfmffgicdjdaigdfdcacehgma'
const MAX_BODY_BYTES = 1024 * 1024
const MAX_UPSTREAM_ERROR_BYTES = 2000

export function loadConfig (path = join(here, 'config.json'), env = process.env) {
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  return {
    host: '127.0.0.1',
    port: Number(env.DZ23_GATEWAY_PORT ?? file.port ?? 8777),
    authToken: String(env.DZ23_GATEWAY_TOKEN ?? file.authToken ?? ''),
    providerEnvPath: String(env.DZ23_PROVIDER_ENV ?? file.providerEnvPath ?? ''),
    timeoutMs: Number(file.timeoutMs ?? 60_000),
    rateLimit: {
      capacity: Number(file.rateLimit?.capacity ?? 30),
      refillPerSecond: Number(file.rateLimit?.refillPerSecond ?? 1),
    },
    allowedOrigins: file.allowedOrigins ?? null,
    // Identity of the extension allowed to talk to this gateway. Never "any chrome-extension://".
    extensionId: file.extensionId ?? env.DZ23_EXTENSION_ID ?? DEFAULT_EXTENSION_ID,
    extensionIds: Array.isArray(file.extensionIds) ? file.extensionIds : [],
    // Development only: accepts the local http origin and unpacked extensions, nothing else
    dev: String(env.DZ23_GATEWAY_DEV ?? '').trim() === '1' || file.dev === true,
    providers: file.providers ?? {},
  }
}

// A token bucket per client. A refusal carries how long to wait, so the caller can back off instead of guessing.
export function createRateLimiter ({ capacity, refillPerSecond }, now = () => Date.now()) {
  const buckets = new Map()
  return function take (key) {
    const current = now()
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: current }
      buckets.set(key, bucket)
    }
    const elapsedSeconds = (current - bucket.updatedAt) / 1000
    bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond)
    bucket.updatedAt = current
    if (bucket.tokens < 1) {
      const retryAfterMs = Math.ceil(((1 - bucket.tokens) / refillPerSecond) * 1000)
      return { allowed: false, retryAfterMs }
    }
    bucket.tokens -= 1
    return { allowed: true, retryAfterMs: 0 }
  }
}

// Origins are an exact list, never a prefix: a chrome-extension:// origin is accepted only when that exact
// origin is listed. Localhost is accepted only in development (DZ23_GATEWAY_DEV=1), because the UI is served
// over http there. Without a list and without dev mode a browser origin is refused, so the extension must be named.
// "chrome-extension://<id>" -> "<id>", or null when the origin is not an extension origin
function extensionIdOf (origin) {
  const match = String(origin).match(/^chrome-extension:\/\/([a-p]{32})$/)
  return match ? match[1] : null
}

function isOriginAllowed (origin, config) {
  if (!origin)
    return true // no browser origin: curl, tests, service-to-service
  if (Array.isArray(config.allowedOrigins) && config.allowedOrigins.length)
    return config.allowedOrigins.includes(origin)
  const extensionId = extensionIdOf(origin)
  const knownIds = [config.extensionId, ...(config.extensionIds ?? [])].filter(Boolean)
  if (extensionId)
    return knownIds.includes(extensionId)
  if (config.dev)
    return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)
  return false
}

function readBody (request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new GatewayError(ERROR.bad_request, 'request body is larger than 1 MB'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw.trim())
        return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new GatewayError(ERROR.bad_request, 'request body is not valid JSON'))
      }
    })
    request.on('error', reject)
  })
}

async function readUpstreamError (response) {
  try {
    const text = await response.text()
    return text.slice(0, MAX_UPSTREAM_ERROR_BYTES)
  } catch {
    return ''
  }
}

export function createGateway ({ config, env = process.env, logger = console }) {
  if (!config.authToken)
    throw new Error('the gateway refuses to start without a token: set DZ23_GATEWAY_TOKEN or authToken in gateway/config.json')
  const providers = resolveProviders(config, env)
  const secrets = secretsOf(providers)
  const limit = createRateLimiter(config.rateLimit)
  const running = new Map()
  const usage = createUsageLedger()

  const log = (entry) => logger.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }))

  function sendJson (response, status, payload) {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }

  function sendError (response, error) {
    const gatewayError = error instanceof GatewayError ? error : new GatewayError(ERROR.upstream_error, String(error?.message ?? error))
    sendJson(response, gatewayError.status, {
      protocol: PROTOCOL_VERSION,
      error: { code: gatewayError.code, message: redact(gatewayError.message, secrets), provider: gatewayError.provider },
    })
  }

  function authorize (request) {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    if (!token || token !== config.authToken)
      throw new GatewayError(ERROR.unauthorized, 'missing or invalid bearer token')
  }

  function providerFor (id) {
    const provider = providers.find((item) => item.id === id)
    if (!provider || !provider.enabled)
      throw new GatewayError(ERROR.unknown_provider, `unknown or disabled provider "${id}"`)
    return provider
  }

  // The timer and the client-abort link stay alive while the body streams: a provider that stops sending is a
  // timeout, and a cancel must reach the upstream call. `dispose` ends both when the answer is over.
  async function upstreamFetch (requestSpec, { timeoutMs, signal }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(ERROR.timeout)), timeoutMs)
    const abort = () => controller.abort(new Error(ERROR.cancelled))
    signal?.addEventListener('abort', abort, { once: true })
    const dispose = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    try {
      const response = await fetch(requestSpec.url, {
        method: requestSpec.method,
        headers: requestSpec.headers,
        body: JSON.stringify(requestSpec.body),
        signal: controller.signal,
      })
      return { response, dispose }
    } catch (error) {
      dispose()
      if (controller.signal.aborted) {
        const reason = controller.signal.reason?.message
        throw new GatewayError(reason === ERROR.timeout ? ERROR.timeout : ERROR.cancelled,
          reason === ERROR.timeout ? `the provider did not answer within ${timeoutMs} ms` : 'the request was cancelled')
      }
      throw new GatewayError(ERROR.network_error, redact(`could not reach the provider: ${error?.message ?? error}`, secrets))
    }
  }

  async function chatStream (request, response, body) {
    const messages = normalizeMessages(body.messages)
    const { provider, model } = route(providers, { provider: body.provider, model: body.model })
    const chain = buildProviderChain(providers, { provider: provider.id, fallback: body.fallback })
    const requestId = String(body.requestId ?? randomUUID())
    const controller = new AbortController()
    running.set(requestId, controller)
    // The client went away mid-answer (closed tab, stop button on the transport side): stop the upstream call
    request.on('close', () => {
      if (!controller.signal.aborted)
        controller.abort(new Error(ERROR.cancelled))
    })

    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-request-id': requestId,
    })
    const emit = (event) => response.write(`data: ${JSON.stringify({ protocol: PROTOCOL_VERSION, ...event })}\n\n`)
    const finish = () => {
      if (!response.writableEnded)
        response.end()
    }
    const fail = (error) => {
      // An abort can surface as an AbortError from the body iteration: a cancellation is a terminal state of its
      // own, not an error, because the copilot shows it differently (and the user asked for it).
      if (controller.signal.aborted) {
        emit({ type: 'cancelled', requestId })
        log({ event: 'chat_cancelled', requestId, provider: provider.id, model })
        finish()
        return
      }
      const gatewayError = error instanceof GatewayError ? error : new GatewayError(ERROR.upstream_error, String(error?.message ?? error))
      emit({ type: 'error', error: { code: gatewayError.code, message: redact(gatewayError.message, secrets), provider: gatewayError.provider ?? provider.id } })
      log({ event: 'chat_error', requestId, provider: provider.id, model, code: gatewayError.code })
      finish()
    }

    const startedAt = Date.now()
    let disposeUpstream = null
    emit({ type: 'start', requestId, provider: provider.id, model, fallbacks: chain.length > 1 ? chain.slice(1) : undefined })

    try {
      let active = provider
      let activeModel = model
      let upstream = null
      // Fallback apenas quando o provedor falha antes de entregar texto: resposta parcial nunca é duplicada.
      for (let attemptIndex = 0; attemptIndex < chain.length; attemptIndex += 1) {
        active = attemptIndex === 0 ? provider : providers.find((item) => item.id === chain[attemptIndex])
        activeModel = attemptIndex === 0 ? model : (body.model || active.defaultModel || model)
        const attemptStartedAt = Date.now()
        try {
          const spec = buildChatRequest(active, {
            messages,
            model: activeModel,
            system: body.system,
            temperature: body.temperature,
            maxTokens: body.maxTokens,
            stream: true,
          })
          const upstreamCall = await upstreamFetch(spec, {
            timeoutMs: active.timeoutMs ?? config.timeoutMs,
            signal: controller.signal,
          })
          disposeUpstream = upstreamCall.dispose
          const upstreamResponse = upstreamCall.response
          if (!upstreamResponse.ok) {
            throw errorFromUpstream(active.id, upstreamResponse.status, await readUpstreamError(upstreamResponse))
          }
          recordUsage(usage, { provider: active.id, model: activeModel, ok: true, ms: Date.now() - attemptStartedAt })
          upstream = upstreamResponse
          break
        } catch (attemptError) {
          const attemptCode = attemptError instanceof GatewayError ? attemptError.code : 'upstream_error'
          recordUsage(usage, { provider: active.id, model: activeModel, ok: false, code: attemptCode, ms: Date.now() - attemptStartedAt })
          const canFallback = attemptIndex + 1 < chain.length && isFallbackable(attemptCode)
          if (!canFallback)
            throw attemptError
          const target = chain[attemptIndex + 1]
          emit({ type: 'notice', code: 'provider_fallback', from: active.id, to: target })
          log({ event: 'provider_fallback', requestId, from: active.id, to: target, code: attemptCode })
        }
      }
      if (!upstream)
        throw new GatewayError(ERROR.provider_not_configured, 'no provider answered the request')
      const decoder = new SseDecoder()
      const textDecoder = new TextDecoder()
      let text = ''
      for await (const chunk of upstream.body) {
        for (const payload of decoder.push(textDecoder.decode(chunk, { stream: true }))) {
          for (const event of eventsFromPayload(active.kind, payload)) {
            if (event.type === 'delta') {
              text += event.text
              emit(event)
            } else if (event.type === 'usage') {
              emit(event)
            } else if (event.type === 'done') {
              emit({ type: 'done', reason: event.reason ?? null, text, provider: active.id, model: activeModel })
            }
          }
        }
        if (controller.signal.aborted)
          break
      }
      if (controller.signal.aborted)
        throw new GatewayError(ERROR.cancelled, 'the request was cancelled')
      log({ event: 'chat_done', requestId, provider: provider.id, model, ms: Date.now() - startedAt, chars: text.length })
    } catch (error) {
      fail(error)
    } finally {
      disposeUpstream?.()
      running.delete(requestId)
      finish()
    }
  }

  async function connectionTest (body) {
    const provider = providerFor(body.provider)
    if (!provider.configured)
      throw new GatewayError(ERROR.provider_not_configured, `provider "${provider.id}" has no credential`)
    const model = body.model || provider.defaultModel
    if (!model)
      throw new GatewayError(ERROR.bad_request, `provider "${provider.id}" has no model to test; send one`)
    const startedAt = Date.now()
    const spec = buildChatRequest(provider, {
      messages: [{ role: 'user', content: 'ping' }],
      model,
      maxTokens: 1,
      temperature: 0,
      stream: false,
    })
    const upstreamCall = await upstreamFetch(spec, { timeoutMs: Math.min(config.timeoutMs, 20_000), signal: undefined })
    const upstream = upstreamCall.response
    if (!upstream.ok)
      throw errorFromUpstream(provider.id, upstream.status, await readUpstreamError(upstream))
    const json = await upstream.json()
    upstreamCall.dispose()
    return {
      ok: true,
      provider: provider.id,
      model,
      latencyMs: Date.now() - startedAt,
      sample: redact(textFromResponse(provider.kind, json).slice(0, 40), secrets),
    }
  }

  // One report per provider: credential, auth (a real request), streaming (first delta), cancel (abort mid-answer).
  // A provider that cannot be probed says why; nothing is reported as working without a request behind it.
  async function diagnose (body) {
    const provider = providerFor(body.provider)
    const active = provider
    const checks = []
    const push = (name, ok, detail) => checks.push({ name, ok, detail: redact(detail, secrets) })
    const result = () => ({ protocol: PROTOCOL_VERSION, provider: provider.id, model: provider.defaultModel ?? null, ok: checks.every((c) => c.ok === true), checks })

    if (!provider.configured) {
      push('credential', false, `no credential: set ${provider.id.toUpperCase()}_API_KEY or add the key to the gateway config`)
      return result()
    }
    push('credential', true, provider.local ? 'local provider, no key needed' : 'key present')

    try {
      const probe = await connectionTest({ provider: provider.id })
      push('auth', true, `HTTP ok in ${probe.latencyMs} ms`)
    } catch (error) {
      push('auth', false, `${error.code}: ${error.message}`)
      return result()
    }

    const model = provider.defaultModel
    const spec = () => buildChatRequest(provider, { messages: [{ role: 'user', content: 'ping' }], model, maxTokens: 8, temperature: 0, stream: true })

    // streaming: the first delta proves the wire format and the normalization
    const startedAt = Date.now()
    try {
      const call = await upstreamFetch(spec(), { timeoutMs: Math.min(config.timeoutMs, 15_000), signal: null })
      if (!call.response.ok)
        throw errorFromUpstream(provider.id, call.response.status, await readUpstreamError(call.response))
      const decoder = new SseDecoder()
      const textDecoder = new TextDecoder()
      let firstDeltaMs = null
      let chars = 0
      let done = false
      for await (const chunk of call.response.body) {
        for (const payload of decoder.push(textDecoder.decode(chunk, { stream: true }))) {
          for (const event of eventsFromPayload(active.kind, payload)) {
            if (event.type === 'delta') {
              chars += event.text.length
              if (firstDeltaMs === null) firstDeltaMs = Date.now() - startedAt
            }
            if (event.type === 'done') done = true
          }
        }
        if (done) break
      }
      call.dispose()
      push('streaming', firstDeltaMs !== null, firstDeltaMs === null ? 'no delta event arrived' : `first delta in ${firstDeltaMs} ms, ${chars} chars`)
    } catch (error) {
      push('streaming', false, `${error.code ?? 'error'}: ${error.message}`)
    }

    // cancel: abort mid-answer and confirm the upstream call was aborted, not left running
    try {
      const controller = new AbortController()
      let firstDeltaMs = null
      const cancelStartedAt = Date.now()
      const call = await upstreamFetch(spec(), { timeoutMs: Math.min(config.timeoutMs, 15_000), signal: controller.signal })
      const timer = setInterval(() => {
        if (firstDeltaMs !== null) controller.abort(new Error(ERROR.cancelled))
      }, 20)
      const decoder = new SseDecoder()
      const textDecoder = new TextDecoder()
      try {
        for await (const chunk of call.response.body) {
          for (const payload of decoder.push(textDecoder.decode(chunk, { stream: true }))) {
            for (const event of eventsFromPayload(active.kind, payload)) {
              if (event.type === 'delta' && firstDeltaMs === null) firstDeltaMs = Date.now() - cancelStartedAt
            }
          }
          if (firstDeltaMs !== null) controller.abort(new Error(ERROR.cancelled))
        }
      } catch (error) {
        // Aborting the upstream is the point of this probe: the AbortError is the expected outcome
        if (!controller.signal.aborted) throw error
      } finally {
        clearInterval(timer)
        call.dispose()
      }
      push('cancel', controller.signal.aborted, controller.signal.aborted
        ? `aborted after ${Date.now() - cancelStartedAt} ms`
        : 'the answer ended before it could be cancelled')
    } catch (error) {
      push('cancel', false, `${error.code ?? 'error'}: ${error.message}`)
    }

    return result()
  }

  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const origin = request.headers.origin
    response.setHeader('access-control-allow-origin', isOriginAllowed(origin, config) ? (origin ?? '*') : 'null')
    response.setHeader('vary', 'origin')
    response.setHeader('access-control-allow-headers', 'authorization, content-type')
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
    if (origin && !isOriginAllowed(origin, config)) {
      sendJson(response, 403, { protocol: PROTOCOL_VERSION, error: { code: ERROR.unauthorized, message: 'this origin is not allowed' } })
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end()
      return
    }

    try {
      // Development pairing: the panel asks for the token instead of the user pasting it. Never in production,
      // because then any local page could read it.
      if (url.pathname === '/token' && request.method === 'GET') {
        if (!config.dev) {
          sendJson(response, 404, { protocol: PROTOCOL_VERSION, error: { code: 'not_found', message: 'token pairing is disabled outside development' } })
          return
        }
        sendJson(response, 200, { protocol: PROTOCOL_VERSION, token: config.authToken, dev: true })
        return
      }

      if (url.pathname === '/health') {
        sendJson(response, 200, {
          protocol: PROTOCOL_VERSION,
          status: 'ok',
          providers: providers.length,
          configured: providers.filter((provider) => provider.configured).length,
        })
        return
      }

      authorize(request)

      const clientKey = request.socket.remoteAddress ?? 'unknown'
      const gate = limit(clientKey)
      if (!gate.allowed) {
        response.setHeader('retry-after', String(Math.ceil(gate.retryAfterMs / 1000)))
        throw new GatewayError(ERROR.rate_limited, `too many requests, retry in ${gate.retryAfterMs} ms`, { retryAfterMs: gate.retryAfterMs })
      }

      if (url.pathname === '/usage' && request.method === 'GET') {
    sendJson(response, 200, { protocol: PROTOCOL_VERSION, ...summarizeUsage(usage) })
    return
  }

  if (url.pathname === '/providers' && request.method === 'GET') {
        sendJson(response, 200, { protocol: PROTOCOL_VERSION, providers: providers.map(publicProvider) })
        return
      }

      if (url.pathname === '/chat' && request.method === 'POST') {
        const body = await readBody(request)
        // /chat sempre transmite: aceitar `stream: false` e devolver SSE em silêncio confunde o cliente.
        if (body?.stream === false)
          throw new GatewayError(ERROR.bad_request, '/chat always streams (text/event-stream); omit "stream" or use /test for a one-shot call')
        await chatStream(request, response, body)
        return
      }

      if (url.pathname === '/cancel' && request.method === 'POST') {
        const body = await readBody(request)
        const controller = running.get(String(body.requestId ?? ''))
        if (!controller)
          throw new GatewayError(ERROR.bad_request, 'no running request with that id')
        controller.abort(new Error(ERROR.cancelled))
        sendJson(response, 200, { protocol: PROTOCOL_VERSION, cancelled: String(body.requestId) })
        return
      }

      if (url.pathname === '/diagnose' && request.method === 'POST') {
        const body = await readBody(request)
        sendJson(response, 200, await diagnose(body))
        return
      }

      if (url.pathname === '/test' && request.method === 'POST') {
        const body = await readBody(request)
        sendJson(response, 200, { protocol: PROTOCOL_VERSION, ...(await connectionTest(body)) })
        return
      }

      throw new GatewayError(ERROR.not_found, `unknown route ${request.method} ${url.pathname}`)
    } catch (error) {
      if (!response.headersSent) {
        sendError(response, error)
        log({
          event: 'http_error',
          method: request.method,
          path: url.pathname,
          ms: Date.now() - startedAt,
          code: error instanceof GatewayError ? error.code : ERROR.upstream_error,
        })
      } else if (!response.writableEnded) {
        response.end()
      }
    }
  })

  return {
    server,
    providers,
    listen: () => new Promise((resolve) => server.listen(config.port, config.host, () => resolve(server.address()))),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const isEntry = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isEntry) {
  // DZ23_GATEWAY_CONFIG is the documented way to point the gateway at another file; without it, config.json
  const config = loadConfig(process.env.DZ23_GATEWAY_CONFIG ?? join(here, 'config.json'))
  let gateway
  try {
    // A local file outside the repository keeps provider keys out of the tree; the environment still wins
    const providerEnv = config.providerEnvPath
      ? { ...process.env, ...loadProviderEnv(config.providerEnvPath, (path) => readEnvFile(path, 'utf8')) }
      : process.env
    gateway = createGateway({ config, env: providerEnv })
  } catch (error) {
    console.error(`[dz23-gateway] ${redact(error.message)}`)
    process.exit(1)
  }
  const address = await gateway.listen()
  const ready = gateway.providers.filter((provider) => provider.configured).map((provider) => provider.id)
  console.log(`[dz23-gateway] listening on http://${address.address}:${address.port} — configured providers: ${ready.length ? ready.join(', ') : 'none'}`)
  const shutdown = () => gateway.close().then(() => process.exit(0))
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

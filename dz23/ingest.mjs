// DZ23 ingest — local, authenticated endpoint that receives an experiment and stores it validated.
//
// This is the hand-off between the research side and the DZ23 agents: the payload is the versioned JSON produced
// by the contract, checked here again (never trusted because a client validated it), and stored as one file per
// experiment. No order execution, no TradingView call, no secret in the payload.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateExperiment, serializeExperiment } from '../extension/quant/contract.mjs'

const MAX_BODY_BYTES = 2 * 1024 * 1024

function readBody (request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('payload is larger than 2 MB'), { status: 413 }))
        request.resume()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve({ raw, json: raw.trim() ? JSON.parse(raw) : null })
      } catch {
        reject(Object.assign(new Error('payload is not valid JSON'), { status: 400 }))
      }
    })
    request.on('error', reject)
  })
}

const hashOf = (text) => createHash('sha256').update(text).digest('hex')

export function createIngest ({ authToken, dataDir, logger = console } = {}) {
  if (!authToken)
    throw new Error('the ingest service refuses to start without a token (DZ23_INGEST_TOKEN)')
  mkdirSync(dataDir, { recursive: true })
  const log = (entry) => logger.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }))

  const fileOf = (id) => join(dataDir, `${String(id).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`)

  function sendJson (response, status, payload) {
    const body = JSON.stringify(payload)
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }

  function authorize (request) {
    const header = request.headers.authorization ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    return Boolean(token) && token === authToken
  }

  const server = createServer(async (request, response) => {
    const startedAt = Date.now()
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    try {
      if (url.pathname === '/health') {
        const stored = readdirSync(dataDir).filter((name) => name.endsWith('.json')).length
        sendJson(response, 200, { protocol: 1, status: 'ok', stored })
        return
      }
      if (!authorize(request)) {
        sendJson(response, 401, { protocol: 1, error: { code: 'unauthorized', message: 'missing or invalid bearer token' } })
        return
      }

      if (url.pathname === '/experiments' && request.method === 'POST') {
        const { raw, json } = await readBody(request)
        if (!json)
          return sendJson(response, 400, { protocol: 1, error: { code: 'bad_request', message: 'empty payload' } })
        const validation = validateExperiment(json)
        if (!validation.ok) {
          log({ event: 'experiment_rejected', errors: validation.errors.length, ms: Date.now() - startedAt })
          return sendJson(response, 422, { protocol: 1, error: { code: 'invalid_experiment', message: 'the payload does not satisfy the contract', details: validation.errors } })
        }
        const hash = hashOf(raw)
        const path = fileOf(json.experiment_id)
        if (existsSync(path)) {
          const existing = JSON.parse(readFileSync(path, 'utf8'))
          if (existing.hash === hash) {
            log({ event: 'experiment_replayed', id: json.experiment_id, ms: Date.now() - startedAt })
            return sendJson(response, 200, { protocol: 1, ok: true, experiment_id: json.experiment_id, hash, replayed: true })
          }
          log({ event: 'experiment_conflict', id: json.experiment_id, ms: Date.now() - startedAt })
          return sendJson(response, 409, { protocol: 1, error: { code: 'experiment_conflict', message: 'the same experiment_id was already stored with another content' } })
        }
        writeFileSync(path, JSON.stringify({ hash, received_at: new Date().toISOString(), experiment: json, canonical: serializeExperiment(json) }, null, 2), 'utf8')
        log({ event: 'experiment_stored', id: json.experiment_id, hash, ms: Date.now() - startedAt })
        return sendJson(response, 201, { protocol: 1, ok: true, experiment_id: json.experiment_id, hash })
      }

      const match = url.pathname.match(/^\/experiments\/([A-Za-z0-9_.-]+)$/)
      if (match && request.method === 'GET') {
        const path = fileOf(match[1])
        if (!existsSync(path))
          return sendJson(response, 404, { protocol: 1, error: { code: 'not_found', message: 'unknown experiment_id' } })
        const record = JSON.parse(readFileSync(path, 'utf8'))
        return sendJson(response, 200, { protocol: 1, hash: record.hash, received_at: record.received_at, experiment: record.experiment })
      }

      sendJson(response, 404, { protocol: 1, error: { code: 'not_found', message: `unknown route ${request.method} ${url.pathname}` } })
    } catch (error) {
      const status = error.status ?? 500
      log({ event: 'request_failed', status, ms: Date.now() - startedAt })
      sendJson(response, status, { protocol: 1, error: { code: status === 413 ? 'payload_too_large' : status === 400 ? 'bad_request' : 'internal_error', message: error.message } })
    }
  })

  return { server, dataDir }
}

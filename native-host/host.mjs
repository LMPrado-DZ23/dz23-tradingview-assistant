// DZ23 — Native Messaging host: starts and supervises the local gateway for the extension.
//
// Chrome cannot spawn processes; a native host can. This one speaks the Native Messaging protocol (a 4-byte
// little-endian length followed by that many bytes of UTF-8 JSON) and owns the gateway lifecycle. It never prints or
// logs the gateway token, and it refuses to report "connected" from /health alone: the status distinguishes "our
// child is running", "something else answers on the port" and "nothing there".
//
// Requests (one JSON per frame):
//   { id, type: 'status' }    -> { id, ok, running, owned, port, health, log }
//   { id, type: 'start' }     -> { id, ok, started, already, port, health }
//   { id, type: 'stop' }      -> { id, ok, stopped, reason }
//   { id, type: 'diagnose' }  -> { id, ok, checks: [...] }
//
// The gateway command defaults to `<repo>/gateway/server.mjs`; DZ23_HOST_GATEWAY overrides it (tests and custom
// installs). The port comes from DZ23_GATEWAY_PORT or defaults to 8777.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..')
const PORT = Number(process.env.DZ23_GATEWAY_PORT ?? 8777)
const GATEWAY = process.env.DZ23_HOST_GATEWAY ?? join(REPO, 'gateway', 'server.mjs')
const HEALTH_TIMEOUT_MS = 800
const START_TIMEOUT_MS = 12_000
const LOG_LINES = 25

let child = null
const log = []

function record (line) {
  // keep it bounded and strip anything that looks like a token before storing
  const clean = String(line).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<token>')
  log.push(clean.slice(0, 300))
  while (log.length > LOG_LINES)
    log.shift()
}

// Chrome starts the host with its own environment, which may not carry the provider keys the user set at the
// Windows account level. Read them from HKCU\Environment instead of copying secrets into a file.
const PROVIDER_KEYS = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY']

function readUserEnv (name) {
  if (process.platform !== 'win32')
    return null
  try {
    const output = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true })
    const match = output.match(new RegExp(name + '\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+)'))
    return match?.[1]?.trim() || null
  } catch {
    return null
  }
}

function loadProvidersEnv () {
  const loaded = {}
  try {
    const text = readFileSync(join(homedir(), '.dz23', 'providers.env'), 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
      if (match && !line.trim().startsWith('#'))
        loaded[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    }
  } catch {
    /* no file: fine */
  }
  return loaded
}

function tokenFile () {
  return join(homedir(), '.dz23', 'gateway-token')
}

function readToken () {
  try {
    const value = readFileSync(tokenFile(), 'utf8').trim()
    return value || null
  } catch {
    return null
  }
}

async function health () {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: controller.signal })
    if (!response.ok)
      return { reachable: false, status: response.status }
    const body = await response.json()
    return { reachable: true, status: response.status, protocol: body.protocol, providers: body.providers, configured: body.configured }
  } catch {
    return { reachable: false }
  } finally {
    clearTimeout(timer)
  }
}

function owned () {
  // detached child: it outlives this host on purpose, so ownership is remembered while the process is alive
  return Boolean(child && child.exitCode === null && !child.killed)
}

// A detached child keeps running after this process ends, which is the point: the gateway belongs to the user.
process.on('exit', () => { if (child) child.unref() })

async function start () {
  const before = await health()
  if (before.reachable)
    return { ok: true, started: false, already: true, port: PORT, health: before, owned: owned() }
  if (!existsSync(GATEWAY))
    return { ok: false, started: false, reason: `gateway não encontrado em ${GATEWAY}`, port: PORT }

  const token = readToken()
  const env = {
    ...process.env,
    ...loadProvidersEnv(),
    DZ23_GATEWAY_PORT: String(PORT),
    DZ23_GATEWAY_DEV: process.env.DZ23_GATEWAY_DEV ?? '1',
  }
  // keys present in the Windows user environment but missing from Chrome's environment
  for (const key of PROVIDER_KEYS) {
    if (!env[key]) {
      const fromUser = readUserEnv(key)
      if (fromUser)
        env[key] = fromUser
    }
  }
  if (token)
    env.DZ23_GATEWAY_TOKEN = token

  // O host sai, mas o gateway continua: stdout/stderr vão para arquivo, nunca para um pipe sem leitor (EPIPE mataria
  // o processo no próximo log). Isto também é o log que o usuário pode abrir em ~/.dz23/gateway.log.
  const logPath = join(homedir(), '.dz23', 'gateway.log')
  mkdirSync(join(homedir(), '.dz23'), { recursive: true })
  const logFd = openSync(logPath, 'a')
  child = spawn(process.execPath, [GATEWAY], { env, cwd: REPO, stdio: ['ignore', logFd, logFd], windowsHide: true, detached: true })
  child.on('exit', (code) => { record(`gateway saiu com código ${code}`); child = null })

  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = await health()
    if (current.reachable)
      return { ok: true, started: true, already: false, port: PORT, health: current, owned: true }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { ok: false, started: true, reason: 'timeout esperando o gateway responder', port: PORT, log: log.slice(-8), owned: owned() }
}

async function stop () {
  if (!owned())
    return { ok: false, stopped: false, reason: 'o gateway não foi iniciado por este host' }
  const victim = child
  child = null
  victim.kill()
  const deadline = Date.now() + 4000
  while (Date.now() < deadline) {
    const current = await health()
    if (!current.reachable)
      return { ok: true, stopped: true }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return { ok: false, stopped: false, reason: 'o processo não encerrou no prazo' }
}

async function diagnose () {
  const checks = []
  checks.push({ name: 'gateway.file', ok: existsSync(GATEWAY), detail: GATEWAY })
  checks.push({ name: 'token.file', ok: Boolean(readToken()), detail: 'token em ~/.dz23/gateway-token' })
  const current = await health()
  checks.push({ name: 'health', ok: current.reachable, detail: current.reachable ? `protocol ${current.protocol}` : 'sem resposta' })
  checks.push({ name: 'owned', ok: owned(), detail: owned() ? 'processo filho ativo' : 'nenhum processo filho' })
  return { ok: checks.every((check) => check.ok), checks }
}

async function handle (request) {
  const id = request?.id ?? null
  try {
    switch (request?.type) {
      case 'status': {
        const current = await health()
        return { id, ok: true, running: current.reachable || owned(), owned: owned(), port: PORT, health: current, log: log.slice(-10) }
      }
      case 'start': return { id, ...(await start()) }
      case 'stop': return { id, ...(await stop()) }
      case 'diagnose': return { id, ...(await diagnose()) }
      // O token sai daqui, não de uma tela: o extension fala com o host por stdio (sem rede, sem outra extensão).
      case 'token': {
        const value = readToken()
        return value ? { id, ok: true, token: value } : { id, ok: false, error: 'sem token: o gateway ainda não gerou ~/.dz23/gateway-token' }
      }
      default: return { id, ok: false, error: `tipo desconhecido: ${request?.type}` }
    }
  } catch (error) {
    return { id, ok: false, error: String(error?.message ?? error) }
  }
}

/* --------------------------------------------------------------- framing */
function writeMessage (message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  process.stdout.write(Buffer.concat([header, payload]))
}

const MAX_FRAME_BYTES = 1024 * 1024
let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4) {
    const length = buffer.readUInt32LE(0)
    if (length > MAX_FRAME_BYTES) {
      writeMessage({ id: null, ok: false, error: `frame de ${length} bytes excede o limite de ${MAX_FRAME_BYTES}; encerrando para o Chrome reiniciar` })
      process.exit(1)
    }
    if (buffer.length < 4 + length)
      return
    const body = buffer.subarray(4, 4 + length).toString('utf8')
    buffer = buffer.subarray(4 + length)
    let request
    try {
      request = JSON.parse(body)
    } catch {
      writeMessage({ id: null, ok: false, error: 'frame não é JSON' })
      continue
    }
    handle(request).then(writeMessage)
  }
})

// Chrome closing the pipe must not kill the gateway the user asked for: this process ends, the child keeps running.
process.stdin.on('end', () => process.exit(0))

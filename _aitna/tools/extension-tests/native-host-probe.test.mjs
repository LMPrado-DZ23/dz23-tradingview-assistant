// Malformed frames at the native host: it is the one component that can spawn a process, so it must survive bad input.
// Chrome caps messages, but a host that trusts the length prefix blindly can be told to wait for gigabytes.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const HOST = join(ROOT, 'native-host', 'host.mjs')

function frame (payload) {
  const body = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

function startHost (home) {
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, USERPROFILE: home, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const timer = setTimeout(() => { try { child.kill() } catch { /* já morreu */ } }, 15_000)
  return { child, stop: () => { clearTimeout(timer); try { child.kill() } catch { /* já morreu */ } } }
}

function collect (child) {
  const state = { buffer: Buffer.alloc(0), messages: [], stderr: '', exited: false }
  child.stdout.on('data', (chunk) => {
    state.buffer = Buffer.concat([state.buffer, chunk])
    for (;;) {
      if (state.buffer.length < 4)
        return
      const length = state.buffer.readUInt32LE(0)
      if (state.buffer.length < 4 + length)
        return
      try {
        state.messages.push(JSON.parse(state.buffer.subarray(4, 4 + length).toString('utf8')))
      } catch {
        state.messages.push({ unparsable: true })
      }
      state.buffer = state.buffer.subarray(4 + length)
    }
  })
  child.stderr.on('data', (chunk) => { state.stderr += chunk })
  child.on('exit', () => { state.exited = true })
  return state
}

const waitFor = (predicate, timeoutMs = 5000) => new Promise((resolve) => {
  const started = Date.now()
  const tick = () => {
    if (predicate())
      return resolve(true)
    if (Date.now() - started > timeoutMs)
      return resolve(false)
    setTimeout(tick, 25)
  }
  tick()
})

test('JSON inválido no frame é recusado e o host continua vivo', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-host-'))
  const { child, stop } = startHost(home)
  const state = collect(child)
  try {
    child.stdin.write(frame('{isso não é json'))
    const answered = await waitFor(() => state.messages.length >= 1)
    assert.equal(answered, true, 'o host precisa responder algo, não ficar mudo')
    const answer = state.messages[0]
    assert.equal(answer.ok, false, 'recusa explícita')
    assert.match(String(answer.error ?? ''), /json|parse|inválid/i)
    // e continua respondendo
    child.stdin.write(frame({ id: 99, type: 'status' }))
    const alive = await waitFor(() => state.messages.some((message) => message.id === 99))
    assert.equal(alive, true, 'o host segue vivo depois do frame inválido')
    assert.equal(state.exited, false)
  } finally {
    stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('frame truncado não derruba o host: ele espera o resto', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-host-'))
  const { child, stop } = startHost(home)
  const state = collect(child)
  try {
    const full = frame({ id: 7, type: 'status' })
    child.stdin.write(full.subarray(0, 6)) // cabeçalho + 2 bytes de corpo
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(state.exited, false, 'meio frame não pode matar o processo')
    assert.equal(state.messages.length, 0, 'nada é respondido antes de completar o frame')
    child.stdin.write(full.subarray(6))
    const answered = await waitFor(() => state.messages.some((message) => message.id === 7))
    assert.equal(answered, true, 'ao completar, responde normalmente')
  } finally {
    stop()
    rmSync(home, { recursive: true, force: true })
  }
})

test('comprimento absurdo no cabeçalho é recusado e o host encerra', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-host-'))
  const { child, stop } = startHost(home)
  const state = collect(child)
  try {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(0x7fffffff, 0) // ~2 GB prometidos, nenhum byte enviado
    child.stdin.write(header)
    const answered = await waitFor(() => state.messages.length >= 1, 5000)
    assert.equal(answered, true, 'o host precisa recusar, não esperar para sempre')
    assert.equal(state.messages[0].ok, false)
    assert.match(String(state.messages[0].error ?? ''), /excede o limite/)
    const exited = await waitFor(() => state.exited, 3000)
    assert.equal(exited, true, 'encerra para o Chrome reiniciar em vez de ficar travado')
  } finally {
    stop()
    rmSync(home, { recursive: true, force: true })
  }
})

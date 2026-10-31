// The native host is exercised for real: a child process, framed stdio, a fake gateway it starts and stops.
// No Chrome involved, so this runs in CI; the extension side is covered by the E2E with a stub.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const HOST = join(here, '../../../native-host/host.mjs')
const PORT = 8898

const FAKE_GATEWAY = `import { createServer } from 'node:http'
const port = Number(process.env.DZ23_GATEWAY_PORT ?? 8898)
createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ protocol: 1, status: 'ok', providers: 1, configured: 0 }))
    return
  }
  response.writeHead(404).end('{}')
}).listen(port, '127.0.0.1')
`

function startHost (gatewayPath, port, home = process.env.USERPROFILE) {
  const child = spawn(process.execPath, [HOST], {
    env: { ...process.env, DZ23_HOST_GATEWAY: gatewayPath, DZ23_GATEWAY_PORT: String(port), USERPROFILE: home, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let buffer = Buffer.alloc(0)
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length)
        return
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'))
      buffer = buffer.subarray(4 + length)
      const resolve = pending.get(message.id)
      if (resolve) { pending.delete(message.id); resolve(message) }
    }
  })
  let nextId = 1
  const send = (type) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, resolve)
    const payload = Buffer.from(JSON.stringify({ id, type }), 'utf8')
    const header = Buffer.alloc(4)
    header.writeUInt32LE(payload.length, 0)
    child.stdin.write(Buffer.concat([header, payload]))
    setTimeout(() => reject(new Error(`sem resposta para ${type}`)), 20_000).unref()
  })
  return { child, send }
}

test('host: status, start, status, stop, status', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dz23-host-'))
  const fake = join(work, 'fake-gateway.mjs')
  writeFileSync(fake, FAKE_GATEWAY)
  const { child, send } = startHost(fake, PORT)
  try {
    const idle = await send('status')
    assert.equal(idle.ok, true)
    assert.equal(idle.running, false, 'sem gateway no ar')
    assert.equal(idle.owned, false)

    const started = await send('start')
    assert.equal(started.ok, true)
    assert.equal(started.started, true)
    assert.equal(started.health.reachable, true, 'o host só responde depois do health real')

    const running = await send('status')
    assert.equal(running.running, true)
    assert.equal(running.owned, true, 'o processo é filho do host')
    assert.equal(running.health.protocol, 1)

    const again = await send('start')
    assert.equal(again.already, true, 'não inicia duas vezes')

    const stopped = await send('stop')
    assert.equal(stopped.ok, true)
    assert.equal(stopped.stopped, true)

    const after = await send('status')
    assert.equal(after.running, false)
  } finally {
    child.stdin.end()
    child.kill()
    await new Promise((resolve) => child.on('exit', resolve))
    rmSync(work, { recursive: true, force: true })
  }
})

test('o gateway iniciado pelo host sobrevive ao fim do host', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dz23-host2-'))
  const fake = join(work, 'fake-gateway.mjs')
  writeFileSync(fake, FAKE_GATEWAY)
  const { child, send } = startHost(fake, 8895)
  const started = await send('start')
  assert.equal(started.ok, true)
  // fecha o canal como o Chrome faria; sem kill, para provar que o filho é independente
  child.stdin.end()
  await new Promise((resolve) => child.on('exit', resolve))
  await new Promise((resolve) => setTimeout(resolve, 700))
  let alive = false
  try {
    const response = await fetch('http://127.0.0.1:8895/health')
    alive = response.ok
  } catch {
    alive = false
  }
  assert.equal(alive, true, 'o gateway continua respondendo depois que o host sai')
  // limpa o processo que ficou de pé
  try {
    const { execFileSync } = await import('node:child_process')
    const output = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-NetTCPConnection -LocalPort 8895 -State Listen).OwningProcess"], { encoding: 'utf8' })
    const pid = Number(output.trim().split(/\s+/).pop())
    if (Number.isInteger(pid) && pid > 0)
      execFileSync('taskkill', ['/PID', String(pid), '/F'])
  } catch {
    /* já saiu */
  }
  rmSync(work, { recursive: true, force: true })
})

test('host: comando de gateway inexistente falha com motivo, sem travar', async () => {
  const { child, send } = startHost(join(tmpdir(), 'nao-existe-9721.mjs'), 8897)
  try {
    const started = await send('start')
    assert.equal(started.ok, false)
    assert.match(started.reason, /não encontrado/)
    const addressed = await send('diagnose')
    assert.equal(addressed.ok, false)
    const fileCheck = addressed.checks.find((check) => check.name === 'gateway.file')
    assert.equal(fileCheck.ok, false)
  } finally {
    child.stdin.end()
    child.kill()
    await new Promise((resolve) => child.on('exit', resolve))
  }
})

test('host: tipo desconhecido responde erro e continua vivo', async () => {
  const { child } = startHost(join(tmpdir(), 'x.mjs'), 8896)
  try {
    const response = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      child.stdout.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length < 4)
          return
        const length = buffer.readUInt32LE(0)
        if (buffer.length < 4 + length)
          return
        resolve(JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')))
      })
      const payload = Buffer.from(JSON.stringify({ id: 9, type: 'voar' }), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(payload.length, 0)
      child.stdin.write(Buffer.concat([header, payload]))
      setTimeout(() => reject(new Error('sem resposta')), 10_000).unref()
    })
    assert.equal(response.ok, false)
    assert.match(response.error, /desconhecido/)
    assert.equal(child.exitCode, null, 'o host continua atendendo')
  } finally {
    child.stdin.end()
    child.kill()
    await new Promise((resolve) => child.on('exit', resolve))
  }
})

test('entrega o token que o gateway gerou, sem exigir cópia manual', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-home-'))
  mkdirSync(join(home, '.dz23'), { recursive: true })
  writeFileSync(join(home, '.dz23', 'gateway-token'), '  token-do-teste  \n')
  const host = startHost(process.execPath, 9, home)
  try {
    const answer = await host.send('token')
    assert.equal(answer.ok, true)
    assert.equal(answer.token, 'token-do-teste', 'devolve o token aparado')
    // o token não pode vazar no status/log que a UI mostra
    const status = await host.send('status')
    const asText = JSON.stringify(status)
    assert.equal(asText.includes('token-do-teste'), false, 'status não carrega o token')
  } finally {
    host.child?.kill?.()
    rmSync(home, { recursive: true, force: true })
  }
})

test('sem token gerado, o host diz o que falta em vez de inventar', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-home-vazio-'))
  const host = startHost(process.execPath, 9, home)
  try {
    const answer = await host.send('token')
    assert.equal(answer.ok, false)
    assert.match(String(answer.error), /sem token/)
  } finally {
    host.child?.kill?.()
    rmSync(home, { recursive: true, force: true })
  }
})

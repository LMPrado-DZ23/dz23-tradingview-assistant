// The launcher Chrome actually executes: native-host/dz23-host.cmd.
//
// Every other host test spawns node directly, which proves the host works but says nothing about the .cmd — and the .cmd
// is where Windows quoting goes wrong (a path with spaces, a node that moved). This drives the real file the way Chrome
// does: `cmd.exe /c <launcher>` with the 4-byte length framing on stdin and stdout.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const LAUNCHER = join(ROOT, 'native-host', 'dz23-host.cmd')

function frame (message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(payload.length, 0)
  return Buffer.concat([header, payload])
}

function readFrame (buffer) {
  if (buffer.length < 4)
    return null
  const length = buffer.readUInt32LE(0)
  if (buffer.length < 4 + length)
    return null
  return { message: JSON.parse(buffer.subarray(4, 4 + length).toString('utf8')), rest: buffer.subarray(4 + length) }
}

function askLauncher (request, home) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/c', LAUNCHER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, USERPROFILE: home, HOME: home },
    })
    let buffer = Buffer.alloc(0)
    let settled = false
    const finish = (value) => {
      if (settled)
        return
      settled = true
      try { child.kill() } catch { /* já morreu */ }
      resolve(value)
    }
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = readFrame(buffer)
      if (parsed)
        finish({ ok: true, message: parsed.message })
    })
    child.stderr.on('data', (chunk) => finish({ ok: false, error: String(chunk).slice(0, 300) }))
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.stdin.write(frame(request))
    setTimeout(() => finish({ ok: false, error: 'sem resposta do launcher em 10s' }), 10_000)
  })
}

test('o launcher .cmd existe, aponta para o node atual e para o host.mjs', { skip: process.platform !== 'win32' }, () => {
  assert.ok(existsSync(LAUNCHER), 'o launcher precisa existir (rode node native-host/install.mjs)')
  const content = readFileSync(LAUNCHER, 'utf8')
  assert.match(content, /node\.exe/i, 'chama um node.exe com caminho absoluto (o PATH do Chrome é outro)')
  assert.match(content, /host\.mjs/, 'aponta para o host.mjs')
  const nodePath = content.match(/"([^"]*node\.exe)"/i)?.[1]
  assert.ok(nodePath && existsSync(nodePath), `o node do launcher existe: ${nodePath}`)
  const hostPath = content.match(/"([^"]*host\.mjs)"/i)?.[1]
  assert.ok(hostPath && existsSync(hostPath), `o host do launcher existe: ${hostPath}`)
})

test('responde pelo launcher real, com o enquadramento que o Chrome usa', { skip: process.platform !== 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-launcher-'))
  mkdirSync(join(home, '.dz23'), { recursive: true })
  writeFileSync(join(home, '.dz23', 'gateway-token'), 'token-pelo-launcher\n')
  try {
    const answer = await askLauncher({ id: 7, type: 'token' }, home)
    assert.equal(answer.ok, true, `falhou: ${answer.error}`)
    assert.equal(answer.message.id, 7, 'devolve o id da requisição')
    assert.equal(answer.message.ok, true)
    assert.equal(answer.message.token, 'token-pelo-launcher')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('tipo desconhecido pelo launcher responde erro e continua vivo', { skip: process.platform !== 'win32' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'dz23-launcher-bad-'))
  try {
    const answer = await askLauncher({ id: 8, type: 'nao-existe' }, home)
    assert.equal(answer.ok, true, `falhou: ${answer.error}`)
    assert.equal(answer.message.ok, false)
    assert.match(String(answer.message.error), /desconhecido/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

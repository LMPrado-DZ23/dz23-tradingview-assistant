// Accessibility audit of the settings page, driven by CDP like the other E2Es: labels, live regions, keyboard focus and
// measured contrast. Fails on a real defect, not on style.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/extension'
const CHROME = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/_aitna/.browser/chrome/win64-155.0.8059.39/chrome-win64/chrome.exe'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }

const steps = []
const step = (name, ok, detail) => {
  steps.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  console.log(steps.at(-1))
}

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
  try {
    const body = readFileSync(join(ROOT, path === '/' ? 'settings/index.html' : path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const profile = mkdtempSync(join(tmpdir(), 'dz23-a11y-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
const wsUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('sem devtools')), 20_000)
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk.toString()
    const match = buffer.match(/(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)
    if (match) {
      clearTimeout(timer)
      resolve(match[1])
    }
  })
})
const socket = new WebSocket(wsUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let nextId = 1
const pending = new Map()
socket.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) {
    pending.get(payload.id)(payload.result ?? payload.error)
    pending.delete(payload.id)
  }
})
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = async (expression, sessionId) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (!response || !response.result)
    throw new Error(`Runtime.evaluate falhou: ${JSON.stringify(response).slice(0, 200)}`)
  if (response.exceptionDetails)
    throw new Error(`exceção: ${response.exceptionDetails.text} ${response.exceptionDetails.exception?.description ?? ''}`)
  return response.result.value
}
const key = (sessionId, keyName, code, vk) => send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId)
  .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }, sessionId))

try {
  const target = await send('Target.createTarget', { url: `${base}/settings/index.html` })
  const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sessionId = attach.sessionId
  await send('Runtime.enable', {}, sessionId)
  await send('Page.enable', {}, sessionId)
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__storage = {}
      window.chrome = {
        storage: { local: {
          get: (key) => Promise.resolve({ [key]: window.__storage[key] }),
          set: (values) => { Object.assign(window.__storage, values); return Promise.resolve() },
          remove: (key) => { delete window.__storage[key]; return Promise.resolve() },
        } },
        runtime: { getURL: (path) => path, sendMessage: (_m, callback) => callback?.({ ok: false, reason: 'sem native host' }), lastError: null, onMessage: { addListener () {} } },
        tabs: { create () {}, query: (_i, callback) => callback?.([]) },
      }
    `,
  }, sessionId)
  await send('Page.navigate', { url: `${base}/settings/index.html` }, sessionId)
  await wait(1200)

  // 1. nome acessível em todo botão
  const buttons = await evaluate(`[...document.querySelectorAll('button')].filter((node) => node.offsetParent !== null).map((node) => ({ text: (node.textContent ?? '').trim(), label: node.getAttribute('aria-label'), title: node.getAttribute('title') }))`, sessionId)
  const unnamed = buttons.filter((node) => !node.text && !node.label && !node.title)
  step('todo botão visível tem nome acessível', unnamed.length === 0, JSON.stringify(unnamed).slice(0, 120))

  // 2. rótulo em todo campo
  const fields = await evaluate(`[...document.querySelectorAll('input, select, textarea')].map((node) => ({ id: node.id, labelled: Boolean(node.closest('label')) || Boolean(node.getAttribute('aria-label')) || Boolean(node.getAttribute('aria-labelledby')) }))`, sessionId)
  const unlabelled = fields.filter((node) => !node.labelled)
  step('todo campo tem rótulo', unlabelled.length === 0, JSON.stringify(unlabelled).slice(0, 120))

  // 3. estados anunciados
  const live = await evaluate(`[...document.querySelectorAll('[role="status"], [aria-live]')].map((node) => node.id || node.className)`, sessionId)
  step('mensagens de estado são live regions', live.length >= 4, `${live.length}: ${live.slice(0, 4).join(', ')}`)

  // 4. Tab alcança controle e o anel de foco é visível
  await evaluate(`document.body.focus(); document.activeElement?.blur?.()`, sessionId)
  await key(sessionId, 'Tab', 'Tab', 9)
  await wait(150)
  const focused = await evaluate(`(() => { const active = document.activeElement; if (!active || active === document.body) return { tag: null }; const style = getComputedStyle(active); return { tag: active.tagName, id: active.id, outline: style.outlineStyle + ' ' + style.outlineWidth, visible: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 1 } })()`, sessionId)
  step('Tab move o foco e o anel é visível', focused.tag !== null && focused.visible, JSON.stringify(focused))

  // 5. ordem de tabulação não começa num controle oculto e há mais de um parada
  const order = await evaluate(`[...document.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href]')].filter((node) => node.offsetParent !== null).length`, sessionId)
  step('há controles focáveis suficientes', order >= 8, `${order} controles`)

  // 6. contraste medido em texto e controles amostrados
  const contrast = await evaluate(`(() => {
    const parse = (color) => { const match = color.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/); return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null }
    const luminance = ([r, g, b]) => {
      const channel = (value) => { const n = value / 255; return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4 }
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    }
    const background = (node) => {
      let current = node
      while (current) {
        const style = getComputedStyle(current)
        const color = parse(style.backgroundColor)
        if (color && style.backgroundColor !== 'rgba(0, 0, 0, 0)') return color
        current = current.parentElement
      }
      return [10, 14, 19]
    }
    const bad = []
    for (const node of [...document.querySelectorAll('h1, h2, h3, p, label, span.status, button')].slice(0, 80)) {
      const text = (node.textContent ?? '').trim()
      if (!text || node.offsetParent === null) continue
      const foreground = parse(getComputedStyle(node).color)
      if (!foreground) continue
      const l1 = luminance(foreground)
      const l2 = luminance(background(node))
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
      const style = getComputedStyle(node)
      const large = parseFloat(style.fontSize) >= 18.66 || (parseFloat(style.fontWeight) >= 700 && parseFloat(style.fontSize) >= 14)
      const minimum = large ? 3 : 4.5
      if (ratio < minimum) bad.push({ text: text.slice(0, 28), ratio: Number(ratio.toFixed(2)), minimum })
    }
    return bad
  })()`, sessionId)
  step('contraste AA em texto e controles amostrados', contrast.length === 0, JSON.stringify(contrast).slice(0, 200))

  const failures = steps.filter((line) => line.startsWith('FAIL'))
  console.log(JSON.stringify({ passed: failures.length === 0, steps: steps.length, failures: failures.map((line) => line.split(' — ')[0].replace('FAIL ', '')) }))
  await send('Browser.close')
  socket.close()
  await new Promise((resolve) => chrome.on('exit', resolve).once?.('exit', resolve) ?? resolve())
  server.close()
  rmSync(profile, { recursive: true, force: true })
  process.exit(failures.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`erro: ${error?.message ?? error}`)
  try { await send('Browser.close') } catch { /* já fechou */ }
  server.close()
  process.exit(1)
}

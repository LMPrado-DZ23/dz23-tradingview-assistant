// Dynamic page budget: loads the real extension pages in headless Chrome and measures what the user waits for.
//
//   npm run perf:pages
//
// Reported per page: navigation loadEventEnd, DOM nodes after settle and bytes transferred (CDP Network). Budgets are
// guard rails around today's numbers — a page that suddenly ships the 3D chart library would blow them.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromePath, EXT_DIR } from '../e2e/chrome.mjs'

const ROOT = EXT_DIR
const CHROME = chromePath()
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' }

const BUDGETS = { loadMs: 1500, nodes: 1200, bytesKb: 900 }

const PAGES = [
  { name: 'configurações', url: '/settings/index.html', ready: '#watchlistCards' },
  { name: 'painel (copilot)', url: '/copilot/index.html', ready: '#messages' },
]

const steps = []
const step = (name, ok, detail) => {
  steps.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
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

const profile = mkdtempSync(join(tmpdir(), 'dz23-perf-'))
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
let transfers = []
socket.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) {
    pending.get(payload.id)(payload.result ?? payload.error)
    pending.delete(payload.id)
    return
  }
  if (payload.method === 'Network.responseReceived')
    transfers.push({ url: payload.params.response.url, bytes: payload.params.response.encodedDataLength ?? 0 })
  else if (payload.method === 'Network.loadingFinished')
    transfers.push({ url: '', bytes: payload.params.encodedDataLength ?? 0 })
})
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
})
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = async (expression, sessionId) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (!response?.result)
    throw new Error(`Runtime.evaluate falhou: ${JSON.stringify(response).slice(0, 200)}`)
  return response.result.value
}

try {
  for (const page of PAGES) {
    const target = await send('Target.createTarget', { url: 'about:blank' })
    const attach = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const sessionId = attach.sessionId
    await send('Runtime.enable', {}, sessionId)
    await send('Page.enable', {}, sessionId)
    await send('Network.enable', {}, sessionId)
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        window.__storage = {}
        window.chrome = {
          storage: { local: {
            get: (key) => Promise.resolve({ [key]: window.__storage[key] }),
            set: (values) => { Object.assign(window.__storage, values); return Promise.resolve() },
            remove: (key) => { delete window.__storage[key]; return Promise.resolve() },
          } },
          runtime: { getURL: (p) => p, sendMessage: (_m, cb) => cb?.({ ok: false, reason: 'perf' }), lastError: null, onMessage: { addListener () {} }, connect: () => ({ postMessage () {}, disconnect () {}, onMessage: { addListener () {} }, onDisconnect: { addListener () {} } }) },
          tabs: { query: (_i, cb) => cb?.([{ id: 1, url: 'https://www.tradingview.com/chart/abc/', active: true }]), sendMessage: (_i, _m, cb) => cb?.({ ok: false }), create () {} },
          windows: { getCurrent: (cb) => cb?.({ id: 1 }) },
        }
      `,
    }, sessionId)

    transfers = []
    await send('Page.navigate', { url: `${base}${page.url}` }, sessionId)
    await wait(1500)

    const metrics = await evaluate(`(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      return {
        loadMs: nav ? Math.round(nav.loadEventEnd || nav.duration || 0) : Math.round(performance.now()),
        nodes: document.getElementsByTagName('*').length,
        readyState: document.readyState,
        hasMarker: Boolean(document.querySelector('${page.ready}')),
      }
    })()`, sessionId)

    const bytes = transfers.reduce((total, item) => total + (item.bytes || 0), 0)
    const kb = Math.round(bytes / 1024)
    const detail = JSON.stringify({ loadMs: metrics.loadMs, nodes: metrics.nodes, bytesKb: kb, ready: metrics.hasMarker })
    step(`${page.name}: renderiza a tela`, metrics.hasMarker && metrics.readyState !== 'loading', detail)
    step(`${page.name}: carrega em ${BUDGETS.loadMs} ms`, metrics.loadMs <= BUDGETS.loadMs, `${metrics.loadMs} ms`)
    step(`${page.name}: DOM enxuto (${BUDGETS.nodes} nós)`, metrics.nodes <= BUDGETS.nodes, `${metrics.nodes} nós`)
    step(`${page.name}: transferência (${BUDGETS.bytesKb} KB)`, kb <= BUDGETS.bytesKb, `${kb} KB`)
  }

  const failures = steps.filter((item) => !item.ok)
  console.log(JSON.stringify({ passed: failures.length === 0, steps: steps.length, failures: failures.map((item) => item.name), budgets: BUDGETS }))
  await send('Browser.close')
  socket.close()
  server.close()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    // perfil temporário pode continuar travado pelo processo do Chrome por alguns segundos; não invalida a medição
  }
  process.exit(failures.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`erro: ${error?.message ?? error}`)
  try { await send('Browser.close') } catch { /* já fechou */ }
  server.close()
  process.exit(1)
}

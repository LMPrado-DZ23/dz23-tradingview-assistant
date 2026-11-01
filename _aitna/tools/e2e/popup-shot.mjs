// Screenshot the popup in Chrome at its real size, so the unified theme is judged by the rendered page, not the CSS.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromePath } from './chrome.mjs'

const ROOT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/extension'
const CHROME = chromePath()
const REPO_OUT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/docs/screenshots'
// Escrever em docs/ durante a verificação suja a árvore a cada rodada. Só grava ali com DZ23_WRITE_SCREENSHOTS=1.
const OUT = process.env.DZ23_WRITE_SCREENSHOTS === '1' ? REPO_OUT : join(tmpdir(), 'dz23-evidence')
mkdirSync(OUT, { recursive: true })
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
  try {
    const body = readFileSync(join(ROOT, path === '/' ? 'popup/assistant.html' : path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const profile = mkdtempSync(join(tmpdir(), 'dz23-popup-'))
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
const wsUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('sem devtools')), 20_000)
  chrome.stderr.on('data', (chunk) => {
    buffer += chunk.toString()
    const match = buffer.match(/(ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/\S+)/)
    if (match) { clearTimeout(timer); resolve(match[1]) }
  })
})
const socket = new WebSocket(wsUrl)
await new Promise((resolve) => socket.addEventListener('open', resolve))
let nextId = 1
const pending = new Map()
const errors = []
socket.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) { pending.get(payload.id)(payload.result ?? payload.error); pending.delete(payload.id) }
  else if (payload.method === 'Runtime.exceptionThrown') errors.push(payload.params.exceptionDetails?.exception?.description ?? payload.params.exceptionDetails?.text)
})
const send = (method, params = {}, sessionId) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })) })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = async (expression, sessionId) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}
const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 600, deviceScaleFactor: 1, mobile: false }, sessionId)
await send('Page.navigate', { url: `${base}/popup/assistant.html` }, sessionId)
await wait(1500)

const look = await evaluate(`({
  background: getComputedStyle(document.body).backgroundColor,
  color: getComputedStyle(document.body).color,
  font: getComputedStyle(document.body).fontFamily,
  brand: document.querySelector('.brand')?.textContent?.trim() ?? '',
  tabs: [...document.querySelectorAll('.tabs__links>a')].length,
  overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
  height: document.documentElement.scrollHeight,
})`, sessionId)
console.log('popup:', JSON.stringify(look))
console.log('erros de JS:', errors.length ? errors.slice(0, 2) : 'nenhum')

const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(join(OUT, `${name}.png`), Buffer.from(data.data, 'base64'))
  console.log('shot:', name)
}
await shot('05-popup-dz23')
await evaluate(`document.querySelector('[data-tab="2"]').click()`, sessionId)
await wait(600)
await shot('06-popup-resultados')
socket.close()
chrome.kill()
await wait(400)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
server.close()

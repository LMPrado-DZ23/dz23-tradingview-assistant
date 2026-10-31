// Contrast and clipping audit for the popup: walks every visible text element in all five tabs, computes the WCAG
// contrast against its effective background and flags labels whose text is clipped. Run: node this-file
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/extension'
// Real translations, so the audit measures the strings the user reads
const catalog = JSON.parse(readFileSync(join(ROOT, '_locales/pt_BR/messages.json'), 'utf8'))
const catalogStub = Object.fromEntries(Object.entries(catalog).map(([key, value]) => [key, value.message ?? key]))
const chromeStub = `
try {
  const catalog = ${JSON.stringify(catalogStub)}
  window.chrome = window.chrome || {}
  window.chrome.i18n = { getMessage: (key) => catalog[key] ?? key, getUILanguage: () => 'pt-BR' }
  window.chrome.runtime = { lastError: null, getURL: (path) => path, sendMessage () {}, onMessage: { addListener () {} } }
  const tradingViewTab = { id: 1, index: 0, active: true, windowId: 1, url: 'https://www.tradingview.com/chart/BTCUSDT/', title: 'BINANCE:BTCUSDT 1h — TradingView' }
  window.chrome.tabs = {
    query: (info, callback) => callback?.([tradingViewTab]),
    sendMessage: (tabId, message, callback) => callback?.({ ok: true, observation: { rawSymbol: 'BINANCE:BTCUSDT', resolution: '60', source: 'page' } }),
    onUpdated: { addListener () {} },
  }
  const store = {}
  const area = { get: (keys, callback) => callback?.({}), set: (items, callback) => { Object.assign(store, items); callback?.() }, remove: (keys, callback) => callback?.() }
  window.chrome.storage = { local: area, sync: area, session: area, onChanged: { addListener () {} } }
} catch {}
`
const CHROME = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/_aitna/.browser/chrome/win64-155.0.8059.39/chrome-win64/chrome.exe'
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

const profile = mkdtempSync(join(tmpdir(), 'dz23-contrast-'))
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
const pageErrors = []
socket.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) { pending.get(payload.id)(payload.result ?? payload.error); pending.delete(payload.id) }
  else if (payload.method === 'Runtime.exceptionThrown') pageErrors.push(payload.params.exceptionDetails?.exception?.description ?? payload.params.exceptionDetails?.text)
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
await send('Page.addScriptToEvaluateOnNewDocument', { source: chromeStub }, sessionId)
await send('Page.navigate', { url: `${base}/popup/assistant.html` }, sessionId)
await wait(1500)

// Runs inside the page: contrast of every text node against the nearest opaque background, plus clipping
const auditExpression = `(() => {
  const parse = (value) => {
    const match = String(value).match(/rgba?\\(([^)]+)\\)/)
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number(part.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const luminance = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  const blend = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  })
  const backgroundOf = (element) => {
    let node = element
    let stack = []
    while (node && node !== document.documentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color && color.a > 0) { stack.push(color); if (color.a === 1) break }
      node = node.parentElement
    }
    let result = { r: 255, g: 255, b: 255, a: 1 }
    for (let index = stack.length - 1; index >= 0; index -= 1) result = blend(stack[index], result)
    return result
  }
  const ratio = (a, b) => {
    const first = luminance(a), second = luminance(b)
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
  }
  const offenders = []
  const seen = new Set()
  for (const element of document.querySelectorAll('body *')) {
    if (element.closest('#whatsNewBar')) continue
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const own = [...element.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim().length > 1)
    if (!own.length) continue
    const text = own.map((node) => node.textContent.trim()).join(' ').slice(0, 48)
    if (seen.has(text)) continue
    seen.add(text)
    const fg = parse(style.color)
    if (!fg) continue
    const bg = backgroundOf(element)
    const contrast = ratio(fg.a < 1 ? blend(fg, bg) : fg, bg)
    const clipped = element.scrollWidth > element.clientWidth + 1 && style.overflow !== 'visible'
    const path = element.tagName.toLowerCase() + (element.id ? '#' + element.id : '') + (element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\\s+/).join('.') : '')
    if (contrast < 3 || clipped)
      offenders.push({ path: path.slice(0, 70), text, contrast: Number(contrast.toFixed(2)), clipped, fg: style.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' })
  }
  return offenders
})()`

let total = 0
for (const tab of [1, 2, 3, 4, 5]) {
  await evaluate(`document.querySelector('[data-tab="${tab}"]').click()`, sessionId)
  await wait(500)
  const offenders = await evaluate(auditExpression, sessionId)
  total += offenders.length
  const measured = await evaluate('document.querySelectorAll("body *").length', sessionId)
  console.log(`\n=== aba ${tab}: ${offenders.length} problema(s) em ${measured} elementos ===`)
  for (const item of offenders.slice(0, 14))
    console.log(`  ${item.contrast.toFixed(2)}:1 ${item.clipped ? '[cortado] ' : ''}${item.path} — "${item.text}" (${item.fg} sobre ${item.bg})`)
  const data = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(join(OUT, `popup-tab-${tab}.png`), Buffer.from(data.data, 'base64'))
  if (tab === 1) await wait(0)
}
console.log(`\nTOTAL: ${total} problema(s)`)
console.log('erros de página:', pageErrors.length ? pageErrors.slice(0, 2) : 'nenhum')
socket.close()
chrome.kill()
await wait(400)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
server.close()
process.exitCode = total === 0 ? 0 : 1

// Bridge end-to-end: the REAL extension/content_scripts/chartBridge.js runs inside a page whose DOM is the one the
// shipped TradingView Remix extension reads (legend item + timeframes-menu + indicator rows after the first).
// Selectors, URL fallback, debounce, ping and the "no chart" path are the shipped code.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main'
const CHROME = `${ROOT}/_aitna/.browser/chrome/win64-155.0.8059.39/chrome-win64/chrome.exe`
const BRIDGE = readFileSync(`${ROOT}/extension/content_scripts/chartBridge.js`, 'utf8')

const work = mkdtempSync(join(tmpdir(), 'dz23-bridge-'))
const steps = []
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// The DOM shape Remix reads: legend items as siblings (first = symbol), the interval menu, and an indicator row.
const chart = (symbol, interval, indicators = []) => `
  <div class="chart-markup-table"><span class="symbol-info">${symbol}</span></div>
  <div data-name="timeframes-menu"><span class="text-GwQQdU8S">${interval}</span></div>
  <div id="legend">
    <div data-name="legend-source-item"><span class="titleLegendContainer-pane-OxVBiw8S">${symbol}</span></div>
    ${indicators.map((text) => `<div data-name="legend-source-item"><span class="titleLegendContainer-pane-OxVBiw8S">${text}</span></div>`).join('')}
  </div>`

const pageHtml = ({ symbol = 'BINANCE:BTCUSDT', interval = '1h', indicators = [], plain = false } = {}) => `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${plain ? 'TradingView — painel' : `${symbol} ${interval} — TradingView`}</title></head>
<body>
${plain ? '<div class="chart-markup-table"><p>sem gráfico</p></div>' : chart(symbol, interval, indicators)}
<script>
  window.__sent = []
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage (message, callback) { window.__sent.push(message); if (callback) callback() },
      onMessage: { addListener (listener) { window.__pingListener = listener } },
    },
  }
</script>
<script>${BRIDGE}</script>
</body></html>`

const server = createServer((request, response) => {
  const url = request.url
  let body
  if (url.startsWith('/chart/'))
    body = pageHtml({ plain: true }) // sem legenda: o símbolo tem de vir da URL
  else if (url.startsWith('/no-chart'))
    body = pageHtml({ plain: true })
  else if (url.startsWith('/chart-eth'))
    body = pageHtml({ symbol: 'BINANCE:ETHUSDT', interval: '15m', indicators: ['RSI 63.2', 'MACD'] })
  else
    body = pageHtml()
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(body)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const profile = join(work, 'profile')
mkdirSync(profile, { recursive: true })
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] })
const wsUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('sem devtools: ' + buffer)), 20_000)
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

await send('Page.navigate', { url: `${base}/chart` }, sessionId)
await wait(1200)
const first = await evaluate(`window.__sent.at(-1) ?? null`, sessionId)
step('lê símbolo da legenda e timeframe do menu de timeframes', first?.observation?.rawSymbol === 'BINANCE:BTCUSDT' && first?.observation?.resolution === '60', JSON.stringify(first?.observation))

await evaluate(`(() => {
  document.querySelector('#legend [data-name="legend-source-item"] .titleLegendContainer-pane-OxVBiw8S').textContent = 'BINANCE:ETHUSDT'
  document.querySelector('[data-name="timeframes-menu"] .text-GwQQdU8S').textContent = '15m'
})()`, sessionId)
await wait(900)
const second = await evaluate(`({ last: window.__sent.at(-1), count: window.__sent.length })`, sessionId)
step('troca de ativo e timeframe chega ao copiloto', second.last?.observation?.rawSymbol === 'BINANCE:ETHUSDT' && second.last?.observation?.resolution === '15', JSON.stringify(second.last?.observation))
step('debounce: uma mensagem por mudança', second.count === 2, `mensagens=${second.count}`)

await evaluate(`(() => {
  const legend = document.querySelector('#legend')
  legend.innerHTML += '<div data-name="legend-source-item"><span class="titleLegendContainer-pane-OxVBiw8S">RSI 63.2</span></div>'
})()`, sessionId)
await wait(900)
const withIndicator = await evaluate(`window.__sent.at(-1)`, sessionId)
const indicators = withIndicator?.observation?.indicators ?? []
step('indicador entra no contexto, sem corromper o valor', indicators.some((i) => i.name === 'RSI' && i.value === 63.2) && !indicators.some((i) => i.value === 2), JSON.stringify(indicators))

const ping = await evaluate(`new Promise((resolve) => { if (!window.__pingListener) return resolve({ missing: true }); window.__pingListener({ type: 'dz23:chart:ping' }, {}, resolve) })`, sessionId)
step('ping responde com a observação atual', ping?.observation?.rawSymbol === 'BINANCE:ETHUSDT' && ping?.observation?.resolution === '15', JSON.stringify(ping?.observation))

await send('Page.navigate', { url: `${base}/chart/ETHUSDT` }, sessionId)
await wait(1200)
const viaUrl = await evaluate(`window.__sent.at(-1) ?? null`, sessionId)
step('sem legenda, o símbolo vem da URL /chart/<symbol>/', viaUrl?.observation?.rawSymbol === 'ETHUSDT', JSON.stringify(viaUrl?.observation))

await send('Page.navigate', { url: `${base}/no-chart` }, sessionId)
await wait(1200)
const none = await evaluate(`window.__sent.at(-1) ?? null`, sessionId)
step('página sem gráfico reporta source none, sem inventar símbolo', none?.observation?.source === 'none' && none?.observation?.rawSymbol === null, JSON.stringify(none?.observation))

step('bridge não lança exceção em nenhum passo', errors.length === 0, JSON.stringify(errors.slice(0, 2)))
const passed = steps.every((s) => s.ok)
console.log(JSON.stringify({ passed, steps: steps.length, failures: steps.filter((s) => !s.ok).map((s) => s.name) }))
socket.close()
chrome.kill()
await wait(500)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
server.close()
process.exitCode = passed ? 0 : 1

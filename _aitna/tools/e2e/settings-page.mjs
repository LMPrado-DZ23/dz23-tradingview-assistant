// The single settings screen, exercised for real: a fake gateway with CORS, an in-memory chrome.storage, real clicks.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/extension'
const CHROME = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/_aitna/.browser/chrome/win64-155.0.8059.39/chrome-win64/chrome.exe'
const REPO_OUT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main/docs/screenshots'
// Escrever em docs/ durante a verificação suja a árvore a cada rodada. Só grava ali com DZ23_WRITE_SCREENSHOTS=1.
const OUT = process.env.DZ23_WRITE_SCREENSHOTS === '1' ? REPO_OUT : join(tmpdir(), 'dz23-evidence')
mkdirSync(OUT, { recursive: true })
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }

const steps = []
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// ---- fake gateway: health + providers + diagnose, CORS open so the page's origin can call it
const fakePort = 8901
const fake = createServer((request, response) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' }
  if (request.method === 'OPTIONS') { response.writeHead(204, cors).end(); return }
  const json = (body) => response.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body))
  if (request.url === '/health') return json({ protocol: 1, status: 'ok', providers: 2, configured: 1 })
  if (request.url === '/providers' && !request.headers.authorization) { response.writeHead(401, cors).end('{}'); return }
  if (request.url === '/providers') return json({ protocol: 1, providers: [{ id: 'deepseek', label: 'DeepSeek', configured: true, models: ['deepseek-chat'] }, { id: 'openai', label: 'OpenAI', configured: false, models: ['gpt-4o-mini'] }] })
  if (request.url === '/diagnose') return json({ protocol: 1, provider: 'deepseek', ok: true, checks: [{ name: 'auth', ok: true, detail: 'ok' }] })
  if (request.url === '/usage') return json({ protocol: 1, window: 2, limit: 200, providers: {
    deepseek: { attempts: 2, ok: 1, failed: 1, totalMs: 900, averageMs: 450, inputTokens: 30, outputTokens: 20, lastError: 'timeout' },
    ollama: { attempts: 1, ok: 1, failed: 0, totalMs: 40, averageMs: 40, inputTokens: 5, outputTokens: 5, lastError: null },
  }, last: { at: new Date().toISOString(), provider: 'ollama', ok: true } })
  response.writeHead(404, cors).end('{}')
})
await new Promise((resolve) => fake.listen(fakePort, '127.0.0.1', resolve))

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

const profile = mkdtempSync(join(tmpdir(), 'dz23-settings-'))
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
  else if (payload.method === 'Runtime.consoleAPICalled' && payload.params.type === 'error') errors.push(payload.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 160))
})
const send = (method, params = {}, sessionId) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })) })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = async (expression, sessionId) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (!response || !response.result)
    throw new Error('Runtime.evaluate falhou: ' + JSON.stringify(response).slice(0, 200))
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

const chromeStub = `
try {
  window.chrome = window.chrome || {}
  window.chrome.runtime = { lastError: null, getURL: (path) => path, sendMessage: (message, respond) => respond?.({ ok: false, reason: 'teste' }), onMessage: { addListener () {} } }
  const store = {}
  window.__storage = store
  const area = {
    get: (keys, callback) => {
      if (typeof keys === 'string') return callback?.({ [keys]: store[keys] })
      callback?.({ ...store })
    },
    set: (items, callback) => { Object.assign(store, items); callback?.() },
    remove: (keys, callback) => { for (const key of [].concat(keys)) delete store[key]; callback?.() },
  }
  window.chrome.storage = { local: area, sync: area, onChanged: { addListener () {} } }
  window.chrome.tabs = { create () {}, query: (info, callback) => callback?.([]) }
  // candles sintéticos: 60 velas crescentes, para RSI e preço existirem (o teste é sintético e está rotulado)
  const realFetch = window.fetch
  window.fetch = (url, options) => String(url).includes('binance.com')
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(Array.from({ length: 60 }, (_, index) => [(index + 1) * 60000, String(100 + index), String(101 + index), String(99 + index), String(100.5 + index), String(10 + index)])) })
    : realFetch(url, options)
} catch (error) { console.error('stub falhou', error) }
`

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1100, deviceScaleFactor: 1, mobile: false }, sessionId)
await send('Page.addScriptToEvaluateOnNewDocument', { source: chromeStub }, sessionId)
await send('Page.navigate', { url: `${base}/settings/index.html` }, sessionId)
await wait(1600)

const boot = await evaluate(`({
  title: document.querySelector('h1')?.textContent ?? '',
  sections: document.querySelectorAll('section').length,
  version: document.querySelector('#diagVersion')?.textContent ?? '',
  migration: document.querySelector('#diagMigration')?.textContent ?? '',
})`, sessionId)
step('tela carrega com as seções e o registro', /Configurações/.test(boot.title) && boot.sections >= 5 && boot.version === 'v1', JSON.stringify(boot))

// aponta para o gateway falso e autentica
await evaluate(`(() => {
  document.querySelector('#gatewayUrl').value = 'http://127.0.0.1:${fakePort}'
  document.querySelector('#gatewayToken').value = 'token-de-teste'
  document.querySelector('#user').value = 'ana'
})()`, sessionId)
await evaluate(`document.querySelector('#test').click()`, sessionId)
await wait(1200)
const tested = await evaluate(`document.querySelector('#gatewayStatus').textContent`, sessionId)
step('testar conexão fala com o gateway e conta provedores', /gateway ok · 1 provedor/.test(tested), tested)

await evaluate(`document.querySelector('#save').click()`, sessionId)
await wait(1200)
const saved = await evaluate(`window.__storage['dz23.config.v1'] ? JSON.stringify(window.__storage['dz23.config.v1']) : 'null'`, sessionId)
const parsed = saved === 'null' ? null : JSON.parse(saved)
step('salvar grava no registro único', Boolean(parsed) && parsed.gateway.url === `http://127.0.0.1:${fakePort}` && parsed.user === 'ana' && parsed.gateway.token === 'token-de-teste', String(saved).slice(0, 160))

const providers = await evaluate(`[...document.querySelectorAll('.provider .name')].map((node) => node.textContent)`, sessionId)
step('lista de provedores renderizada a partir do gateway', providers.includes('DeepSeek') && providers.includes('OpenAI'), JSON.stringify(providers))

const diag = await evaluate(`document.querySelector('#diagToken').textContent`, sessionId)
step('diagnóstico mostra o estado do token', /pareado/.test(diag), diag)

// --- watchlists: criar, adicionar e avaliar ---
await evaluate(`(() => { document.querySelector('#newListName').value = 'cripto'; document.querySelector('#newListSymbols').value = 'BTCUSDT, ETHUSDT'; document.querySelector('#createList').click() })()`, sessionId)
await wait(900)
const lists = await evaluate(`({ cards: document.querySelectorAll('#watchlistCards .board-card').length, chips: [...document.querySelectorAll('#watchlistCards .chip-symbol')].map((node) => node.textContent.replace('×', '').trim()) })`, sessionId)
step('watchlist cria lista com símbolos', lists.cards >= 1 && lists.chips.includes('BTCUSDT') && lists.chips.includes('ETHUSDT'), JSON.stringify(lists))

await evaluate(`document.querySelector('#rankWatchlist').click()`, sessionId)
await wait(3000)
const ranking = await evaluate(`({ rows: document.querySelectorAll('#rankingResult .board-row').length, status: document.querySelector('#watchlistStatus').textContent, text: document.querySelector('#rankingResult').textContent })`, sessionId)
step('ranking avalia oportunidades com a regra declarada', ranking.rows >= 2 && /tendência/.test(ranking.text) && /score/.test(ranking.text) && /não é recomendação/.test(ranking.text), JSON.stringify(ranking).slice(0, 180))

// --- alertas: criar e avaliar (dispara porque o preço sintético sobe) ---
await evaluate(`(() => { document.querySelector('#alertSymbol').value = 'BTCUSDT'; document.querySelector('#alertType').value = 'price_above'; document.querySelector('#alertValue').value = '100'; document.querySelector('#createAlert').click() })()`, sessionId)
await wait(900)
const created = await evaluate(`({ cards: document.querySelectorAll('#alertCards .board-card').length })`, sessionId)
step('alerta criado e listado', created.cards >= 1, JSON.stringify(created))

await evaluate(`document.querySelector('#evaluateAlerts').click()`, sessionId)
await wait(3000)
const evaluated = await evaluate(`({ text: document.querySelector('#alertResult').textContent, badge: [...document.querySelectorAll('#alertCards .pill')].map((node) => node.textContent) })`, sessionId)
step('avaliação dispara o alerta e mostra o escopo', /DISPAROU BTCUSDT price_above 100/.test(evaluated.text) && /não são alertas do TradingView/.test(evaluated.text) && evaluated.badge.includes('fired'), JSON.stringify(evaluated).slice(0, 200))

// --- editar o alerta: mudar o limite re-arma e é o que fica gravado ---
await evaluate(`[...document.querySelectorAll('#alertCards .board-head button')].find((node) => node.textContent.trim() === 'editar').click()`, sessionId)
await wait(400)
const editor = await evaluate(`({ campos: document.querySelectorAll('#alertCards input').length, valor: document.querySelector('#alertCards input[type=number]')?.value ?? null })`, sessionId)
step('editor de alerta abre com o valor atual', editor.campos >= 2 && editor.valor === '100', JSON.stringify(editor))
await evaluate(`(() => { const input = document.querySelector('#alertCards input[type=number]'); input.value = '250'; [...document.querySelectorAll('#alertCards button')].find((node) => node.textContent.trim() === 'salvar').click() })()`, sessionId)
await wait(900)
const edited = await evaluate(`(() => { const rules = window.__storage['dz23.config.v1']?.alerts?.rules ?? []; return { value: rules[0]?.value ?? null, state: rules[0]?.state ?? null, cardText: document.querySelector('#alertCards .board-head strong')?.textContent ?? null } })()`, sessionId)
step('alerta editado persiste valor e volta a monitorar', edited.value === 250 && edited.state === 'armed' && /250/.test(edited.cardText ?? ''), JSON.stringify(edited))

const persisted = await evaluate(`(() => { const raw = window.__storage['dz23.config.v1']; return raw ? { lists: raw.watchlists?.lists?.length ?? 0, alerts: raw.alerts?.rules?.length ?? 0, state: raw.alerts?.rules?.[0]?.state ?? null } : null })()`, sessionId)

// --- uso por provedor: o gateway registra, a tela mostra ---
await evaluate(`document.querySelector('#diagnose').click()`, sessionId)
await wait(1200)
const usage = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('#usageTable tr')].map((tr) => [...tr.children].map((cell) => cell.textContent.trim()))
  return { head: rows[0] ?? [], body: rows.slice(1), empty: document.querySelector('#usageTable').textContent.includes('nenhuma chamada') }
})()`, sessionId)

// §3.2: a memória aparece na tela única (lista por usuário/estratégia)
await evaluate(`chrome.storage.local.set({ 'dz23.memory.v1:e2e:smc': { version: 1, notes: ['não operar em CPI', 'máximo 3x'] } })`, sessionId)
await evaluate(`document.querySelector('#refreshMemory')?.click()`, sessionId)
await wait(600)
const memory = await evaluate(`(() => {
  const board = document.querySelector('#memoryBoard')
  return { text: board?.textContent ?? '', status: document.querySelector('#memoryStatus')?.textContent ?? '', buttons: board?.querySelectorAll('button').length ?? 0 }
})()`, sessionId)
step('memória aparece na tela única com ação de limpar', /e2e · smc · 2 nota\(s\)/.test(memory.text) && memory.buttons >= 1, JSON.stringify(memory).slice(0, 160))

step('tabela de uso mostra provedor, latência e falhas', usage.body.some((row) => row[0] === 'deepseek' && row[2] === '1' && /450 ms/.test(row[3])) && usage.body.some((row) => row[0] === 'ollama' && row[2] === '0'), JSON.stringify(usage).slice(0, 220))
step('watchlists e alertas gravados no registro único', persisted && persisted.lists >= 1 && persisted.alerts >= 1 && ['fired', 'armed'].includes(persisted.state), JSON.stringify(persisted))
step('sem erro de JavaScript', errors.length === 0, JSON.stringify(errors.slice(0, 2)))
const data = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(join(OUT, '08-settings-page.png'), Buffer.from(data.data, 'base64'))

const passed = steps.every((item) => item.ok)
console.log(JSON.stringify({ passed, steps: steps.length, failures: steps.filter((item) => !item.ok).map((item) => item.name) }))
socket.close()
chrome.kill()
await wait(400)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
server.close()
fake.close()
process.exitCode = passed ? 0 : 1

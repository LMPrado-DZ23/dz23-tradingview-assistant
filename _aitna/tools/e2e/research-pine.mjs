// Headless check of the Pine section on the research page: paste, click, read findings. Real DOM, real module.
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
// .mjs needs a JavaScript MIME type or Chrome refuses to execute the module
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }

const server = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
  try {
    const body = readFileSync(join(ROOT, path === '/' ? 'research/index.html' : path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`

const profile = mkdtempSync(join(tmpdir(), 'dz23-pine-ui-'))
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
  else if (payload.method === 'Runtime.consoleAPICalled' && payload.params.type === 'error') errors.push(payload.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ').slice(0, 200))
})
const send = (method, params = {}, sessionId) => new Promise((resolve) => { const id = nextId++; pending.set(id, resolve); socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params })) })
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const evaluate = async (expression, sessionId) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (!response || !response.result)
    throw new Error('Runtime.evaluate falhou: ' + JSON.stringify(response).slice(0, 300))
  if (response.exceptionDetails)
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
  return response.result.value
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1200, deviceScaleFactor: 1, mobile: false }, sessionId)
await send('Page.navigate', { url: `${base}/research/index.html` }, sessionId)
await wait(1500)

const steps = []
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

const debugProbe = await evaluate(`({
  metrics: document.querySelector('#metric')?.options?.length ?? -1,
  scriptTags: [...document.querySelectorAll('script')].map((s) => s.src || s.type || 'inline').slice(0, 4),
  hasClick: Boolean(document.querySelector('#pineValidate')),
})`, sessionId)
console.log('debug:', JSON.stringify(debugProbe))
step('seção Pine existe e está visível', await evaluate(`Boolean(document.querySelector('#pine')) && getComputedStyle(document.querySelector('#pine')).display !== 'none'`, sessionId))

// script com look-ahead e barra futura
await evaluate(`document.querySelector('#pineSource').value = '//@version=5\\nstrategy("x")\\nh = request.security(syminfo.tickerid, "D", high, lookahead = barmerge.lookahead_on)\\nc = close[-1]\\nplot(h)'`, sessionId)
await evaluate(`document.querySelector('#pineValidate').click()`, sessionId)
await wait(400)
const bad = await evaluate(`({
  status: document.querySelector('#pineStatus').textContent,
  statusClass: document.querySelector('#pineStatus').className,
  findings: [...document.querySelectorAll('#pineFindings .finding')].map((row) => ({ level: row.className, code: row.querySelector('.finding-where')?.textContent ?? '' })),
})`, sessionId)
step('script ruim: status de erro e achados renderizados', /ERROS/.test(bad.status) && bad.statusClass.includes('bad') && bad.findings.length >= 3, JSON.stringify(bad).slice(0, 220))
step('achados trazem o código e a linha', bad.findings.some((finding) => finding.code.includes('L4') && finding.code.includes('pine.future_reference')), JSON.stringify(bad.findings.map((f) => f.code)))
step('look-ahead aparece como aviso', bad.findings.some((finding) => finding.level.includes('warning') && finding.code.includes('pine.lookahead')), '')

// script bom, sem achados
await evaluate(`document.querySelector('#pineSource').value = '//@version=5\\nindicator("ok")\\nplot(ta.ema(close, 9))'`, sessionId)
await evaluate(`document.querySelector('#pineValidate').click()`, sessionId)
await wait(400)
const good = await evaluate(`({ status: document.querySelector('#pineStatus').textContent, text: document.querySelector('#pineFindings').textContent })`, sessionId)
step('script bom: OK e nenhum achado', /^OK/.test(good.status) && /Nenhum achado/.test(good.text), JSON.stringify(good))

step('sem erro de JavaScript na página', errors.length === 0, JSON.stringify(errors.slice(0, 2)))

const data = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
writeFileSync(join(OUT, '07-pine-research.png'), Buffer.from(data.data, 'base64'))

const passed = steps.every((item) => item.ok)
console.log(JSON.stringify({ passed, steps: steps.length, failures: steps.filter((item) => !item.ok).map((item) => item.name) }))
socket.close()
chrome.kill()
await wait(400)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
server.close()
process.exitCode = passed ? 0 : 1

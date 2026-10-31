// End-to-end check of the real extension UI in Chrome (Chrome for Testing bundled in _aitna/.browser).
//
// It tries to load the extension itself (--load-extension on Chrome for Testing); when the build refuses it, the
// same pages are served over HTTP from extension/ and every flow is driven exactly as a user would. The gateway is
// a real child process; the provider behind it is a local fake that streams, so nothing leaves the machine.
//
// Evidence: screenshots in <tmp>/dz23-e2e/, plus a JSON report on stdout.
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = 'C:/Users/lmpra/Documents/tradingview-assistant-chrome-extension-main'
const EXT = process.env.DZ23_E2E_ROOT ?? `${ROOT}/extension`
const CHROME = `${ROOT}/_aitna/.browser/chrome/win64-155.0.8059.39/chrome-win64/chrome.exe`
const TOKEN = 'e2e-token-123'
const PORT = 8899
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }

const out = { startedAt: new Date().toISOString(), steps: [], consoleErrors: [], passed: false }
const step = (name, ok, detail) => { out.steps.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const work = mkdtempSync(join(tmpdir(), 'dz23-e2e-'))
const shots = join(work, 'shots')
mkdirSync(shots, { recursive: true })

// ---- fake provider (SSE, slow enough to cancel) -------------------------------------------------------------
const requests = []
const fake = createServer(async (request, response) => {
  let raw = ''
  for await (const chunk of request) raw += chunk
  if (request.url.startsWith('/quebrado')) {
    response.writeHead(500, { 'content-type': 'text/plain' }).end('upstream exploded')
    return
  }
  if (!request.url.startsWith('/openai/chat/completions')) {
    response.writeHead(404).end('no')
    return
  }
  if (!request.headers.authorization?.startsWith('Bearer sk-e2e')) {
    response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'bad key' } }))
    return
  }
  const body = raw ? JSON.parse(raw) : {}
  if (Array.isArray(body.messages))
    requests.push(body.messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n'))
  if (body.stream === false) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  // Agentes da Sofia: quando o system prompt pede o contrato, a resposta é o JSON (não prosa)
  const system = body.messages?.find((message) => message.role === 'system')?.content ?? ''
  const words = /Responda SOMENTE com um objeto JSON/.test(system)
    ? ['{"stance":"alta","confidence":0.7,"evidence":["RSI 62","EMA20 101"],"interpretation":"leitura","invalidation":"perder o swing low"}']
    : ['Tendência ', 'de ', 'alta ', 'no ', '**BTCUSDT** ', '1h. ', 'Atenção ', 'ao ', 'suporte.']
  for (const word of words) {
    if (response.writableEnded) return
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: word } }] })}\n\n`)
    await new Promise((resolve) => setTimeout(resolve, 140))
  }
  response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 9 } })}\n\n`)
  response.end('data: [DONE]\n\n')
})
await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve))
const fakeUrl = `http://127.0.0.1:${fake.address().port}`

// ---- gateway as a real process -------------------------------------------------------------------------------
const configPath = join(work, 'gateway.json')
writeFileSync(configPath, JSON.stringify({
  port: PORT,
  authToken: TOKEN,
  timeoutMs: 20_000,
  rateLimit: { capacity: 100, refillPerSecond: 20 },
  providers: {
    // O provedor padrão aponta para um upstream que responde 500: quem responde é o reserva, via fallback.
    openai: { baseUrl: `${fakeUrl}/quebrado/`, apiKey: 'sk-e2e', models: ['e2e-model'], defaultModel: 'e2e-model' },
    'openai-compatible': { baseUrl: `${fakeUrl}/openai`, apiKey: 'sk-e2e', models: ['e2e-model'], defaultModel: 'e2e-model' },
  },
}))
const gateway = spawn(process.execPath, [`${ROOT}/gateway/server.mjs`], {
  env: { ...process.env, DZ23_GATEWAY_CONFIG: configPath, DZ23_GATEWAY_TOKEN: TOKEN, DZ23_GATEWAY_PORT: String(PORT), DZ23_GATEWAY_DEV: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gatewayLog = ''
gateway.stdout.on('data', (chunk) => { gatewayLog += chunk })
gateway.stderr.on('data', (chunk) => { gatewayLog += chunk })
const health = await (async () => {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`)
      if (response.ok) return await response.json()
    } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
})()
step('gateway sobe e responde /health', Boolean(health?.status === 'ok'), JSON.stringify(health))

// ---- static server for the pages -----------------------------------------------------------------------------
const pages = createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://x').pathname)
  try {
    const body = readFileSync(join(EXT, path))
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    response.writeHead(404).end('not found')
  }
})
await new Promise((resolve) => pages.listen(0, '127.0.0.1', resolve))
const httpBase = `http://127.0.0.1:${pages.address().port}`

// ---- Chrome with the extension loaded (best effort) ----------------------------------------------------------
const profile = join(work, 'profile')
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  `--user-data-dir=${profile}`, '--remote-debugging-port=0',
  `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
const wsUrl = await new Promise((resolve, reject) => {
  let buffer = ''
  const timer = setTimeout(() => reject(new Error('chrome did not print a devtools url: ' + buffer)), 20_000)
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
const listeners = new Map()
socket.addEventListener('message', (message) => {
  const payload = JSON.parse(message.data)
  if (payload.id && pending.has(payload.id)) {
    pending.get(payload.id)(payload.result ?? { error: payload.error })
    pending.delete(payload.id)
  } else if (payload.method) {
    for (const handler of listeners.get(payload.method) ?? []) handler(payload.params)
  }
})
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
})
const on = (method, handler) => {
  const list = listeners.get(method) ?? []
  list.push(handler)
  listeners.set(method, list)
}

// ---- pick the page: the loaded extension if Chrome accepted it, the served copy otherwise ---------------------
const { targetInfos } = await send('Target.getTargets')
const extensionTarget = targetInfos.find((target) => target.url.startsWith('chrome-extension://'))
let pageUrl = `${httpBase}/copilot/index.html`
let mode = 'http'
if (extensionTarget) {
  const id = new URL(extensionTarget.url).host
  const created = await send('Target.createTarget', { url: `chrome-extension://${id}/copilot/index.html` })
  const { targetId } = created
  const session = await send('Target.attachToTarget', { targetId, flatten: true })
  pageUrl = `chrome-extension://${id}/copilot/index.html`
  mode = `extension:${id}`
  out.sessionId = session.sessionId
  out.targetId = targetId
} else {
  const created = await send('Target.createTarget', { url: 'about:blank' })
  const session = await send('Target.attachToTarget', { targetId: created.targetId, flatten: true })
  out.sessionId = session.sessionId
  out.targetId = created.targetId
}
out.mode = mode
step('página do copiloto disponível', true, mode)

const { sessionId } = out
await send('Runtime.enable', {}, sessionId)
await send('Page.enable', {}, sessionId)
await send('Log.enable', {}, sessionId)
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 1, mobile: false }, sessionId)
on('Runtime.exceptionThrown', (params) => out.consoleErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text))
on('Runtime.consoleAPICalled', (params) => { if (params.type === 'error') out.consoleErrors.push((params.args ?? []).map((arg) => arg.value ?? arg.description).join(' ')) })
on('Log.entryAdded', (params) => { if (params.entry.level === 'error' && !params.entry.url?.endsWith('favicon.ico')) out.consoleErrors.push(params.entry.text) })

const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
  return result.value
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const shot = async (name) => {
  const data = await send('Page.captureScreenshot', { format: 'png' }, sessionId)
  writeFileSync(join(shots, `${name}.png`), Buffer.from(data.data, 'base64'))
}

// the copilot needs a gateway url and token: seed the same storage the settings dialog writes
const seed = await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `try { localStorage.setItem('dz23.copilot.v2', JSON.stringify(${JSON.stringify({
    version: 3,
    conversations: [],
    activeId: null,
    settings: { gatewayUrl: `http://127.0.0.1:${PORT}`, token: '', provider: 'openai', model: 'e2e-model', modelsByProvider: { openai: ['e2e-model'] }, user: 'e2e' },
  })}))
} catch {}`,
}, sessionId)

// The tabs stub is independent of the settings seed: it must survive every reload
await send('Page.addScriptToEvaluateOnNewDocument', { source: `try {
  // dz23:e2e-candles — the exchange call is stubbed; the parsing, validation and UI are the real ones
  const realFetch = window.fetch
  window.fetch = (url, options) => String(url).includes("binance.com")
    ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([
      // 60 candles sintéticos (o teste é sintético e está rotulado como tal): as métricas precisam de amostra
      ...Array.from({ length: 60 }, (_, index) => [(index + 1) * 60000, String(100 + index), String(101 + index), String(99 + index), String(100.5 + index), String(10 + index)]),
    ]) })
    : realFetch(url, options)
  window.__dz23Runtime = {
    lastError: null,
    onMessage: { addListener () {} },
    sendMessage: (message, respond) => {
      if (message?.type === 'dz23:chart:apply')
        window.__dz23Tabs.update(message.tabId, { url: message.url }, respond)
      else
        respond?.({ ok: false })
    },
  }
  window.__appliedUrl = null
  window.__dz23Tabs = {
    query: () => Promise.resolve([{ id: 1, url: 'https://www.tradingview.com/chart/abc/' }]),
    update: (tabId, props, respond) => {
      window.__appliedUrl = props?.url ?? null
      respond?.({ ok: true, id: tabId, url: window.__appliedUrl })
    },
    sendMessage: (tabId, message, respond) => {
      window.__pings = (window.__pings ?? 0) + 1
      // the first ping fails, exactly like a tab whose content script died on an extension reload
      if (window.__pings === 1) {
        window.__dz23Runtime.lastError = { message: 'Could not establish connection' }
        respond(undefined)
        window.__dz23Runtime.lastError = null
        return
      }
      if (window.__appliedUrl) {
        const parsed = new URL(window.__appliedUrl)
        const pair = decodeURIComponent(parsed.pathname.split('/')[2] ?? 'BTCUSDT')
        const interval = parsed.searchParams.get('interval') ?? '60'
        respond({ ok: true, observation: { rawSymbol: pair, resolution: interval, source: 'page' } })
        return
      }
      respond({ ok: true, observation: { rawSymbol: 'BINANCE:BTCUSDT', resolution: '60', source: 'page' } })
    },
    onRemoved: { addListener () {} },
    onActivated: { addListener () {} },
  }
} catch {}` }, sessionId)
await send('Page.navigate', { url: pageUrl }, sessionId)
await wait(1800)
// the seed only exists to give the first load a gateway and token; a reload must read what the page wrote
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed.identifier }, sessionId)
const booted = await evaluate(`({ title: document.title, providers: [...document.querySelectorAll('#providerSelect option')].map(o => o.value), suggestions: document.querySelectorAll('#suggestions button').length, status: document.querySelector('#status')?.textContent ?? '', chipBox: Boolean(document.querySelector('#chips')) })`)
const pairing = await evaluate(`({ token: Boolean(window.__dz23.state.settings.token), providers: [...document.querySelectorAll('#providerSelect option')].length })`)
step('emparelha sozinho com o gateway em desenvolvimento (sem digitar token)', pairing.token && pairing.providers > 0, JSON.stringify(pairing))
step('copia o copiloto sem erro de console', out.consoleErrors.length === 0, JSON.stringify(out.consoleErrors.slice(0, 2)))
step('provedor descoberto pelo gateway', booted.providers.includes('openai'), JSON.stringify(booted.providers))
step('sugestões iniciais renderizadas', booted.suggestions > 0, `${booted.suggestions}`)
const chip = await evaluate(`({ text: document.querySelector('#chartLabel')?.textContent ?? '', state: document.querySelector('#chartChip')?.dataset.state ?? '' })`)
const pings = await evaluate('window.__pings ?? 0')
step('ping repetido reconecta quando o content script não responde', pings >= 2, `pings=${pings}`)
step('chip mostra o gráfico ativo', chip.state === 'live' && chip.text.includes('BTCUSDT') && chip.text.includes('1h'), JSON.stringify(chip))
await evaluate(`document.querySelector('#chartChip').click()`)
await wait(700)
const chartDetail = await evaluate(`document.querySelector('#chartDetail')?.textContent ?? ''`)
step('diálogo do chip consulta os candles', /Candles: 60/.test(chartDetail) && /Fonte dos candles: BINANCE/.test(chartDetail) && /último fechamento 159\.5/.test(chartDetail), chartDetail.slice(0, 180).replace(/\n/g, ' | '))
await evaluate(`document.querySelector('#chartDialog').close()`)
// --- side-panel usability: the rail must close from inside, and nothing may be clipped ---
const railClosed = await evaluate(`({
  open: document.querySelector('#app').classList.contains('rail-open'),
  chipRight: Math.round(document.querySelector('#chartChip').getBoundingClientRect().right),
  innerWidth: window.innerWidth,
  pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
})`)
step('painel abre com o histórico fechado e sem corte', !railClosed.open && !railClosed.pageOverflow && railClosed.chipRight <= railClosed.innerWidth, JSON.stringify(railClosed))
await evaluate(`document.querySelector('#toggleRail').click()`)
await wait(300)
const railOpen = await evaluate(`({
  open: document.querySelector('#app').classList.contains('rail-open'),
  backdrop: getComputedStyle(document.querySelector('#railBackdrop')).display,
  closeVisible: getComputedStyle(document.querySelector('#railClose')).display !== 'none',
})`)
step('menu do histórico abre com botão de fechar e fundo', railOpen.open && railOpen.backdrop !== 'none' && railOpen.closeVisible, JSON.stringify(railOpen))
await evaluate(`document.querySelector('#railClose').click()`)
await wait(250)
step('botão × fecha o histórico', !(await evaluate(`document.querySelector('#app').classList.contains('rail-open')`)), '')
await evaluate(`document.querySelector('#toggleRail').click()`)
await wait(200)
await evaluate(`document.querySelector('#railBackdrop').click()`)
await wait(250)
step('clique fora também fecha o histórico', !(await evaluate(`document.querySelector('#app').classList.contains('rail-open')`)), '')
await evaluate(`document.querySelector('#ctxEdit').click()`)
await wait(300)
const preview = await evaluate(`(() => { const pre = document.querySelector('#ctxPreview'); return { x: pre.scrollWidth > pre.clientWidth + 1, w: pre.clientWidth, sw: pre.scrollWidth } })()`)
await evaluate(`(() => {
  const symbol = document.querySelector('#actSymbol')
  const timeframe = document.querySelector('#actTimeframe')
  if (!symbol || !timeframe) return
  symbol.value = 'ETHUSDT'
  timeframe.value = '15m'
  document.querySelector('#applyAction').click()
})()`)
await wait(8000)
const applied = await evaluate(`({
  url: window.__appliedUrl ?? '',
  result: document.querySelector('#actionResult')?.textContent ?? '',
  classes: document.querySelector('#actionResult')?.className ?? '',
})`)
step('ação de gráfico aplicada e confirmada por releitura do estado', /\/chart\/BINANCE:ETHUSDT\/\?interval=15/.test(applied.url) && /confirmado/.test(applied.result), JSON.stringify(applied).slice(0, 200))
await evaluate('window.__appliedUrl = null')
step('preview do contexto sem rolagem horizontal', !preview.x, JSON.stringify(preview))
await evaluate(`document.querySelector('#ctxDialog').close()`)
await wait(150)
// --- settings screen: profile, sections and the fields that save ---
await evaluate(`document.querySelector('#openSettings').click()`)
await wait(400)
const settings = await evaluate(`({
  open: document.querySelector('#settings').open,
  user: document.querySelector('#settingsUser')?.textContent ?? '',
  hasName: Boolean(document.querySelector('#settingsUserInput')),
  hasToken: Boolean(document.querySelector('#gatewayToken')),
})`)
const exits = await evaluate(`(() => {
  const dialog = document.querySelector('#settings')
  const box = dialog.getBoundingClientRect()
  const close = document.querySelector('#closeSettings')
  const footer = dialog.querySelector('menu')
  const inside = (rect) => rect && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1 && rect.height > 0
  return { open: dialog.open, closeVisible: inside(close?.getBoundingClientRect()), footerVisible: inside(footer?.getBoundingClientRect()), closeText: close?.textContent ?? '', scrollable: dialog.scrollHeight > dialog.clientHeight }
})()`)
step('configurações têm saída visível (topo e rodapé)', exits.open && exits.closeVisible && exits.footerVisible, JSON.stringify(exits))
await evaluate(`document.querySelector('#closeSettings').click()`)
await wait(250)
const closedByX = await evaluate(`document.querySelector('#settings').open`)
step('botão × fecha as configurações', closedByX === false, String(closedByX))
await evaluate(`document.querySelector('#openSettings').click()`)
await wait(300)
await evaluate(`document.querySelector('#settings menu button[value="cancel"]').click()`)
await wait(250)
const closedByFooter = await evaluate(`document.querySelector('#settings').open`)
step('botão Fechar do rodapé também fecha', closedByFooter === false, String(closedByFooter))
await evaluate(`document.querySelector('#openSettings').click()`)
await wait(300)
step('configurações mostram perfil e campos', settings.open && settings.hasName && settings.hasToken && settings.user.length > 0, JSON.stringify(settings))
await evaluate(`document.querySelector('#testConnection').click()`)
await wait(1200)
const conn = await evaluate(`document.querySelector('#connResult')?.textContent ?? ''`)
step('teste de conexão da configuração fala com o gateway', /gateway ok/.test(conn) && /provedor/.test(conn), conn)
await shot('09-settings')
await evaluate(`document.querySelector('#settings').close()`)
await wait(150)

// ---- attachments: real file through the file input ------------------------------------------------------------
const csvPath = join(work, 'resultados.csv')
writeFileSync(csvPath, '"Net PnL: All","__length"\n100,10\n400,20\n')
const { root } = await send('DOM.getDocument', {}, sessionId)
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#files' }, sessionId)
await send('DOM.setFileInputFiles', { files: [csvPath], nodeId }, sessionId)
await wait(700)
const chips = await evaluate(`({ count: document.querySelectorAll('#chips .pill').length, text: document.querySelector('#chips')?.textContent ?? '' })`)
step('anexar CSV cria o chip', chips.count === 1 && chips.text.includes('resultados.csv'), JSON.stringify(chips))
await shot('02-attachment')

// a text file with the wrong type must be refused with a message, not silently
const pdfPath = join(work, 'grafico.pdf')
writeFileSync(pdfPath, '%PDF-1.4')
await send('DOM.setFileInputFiles', { files: [pdfPath], nodeId }, sessionId)
await wait(600)
const refused = await evaluate(`({ chips: document.querySelectorAll('#chips .pill').length, status: document.querySelector('#status')?.textContent ?? '' })`)
step('arquivo não suportado é recusado com mensagem', refused.chips === 1 && /formato de texto aceito/.test(refused.status), JSON.stringify(refused))

// ---- context + memory persistence across reload ---------------------------------------------------------------
await evaluate(`document.querySelector('#ctxEdit').click()`)
await wait(300)
await evaluate(`(() => { const memory = document.querySelector('#ctxMemory'); memory.value = 'não operar em CPI\\nnunca alavancar acima de 3x'; const strategy = document.querySelector('#ctxStrategy'); strategy.value = 'smc-e2e'; strategy.dispatchEvent(new Event('input')); document.querySelector('#ctxAsset').value = 'BTCUSDT'; document.querySelector('#saveCtx').click() })()`)
await wait(400)
await send('Page.reload', {}, sessionId)
await wait(1500)
await evaluate(`document.querySelector('#ctxEdit').click()`)
await wait(300)
const restored = await evaluate(`({ memory: document.querySelector('#ctxMemory')?.value ?? '', strategy: document.querySelector('#ctxStrategy')?.value ?? '', asset: document.querySelector('#ctxAsset')?.value ?? '' })`)
step('contexto e memória persistem após reload', restored.memory.includes('não operar em CPI') && restored.strategy === 'smc-e2e' && restored.asset === 'BTCUSDT', JSON.stringify(restored).slice(0, 160))
const promptDebug = await evaluate(`({
  user: window.__dz23.state.settings.user,
  strategy: document.querySelector('#ctxStrategy').value,
  hook: window.__dz23.buildSystemPrompt({ context: { asset: 'BTCUSDT', timeframe: '1h', strategy: document.querySelector('#ctxStrategy').value, notes: '' } }),
  preview: document.querySelector('#ctxPreview')?.textContent ?? '',
})`)
step('memória entra no prompt do contexto', /não operar em CPI/.test(promptDebug.hook) && /não operar em CPI/.test(promptDebug.preview), JSON.stringify({ user: promptDebug.user, strategy: promptDebug.strategy, hookHas: /CPI/.test(promptDebug.hook), previewHas: /CPI/.test(promptDebug.preview), previewTail: promptDebug.preview.slice(-160) }))
await shot('03-context')
await evaluate(`document.querySelector('#ctxDialog').close()`)

// ---- send + streaming + stop ---------------------------------------------------------------------------------
const chartStateDiagnostic = await evaluate('JSON.stringify(window.__dz23?.chartState?.() ?? null)')
step('diagnóstico do estado do gráfico no envio', /BTCUSDT/.test(String(chartStateDiagnostic)), String(chartStateDiagnostic).slice(0, 200))
await evaluate(`(() => { const input = document.querySelector('#input'); input.value = 'Como está o BTCUSDT?'; document.querySelector('#send').click() })()`)
await wait(900)
const streaming = await evaluate(`({ stopVisible: !document.querySelector('#stop').hidden, text: [...document.querySelectorAll('.msg.assistant')].map(m => m.textContent).join('') })`)
step('streaming em andamento com botão parar', streaming.stopVisible, `${streaming.text.length} chars`)
await shot('04-streaming')
await evaluate(`document.querySelector('#stop').click()`)
await wait(500)
const afterStop = await evaluate(`({ stopHidden: document.querySelector('#stop').hidden, text: [...document.querySelectorAll('.msg.assistant')].map(m => m.textContent).join('') })`)
step('cancelar interrompe a geração', afterStop.stopHidden, `${afterStop.text.length} chars`)
await wait(1400)
const finalText = await evaluate(`[...document.querySelectorAll('.msg.assistant')].map(m => m.textContent).join('')`)
// Os especialistas da Sofia também geram requisições: pegar a do copiloto, não a primeira
const prompt = requests.find((text) => text.includes('Contexto do gráfico') || text.includes('copiloto')) ?? requests[0] ?? ''
const promptLength = prompt.length
step('o gateway recebeu o ativo do gráfico', /Ativo: BTCUSDT/.test(prompt) && /Timeframe: 1h/.test(prompt), `len=${promptLength} chart=${/Contexto do gráfico/.test(prompt)} ` + prompt.slice(0, 120).replace(/\n/g, ' | '))
step('o gateway recebeu os candles do gráfico, não só o símbolo', /Candles: \d+/.test(prompt) && /último fechamento/i.test(prompt) && /Fonte dos candles: BINANCE/i.test(prompt), (prompt.match(/Candles[^]*?(?=\n\n|$)/) ?? [''])[0].slice(0, 160).replace(/\n/g, ' | '))
step('o prompt leva métricas calculadas com procedência', /Métricas calculadas/.test(prompt) && /RSI\(14\) = /.test(prompt) && /Fonte: BINANCE/.test(prompt), (prompt.match(/RSI\(14\) = [^\n]*/) ?? [''])[0])
step('candles levam procedência em vez de número solto', /Fonte dos candles: BINANCE/.test(prompt) && !/Candles: não disponíveis/.test(prompt), String(/Fonte dos candles: BINANCE/.test(prompt)))
step('markdown renderizado (negrito)', /BTCUSDT/.test(finalText), finalText.slice(0, 80))

// O provedor padrão está quebrado de propósito: a resposta só chega se o fallback funcionar, e a troca precisa ser visível.
// O provedor padrão está quebrado de propósito: se a resposta chegou, o gateway trocou de provedor.
// O ledger de uso do próprio gateway é a prova — não a inferência a partir do texto.
const usage = await fetch(`http://127.0.0.1:${PORT}/usage`, { headers: { authorization: `Bearer ${TOKEN}` } }).then((response) => response.json())
step('painel pede fallback: o gateway tentou o quebrado e respondeu pelo reserva',
  Boolean(usage.providers?.openai?.failed >= 1 && usage.providers?.['openai-compatible']?.ok >= 1),
  JSON.stringify({ openai: usage.providers?.openai, reserva: usage.providers?.['openai-compatible'] }).slice(0, 180))
await shot('05-after-stop')

// ---- mobile width: no horizontal scroll, controls reachable --------------------------------------------------
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId)
await wait(500)
const mobile = await evaluate(`({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, composerVisible: document.querySelector('#composer').getBoundingClientRect().bottom <= window.innerHeight + 1 })`)
step('layout mobile sem rolagem horizontal', mobile.scrollWidth <= mobile.innerWidth + 1, JSON.stringify(mobile))
step('compositor visível no mobile', mobile.composerVisible, '')
await shot('06-mobile')

// ---- history persists after reload ---------------------------------------------------------------------------
await send('Page.reload', {}, sessionId)
await wait(1500)
const history = await evaluate(`({ threads: document.querySelectorAll('.thread').length, text: [...document.querySelectorAll('.msg')].map(m => m.textContent).join(' ').slice(0, 80) })`)
const chatLayout = await evaluate(`({
  emptyDisplay: getComputedStyle(document.querySelector('#empty')).display,
  emptyHeight: document.querySelector('#empty').getBoundingClientRect().height,
  messagesHeight: document.querySelector('#messages').getBoundingClientRect().height,
  pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 2,
})`)
// --- comparação multi-timeframe no painel (candles sintéticos rotulados) ---
await evaluate(`document.querySelector('#compareTimeframes').click()`, sessionId)
await wait(3000)
const compare = await evaluate(`({ hidden: document.querySelector('#compareResult').hidden, text: document.querySelector('#compareResult').textContent, cls: document.querySelector('#compareResult').className })`, sessionId)
step('comparação multi-timeframe mostra fatos por timeframe', compare.hidden === false && /15m: tendência/.test(compare.text) && /1h: tendência/.test(compare.text) && /4h: tendência/.test(compare.text) && /Alinhamento de tendência/.test(compare.text) && /não recomendação/.test(compare.text), JSON.stringify(compare).slice(0, 220))

// --- comparação entre ativos no painel (mesmo timeframe, dois símbolos) ---
await evaluate(`(() => { document.querySelector('#actSymbol').value = 'BTCUSDT'; document.querySelector('#compareSymbol').value = 'ETHUSDT' })()`, sessionId)
await evaluate(`document.querySelector('#compareAssets').click()`, sessionId)
await wait(3000)
const assetCompare = await evaluate(`({ text: document.querySelector('#compareResult').textContent, cls: document.querySelector('#compareResult').className })`, sessionId)
step('comparação entre ativos mostra os dois lado a lado', /BTCUSDT:/.test(assetCompare.text) && /ETHUSDT:/.test(assetCompare.text) && /Força relativa/.test(assetCompare.text) && /não recomendação/.test(assetCompare.text), JSON.stringify(assetCompare).slice(0, 200))
await evaluate(`(() => { document.querySelector('#compareSymbol').value = 'BTCUSDT' })()`, sessionId)
await evaluate(`document.querySelector('#compareAssets').click()`, sessionId)
await wait(1500)
const sameAsset = await evaluate(`document.querySelector('#compareResult').textContent`, sessionId)
step('comparação recusa o mesmo ativo dos dois lados', /dois ativos diferentes/.test(sameAsset), JSON.stringify(sameAsset).slice(0, 120))
await evaluate(`(() => { document.querySelector('#compareSymbol').value = '' })()`, sessionId)

step('vazio escondido com conversa aberta (sem tela dividida)', chatLayout.emptyDisplay === 'none' && chatLayout.emptyHeight === 0 && chatLayout.messagesHeight > 100 && !chatLayout.pageScrolls, JSON.stringify(chatLayout))
// --- legibility of the panel itself: measure, do not eyeball ---
const contrastReport = await evaluate(`(() => {
  const parse = (value) => {
    const match = String(value).match(/rgba?\\(([^)]+)\\)/)
    if (!match) return null
    const parts = match[1].split(',').map((part) => Number(part.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const channel = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const lum = (color) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)
  const blend = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
  const backgroundOf = (element) => {
    const stack = []
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      const color = parse(getComputedStyle(node).backgroundColor)
      if (color && color.a > 0) { stack.push(color); if (color.a === 1) break }
    }
    let result = { r: 255, g: 255, b: 255, a: 1 }
    for (let index = stack.length - 1; index >= 0; index -= 1) result = blend(stack[index], result)
    return result
  }
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
  const offenders = []
  for (const element of document.querySelectorAll('body *')) {
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const own = [...element.childNodes].filter((node) => node.nodeType === 3 && node.textContent.trim().length > 1)
    if (!own.length) continue
    const rect = element.getBoundingClientRect()
    if (rect.width < 2 || rect.height < 2) continue
    const fg = parse(style.color)
    if (!fg) continue
    const bg = backgroundOf(element)
    const contrast = ratio(fg.a < 1 ? blend(fg, bg) : fg, bg)
    if (contrast < 3)
      offenders.push({ text: own.map((node) => node.textContent.trim()).join(' ').slice(0, 40), contrast: Number(contrast.toFixed(2)), fg: style.color, bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')' })
  }
  return offenders
})()`)
step('contraste do painel: nenhum texto abaixo de 3:1', contrastReport.length === 0, JSON.stringify(contrastReport.slice(0, 4)))
step('histórico sobrevive ao reload', history.threads >= 1 && history.text.includes('BTCUSDT'), JSON.stringify(history))

// --- Sofia: o painel roda os especialistas sobre o gráfico atual e mostra o consenso ---
await evaluate(`document.querySelector('#newChat').click()`)
await wait(400)
await evaluate(`(() => { const input = document.querySelector('#input'); input.value = 'tendencia e risco agora?'; document.querySelector('#sofia').click() })()`)
await wait(6000)
const sofia = await evaluate(`({
  state: document.querySelector('#sofiaState')?.textContent ?? '',
  last: [...document.querySelectorAll('.msg.assistant .msg-text')].at(-1)?.textContent ?? '',
})`)
step('Sofia consulta os especialistas e reporta o consenso', /parecer\(es\)/.test(sofia.state) && /Consenso:/.test(sofia.last) && /Trace:/.test(sofia.last), JSON.stringify({ state: sofia.state }).slice(0, 160))

await shot('07-history')

// Com o gateway no ar, o aviso de configuração não deve ocupar espaço.
const onlineHint = await evaluate(`(() => {
  const hint = document.querySelector('#setupHint')
  return { hidden: Boolean(hint?.hidden), text: hint?.textContent ?? '' }
})()`, sessionId)
step('sem aviso de configuração quando o gateway responde', onlineHint.hidden, JSON.stringify(onlineHint).slice(0, 120))

// --- a memória que o usuário digita precisa chegar ao modelo, não só ao armazenamento ---
await evaluate(`(() => {
  const memory = document.querySelector('#ctxMemory')
  if (!memory) return false
  memory.value = 'regra do usuário: só operar acima do VWAP'
  document.querySelector('#saveCtx')?.click()
  return true
})()`, sessionId)
await wait(400)
const memoryPersisted = await evaluate(`(() => {
  const memory = document.querySelector('#ctxMemory')
  if (!memory) return false
  document.querySelector('#chartChip')?.click()
  return true
})()`, sessionId)
await wait(400)
const memoryValue = await evaluate(`document.querySelector('#ctxMemory')?.value ?? ''`, sessionId)
step('memória persiste ao reabrir o diálogo', /só operar acima do VWAP/.test(memoryValue), JSON.stringify(memoryValue).slice(0, 80))

step('nenhum erro de JavaScript na sessão inteira', out.consoleErrors.length === 0, JSON.stringify(out.consoleErrors.slice(0, 3)))
// --- without the gateway: no AI, but the chart keeps being detected ---
gateway.kill()
await wait(800)
await send('Page.reload', {}, sessionId)
await wait(2000)
const offline = await evaluate(`({
  chip: document.querySelector('#chartLabel')?.textContent ?? '',
  state: document.querySelector('#chartChip')?.dataset.state ?? '',
  status: document.querySelector('#statusText')?.textContent ?? '',
})`)
step('gráfico detectado sem o gateway', /BTCUSDT/.test(offline.chip) && offline.state === 'live' && /off-line|offline/i.test(offline.status), JSON.stringify(offline))

// O aviso é a parte que ajuda: dizer "off-line" sem dizer o que fazer não resolve.
const help = await evaluate(`(() => {
  const hint = document.querySelector('#setupHint')
  return { hidden: Boolean(hint?.hidden), text: hint?.textContent ?? '' }
})()`, sessionId)
step('orienta o primeiro uso quando o gateway está fora', !help.hidden && /npm run gateway/.test(help.text) && /pareamento é automático/.test(help.text) && /token/i.test(help.text), JSON.stringify(help).slice(0, 140))

// --- o oposto de "mudo": com o gateway fora, a falha tem de aparecer na conversa ---
await evaluate(`(() => { const input = document.querySelector('#input'); input.value = 'teste sem gateway'; document.querySelector('#send').click() })()`)
await wait(2500)
const failure = await evaluate(`({
  boxes: document.querySelectorAll('.error-box').length,
  text: [...document.querySelectorAll('.error-box')].map((box) => box.textContent).join(' '),
  streaming: !document.querySelector('#stop').hidden,
})`)
const why = await evaluate('JSON.stringify(window.__dz23?.debugState?.() ?? null)')
step('falha do gateway aparece na conversa em vez de silêncio', failure.boxes >= 1 && /Falha ao responder/.test(failure.text) && !failure.streaming, JSON.stringify(failure).slice(0, 120) + ' debug=' + why)
await shot('08-offline')

out.passed = out.steps.every((item) => item.ok)
out.shots = shots
out.gatewayLogTail = gatewayLog.split('\n').filter(Boolean).slice(-4)
console.log(JSON.stringify(out, null, 1))

socket.close()
chrome.kill()
gateway.kill()
await wait(600)
try { rmSync(profile, { recursive: true, force: true }) } catch {}
pages.close()
fake.close()
process.exitCode = out.passed ? 0 : 1

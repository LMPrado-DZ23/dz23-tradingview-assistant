// DZ23 Copilot — side panel / expanded window.
//
// Talks to the local gateway only (bearer token, 127.0.0.1). It never sees a provider key, and it shows the
// user exactly which trading context is sent with the conversation.

import { createMemory, memoryBlock } from './memory.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import { attachmentSummary, attachmentText, renderForMessage, validateFile } from './attachments.js'
import {readState, writeState, findConversation, mostRecent } from './conversations.js'
import { candlesMatchContext, contextBlock, createChartStore, describeContext } from '../lib/chartContext.js'
import { fetchCandles } from '../lib/candles.js'
import { createConfigStore, fromSettings, toSettings } from '../lib/config.js'
import { buildActionUrl, describeAction, normalizeSymbol, verifyAction } from '../lib/chartActions.js'
import { marketIntelBlock, summarizeMarket } from '../lib/marketIntel.js'
import { compareTimeframes, describeComparison } from '../lib/compare.js'
import { compareAssets, describeAssetComparison } from '../lib/compareAssets.js'
import { planRun, runAgents, summarizeRun } from '../lib/agents.js'

const STORAGE_KEY = 'dz23.copilot.v2'
// Single source of truth for settings (gateway, token, provider, model, user). Conversations stay in localStorage.
const configStore = createConfigStore()
const memory = createMemory()
const DEFAULT_GATEWAY = 'http://127.0.0.1:8777'

const SUGGESTIONS = [
  'O que você pode fazer?',
  'Como está meu trading? Me dê um coach',
  'Quais os riscos do contexto atual?',
  'Explique o último resultado do backtest',
  'Que métricas devo acompanhar neste timeframe?',
]

const SYSTEM_PREAMBLE = [
  'Você é o copiloto DZ23 de pesquisa quantitativa.',
  'Responda em português do Brasil, de forma direta e técnica.',
  'Nunca invente números, preços ou resultados: se o dado não estiver no contexto, diga que falta.',
  'Nada aqui executa ordens reais; trate qualquer sugestão como hipótese a validar.',
].join(' ')

/* ------------------------------------------------------------------ state */

function emptyState () {
  return {
    conversations: [],
    activeId: null,
    settings: {
      gatewayUrl: DEFAULT_GATEWAY,
      user: 'local',
      token: '',
      provider: '',
      model: '',
      modelsByProvider: {},
    },
  }
}

// Loading is defensive: a corrupt entry, an older schema or a broken conversation is repaired, never fatal.
let loadReport = { repaired: false, reason: 'ok' }
function loadState () {
  try {
    loadReport = readState(localStorage.getItem(STORAGE_KEY), emptyState())
  } catch {
    loadReport = { state: emptyState(), repaired: true, reason: 'armazenamento indisponível' }
  }
  return loadReport.state
}

const state = loadState()

function save () {
  try {
    localStorage.setItem(STORAGE_KEY, writeState(state).json)
  } catch {
    /* private mode or quota: the conversation stays in memory */
  }
  // The configuration is written to the shared store; a failure there must not break the conversation flow.
  void configStore.save(fromSettings(state.settings, configStore.peek() ?? undefined)).catch(() => {})
}

function activeConversation () {
  return findConversation(state, state.activeId)
}

function newConversation () {
  const conversation = {
    id: `c${Date.now()}`,
    title: 'Nova conversa',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    context: { asset: '', timeframe: '', strategy: '', notes: '' },
    messages: [],
  }
  state.conversations.unshift(conversation)
  state.activeId = conversation.id
  save()
  return conversation
}

function deleteConversation (id) {
  state.conversations = state.conversations.filter((conversation) => conversation.id !== id)
  if (state.activeId === id)
    state.activeId = mostRecent(state)?.id ?? null
  save()
}

/* ---------------------------------------------------------------- gateway */

class GatewayError extends Error {
  constructor (code, message, status = 0) {
    super(message)
    this.code = code
    this.status = status
  }
}

function gatewayBase () {
  return (state.settings.gatewayUrl || DEFAULT_GATEWAY).replace(/\/+$/, '')
}

function authHeaders () {
  return state.settings.token ? { authorization: `Bearer ${state.settings.token}` } : {}
}

async function gatewayFetch (path, options = {}) {
  const url = `${gatewayBase()}${path}`
  let response
  try {
    response = await fetch(url, {
      ...options,
      headers: { 'content-type': 'application/json', ...authHeaders(), ...(options.headers ?? {}) },
    })
  } catch {
    throw new GatewayError('gateway_unreachable', `O gateway não respondeu em ${gatewayBase()}. Inicie com "node gateway/server.mjs".`)
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new GatewayError(body.error?.code ?? 'http_error', body.error?.message ?? `HTTP ${response.status}`, response.status)
  }
  return response
}

async function fetchProviders () {
  const response = await gatewayFetch('/providers')
  const body = await response.json()
  return body.providers ?? []
}

async function streamChat (payload, { onEvent, signal }) {
  const response = await gatewayFetch('/chat', { method: 'POST', body: JSON.stringify(payload), signal })
  if (!response.body)
    throw new GatewayError('invalid_response', 'A resposta do gateway não tem corpo.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done)
      break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const line = block.split('\n').find((item) => item.startsWith('data:'))
      if (line) {
        try {
          onEvent(JSON.parse(line.slice(5).trim()))
        } catch {
          /* a malformed event is skipped, never rendered as text */
        }
      }
      boundary = buffer.indexOf('\n\n')
    }
  }
}

/* ------------------------------------------------------------------ render */

const $ = (id) => document.getElementById(id)

function renderStatus (status, text) {
  const dot = $('statusDot')
  dot.className = `dot ${status}`
  $('statusText').textContent = text
}

function renderHistory () {
  const nav = $('history')
  nav.innerHTML = ''
  if (!state.conversations.length) {
    const empty = document.createElement('p')
    empty.className = 'hint'
    empty.style.padding = '8px'
    empty.textContent = 'Nenhuma conversa ainda.'
    nav.appendChild(empty)
    return
  }
  for (const conversation of [...state.conversations].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))) {
    const row = document.createElement('div')
    row.className = 'thread'
    row.setAttribute('role', 'button')
    row.tabIndex = 0
    row.setAttribute('aria-current', String(conversation.id === state.activeId))
    const title = document.createElement('span')
    title.className = 'thread-title'
    title.textContent = conversation.title
    const del = document.createElement('button')
    del.className = 'thread-del'
    del.type = 'button'
    del.title = 'Excluir conversa'
    del.textContent = '✕'
    let armed = false
    del.addEventListener('click', (event) => {
      event.stopPropagation()
      if (!armed) {
        armed = true
        del.textContent = 'excluir?'
        del.style.color = 'var(--danger)'
        setTimeout(() => { armed = false; del.textContent = '✕'; del.style.color = '' }, 3000)
        return
      }
      deleteConversation(conversation.id)
      renderAll()
    })
    row.append(title, del)
    row.addEventListener('click', () => {
      // On a narrow panel the rail covers the chat: choosing a conversation closes it
      $('app').classList.remove('rail-open')
      state.activeId = conversation.id
      save()
      renderAll()
    })
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        state.activeId = conversation.id
        save()
        renderAll()
      }
    })
    nav.appendChild(row)
  }
}

function messageActions (message, index) {
  const actions = document.createElement('div')
  actions.className = 'msg-actions'
  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'copiar'
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      copy.textContent = 'copiado'
    } catch {
      copy.textContent = 'falhou'
    }
    setTimeout(() => { copy.textContent = 'copiar' }, 1500)
  })
  actions.appendChild(copy)

  if (message.role === 'assistant') {
    const again = document.createElement('button')
    again.type = 'button'
    again.textContent = 'regenerar'
    again.addEventListener('click', () => regenerate(index))
    const up = document.createElement('button')
    up.type = 'button'
    up.textContent = '👍'
    up.title = 'Resposta útil'
    up.setAttribute('aria-pressed', String(message.rating === 'up'))
    up.addEventListener('click', () => rate(index, 'up'))
    const down = document.createElement('button')
    down.type = 'button'
    down.textContent = '👎'
    down.title = 'Resposta ruim'
    down.setAttribute('aria-pressed', String(message.rating === 'down'))
    down.addEventListener('click', () => rate(index, 'down'))
    actions.append(again, up, down)
  }
  return actions
}

function renderMessages () {
  const container = $('messages')
  container.innerHTML = ''
  const conversation = activeConversation()
  const messages = conversation?.messages ?? []
  $('empty').hidden = messages.length > 0
  for (const [index, message] of messages.entries()) {
    const row = document.createElement('article')
    row.className = `msg ${message.role}`
    const role = document.createElement('div')
    role.className = 'msg-role'
    role.textContent = message.role === 'user' ? 'EU' : 'IA'
    const body = document.createElement('div')
    body.className = 'msg-body'
    const text = document.createElement('div')
    text.className = 'msg-text'
    if (message.role === 'assistant') {
      text.innerHTML = renderMarkdown(message.content)
      if (message.streaming)
        text.classList.add('cursor')
      if (message.provider)
        body.dataset.provider = `${message.provider}${message.model ? ` · ${message.model}` : ''}`
    } else {
      text.textContent = message.content
    }
    body.appendChild(text)
    if (!message.streaming)
      body.appendChild(messageActions(message, index))
    row.append(role, body)
    container.appendChild(row)
  }
  if (lastError) {
    const box = document.createElement('div')
    box.className = 'error-box'
    box.innerHTML = `<strong>Falha ao responder.</strong> ${lastError.html}`
    const dismiss = document.createElement('button')
    dismiss.type = 'button'
    dismiss.className = 'chip-btn'
    dismiss.textContent = 'dispensar'
    dismiss.addEventListener('click', dismissError)
    box.appendChild(dismiss)
    container.appendChild(box)
  }
  container.scrollTop = container.scrollHeight
}

let lastError = null

const ERROR_TEXT = {
  gateway_unreachable: () => `O gateway não respondeu em <b>${escapeHtml(gatewayBase())}</b>. Rode <code>npm run gateway:dev</code> e confira a URL em Configurações.`,
  unauthorized: () => 'Token recusado pelo gateway. Abra Configurações, cole o token de <code>~/.dz23/gateway-token</code> e clique em Salvar.',
  provider_not_configured: () => 'O provedor escolhido não tem credencial no gateway. Configure a chave no gateway ou escolha outro provedor.',
  auth_failed: () => 'O provedor recusou a credencial. A chave configurada está inválida ou expirada.',
  rate_limited: () => 'Muitas requisições para o provedor. Aguarde alguns segundos e tente de novo.',
  timeout: () => 'O provedor não respondeu a tempo. Tente novamente ou escolha outro modelo.',
  model_not_available: () => 'O modelo escolhido não está na lista deste provedor. Atualize a seleção.',
  unknown_provider: () => 'Provedor inválido ou desabilitado no gateway.',
  bad_request: () => 'O pedido foi recusado pelo gateway. Verifique a mensagem e o contexto enviado.',
  upstream_error: () => 'O provedor retornou erro. Veja os logs do gateway para o detalhe.',
  send_failed: () => 'Não foi possível enviar a mensagem. Recarregue o painel e tente de novo.',
}

// Kept in the conversation view: an error that disappears on the next render is indistinguishable from silence
function renderError (error) {
  const code = error?.code ?? 'error'
  lastError = {
    code,
    html: ERROR_TEXT[code]?.() ?? escapeHtml(String(error?.message ?? error)),
  }
  renderMessages()
}

function dismissError () {
  lastError = null
  renderMessages()
}

function renderChip () {
  const conversation = activeConversation()
  const ctx = conversation?.context ?? {}
  const parts = [ctx.asset, ctx.timeframe, ctx.strategy].filter(Boolean)
  $('ctxLabel').textContent = parts.length ? parts.join(' · ') : 'sem contexto'
  $('ctxChip').title = 'Contexto enviado ao modelo: ' + (parts.length ? parts.join(' · ') : 'apenas a conversa')
}

function renderSelectors (providers = []) {
  const providerSelect = $('providerSelect')
  const modelSelect = $('modelSelect')
  const configured = providers.filter((provider) => provider.configured)
  const visible = configured.length ? configured : providers
  providerSelect.innerHTML = ''
  for (const provider of visible) {
    const option = document.createElement('option')
    option.value = provider.id
    option.textContent = provider.configured ? provider.label : `${provider.label} (sem chave)`
    providerSelect.appendChild(option)
  }
  if (!visible.length) {
    // sem gateway: um placeholder explícito em cada seletor, nunca duas caixas vazias
    for (const [select, text] of [[providerSelect, 'sem gateway'], [modelSelect, '—']]) {
      select.innerHTML = ''
      const placeholder = document.createElement('option')
      placeholder.value = ''
      placeholder.textContent = text
      select.appendChild(placeholder)
    }
    return
  }
  if (!visible.some((provider) => provider.id === state.settings.provider))
    state.settings.provider = visible[0]?.id ?? ''
  providerSelect.value = state.settings.provider

  const provider = visible.find((item) => item.id === state.settings.provider)
  const models = state.settings.modelsByProvider[state.settings.provider] ?? provider?.models ?? []
  modelSelect.innerHTML = ''
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    modelSelect.appendChild(option)
  }
  if (!models.length) {
    const option = document.createElement('option')
    option.textContent = 'sem modelos'
    modelSelect.appendChild(option)
  }
  const preferred = provider?.defaultModel ?? models[0] ?? ''
  if (!models.includes(state.settings.model))
    state.settings.model = preferred
  modelSelect.value = state.settings.model
  save()
}

// Greeting by the local hour, like the reference screen, and the configured name when there is one
function greet () {
  const hour = new Date().getHours()
  const part = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'
  const name = (state.settings.user && state.settings.user !== 'local') ? `, ${state.settings.user}` : ''
  $('greeting').textContent = `${part}${name}.`
}

function renderAll () {
  greet()
  const active = activeConversation()
  $('messages').classList.toggle('empty', !active || !active.messages.length)
  renderHistory()
  renderMessages()
  renderChip()
  const conversation = activeConversation()
  const suggestionsBox = $('suggestions')
  if (!suggestionsBox.childElementCount) {
    for (const text of SUGGESTIONS) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'suggestion'
      button.textContent = text
      button.addEventListener('click', () => {
        $('input').value = text
        $('input').focus()
      })
      suggestionsBox.appendChild(button)
    }
  }
  if (!conversation)
    $('empty').hidden = false
}

/* --------------------------------------------------------------- behavior */

let controller = null
let requestId = null

// Candles for the chart currently shown. Keyed by symbol|timeframe so a stale load never leaks into another chart.
let chartCandles = { key: '', candles: null, source: '', error: '' }

function candlesKey (context) {
  return context ? `${context.symbol ?? ''}|${context.timeframe ?? ''}` : ''
}

async function loadChartCandles (context) {
  const key = candlesKey(context)
  if (!key || chartCandles.key === key)
    return
  chartCandles = { key, candles: null, source: '', error: '' }
  try {
    const result = await fetchCandles({ context })
    if (candlesKey(charts.get(activeTabId)) !== key)
      return // the user changed chart while the request was in flight
    if (result.ok) {
      // §3.6: os candles precisam ser do ativo/exchange/timeframe do gráfico — não basta o pedido ter sido feito.
      const matches = candlesMatchContext(charts.get(activeTabId) ?? context, { symbol: result.symbol, exchange: result.exchange, timeframe: result.timeframe })
      chartCandles = matches.ok
        ? { key, candles: result.candles, source: result.source, error: '' }
        : { key, candles: null, source: '', error: `candles descartados: ${matches.reason}` }
    } else {
      chartCandles = { key, candles: null, source: '', error: result.reason }
    }
  } catch (error) {
    chartCandles = { key, candles: null, source: '', error: String(error?.message ?? error) }
  }
  // the dialog and the next message must see the candles
  renderChart()
}

function buildSystemPrompt (conversation) {
  const ctx = conversation?.context ?? {}
  const lines = [SYSTEM_PREAMBLE, '', 'Contexto do trading (fornecido pelo usuário):']
  lines.push(`- Ativo: ${ctx.asset || 'não informado'}`)
  lines.push(`- Timeframe: ${ctx.timeframe || 'não informado'}`)
  if (ctx.strategy)
    lines.push(`- Estratégia: ${ctx.strategy}`)
  if (ctx.notes)
    lines.push(`- Notas do experimento: ${ctx.notes}`)
  const remembered = memoryBlock(memory.list(state.settings.user, ctx.strategy))
  if (remembered)
    lines.push('', remembered)
  const activeChart = charts.get(activeTabId)
  const chart = contextBlock({
    context: activeChart,
    candles: chartCandles.candles,
    indicators: activeChart?.indicators ?? [],
    source: chartCandles.source || null,
  })
  // Aritmética sobre os mesmos candles: o modelo cita números com procedência em vez de descrever velas
  const intel = summarizeMarket({ candles: chartCandles.candles ?? [], context: activeChart, source: chartCandles.source || null })
  const intelText = marketIntelBlock(intel)
  if (chart.text)
    lines.push('', chart.text)
  if (intelText)
    lines.push('', intelText)
  lines.push('', 'Se o contexto não bastar para responder com evidência, diga o que falta.')
  return lines.join('\n')
}

function setStreaming (isStreaming) {
  $('send').disabled = isStreaming
  $('send').hidden = isStreaming
  $('stop').hidden = !isStreaming
}

const pending = []

// Attachments are validated before they are read, and only text reaches the message
function renderChips () {
  const box = $('chips')
  box.innerHTML = ''
  for (const [index, item] of pending.entries()) {
    const chip = document.createElement('span')
    chip.className = 'pill'
    chip.textContent = attachmentSummary(item)
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'chip-btn'
    remove.textContent = '×'
    remove.setAttribute('aria-label', `remover ${item.name}`)
    remove.addEventListener('click', () => { pending.splice(index, 1); renderChips() })
    chip.appendChild(remove)
    box.appendChild(chip)
  }
}

async function attachFiles (fileList) {
  for (const file of fileList ?? []) {
    const validation = validateFile({ name: file.name, type: file.type, size: file.size }, { count: pending.length })
    if (!validation.ok) { renderStatus('bad', validation.message); continue }
    const content = await file.text()
    pending.push(attachmentText(file.name, content))
    renderChips()
  }
}

// Applies a symbol/timeframe change and only reports success after reading the chart back.
// Sofia: the panel's own chart, candles and metrics are the only evidence the specialists get
async function runSofia () {
  const button = $('sofia')
  const label = $('sofiaState')
  const context = charts.get(activeTabId)
  const question = ($('input').value || '').trim() || 'Como está o contexto do gráfico agora e o que invalidaria?'
  const intel = summarizeMarket({ candles: chartCandles.candles ?? [], context, source: chartCandles.source || null })
  if (!intel.available) {
    label.textContent = 'sem candles do gráfico: os especialistas não têm evidência (abra um gráfico e aguarde o carregamento)'
    label.className = 'sofia-state bad'
    return
  }
  button.disabled = true
  label.className = 'sofia-state'
  label.textContent = 'consultando especialistas…'

  // Mesma memória que o chat usa: sem isso o botão Sofia responderia ignorando as notas do usuário.
  const notes = memory.list(state.settings.user, charts.get(activeTabId)?.strategy)
  const plan = planRun({ question, intel, hasCandles: true, memoryNotes: notes })
  const provider = state.settings.provider
  const model = state.settings.model
  const callModel = async ({ prompt }) => {
    let answer = ''
    await streamChat({ provider, model, fallback: true, stream: true, messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: 'Responda com o JSON do contrato.' },
    ] }, {
      onEvent: (event) => {
        if (event.type === 'delta')
          answer += event.text
        else if (event.type === 'done' && event.text && !answer)
          answer = event.text
      },
    })
    return { text: answer, model }
  }

  try {
    const run = await runAgents({ plan, callModel, timeoutMs: 60_000 })
    const conversation = activeConversation() ?? newConversation()
    conversation.messages.push({
      role: 'assistant',
      content: summarizeRun(run) + '\n\nTrace: ' + run.trace.id,
      at: new Date().toISOString(),
      provider,
      model,
      sofia: true,
    })
    save()
    renderAll()
    label.className = run.ok ? 'sofia-state ok' : 'sofia-state bad'
    label.textContent = run.ok
      ? `${run.trace.entries.filter((entry) => entry.status === 'ok').length}/${run.trace.entries.length} parecer(es) · consenso: ${run.result.consensus ? 'sim' : 'não'}`
      : 'nenhum parecer válido — veja a mensagem'
  } catch (error) {
    label.className = 'sofia-state bad'
    label.textContent = `falhou: ${String(error?.message ?? error).slice(0, 80)}`
  } finally {
    button.disabled = false
  }
}


// Comparação multi-timeframe no painel: mesmos candles e as mesmas métricas do diálogo, para três timeframes.
// O ativo vem do gráfico ativo (ou do campo de ação); nada é inventado se a fonte não cobrir o período.
const COMPARE_TIMEFRAMES = ['15m', '1h', '4h']


// Comparação entre o ativo do gráfico e o que o usuário digitar, no MESMO timeframe: sem timeframe igual não há comparação.
async function compareAssetsFromChart () {
  const box = $('compareResult')
  if (!box)
    return
  box.hidden = false
  box.className = 'action-result'
  const context = charts.get(activeTabId)
  const left = normalizeSymbol($('actSymbol').value || context?.symbol)
  const right = normalizeSymbol($('compareSymbol').value)
  if (!left.ok || !right.ok) {
    box.textContent = `comparação não feita: ${!left.ok ? left.reason : right.reason}`
    box.className = 'action-result bad'
    return
  }
  if (left.symbol === right.symbol) {
    box.textContent = 'comparação não feita: escolha dois ativos diferentes'
    box.className = 'action-result bad'
    return
  }
  const timeframe = context?.timeframe ?? '1h'
  const resolution = { '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': '1440' }[timeframe] ?? '60'
  box.textContent = 'lendo os dois ativos…'
  const entries = []
  const failures = []
  for (const symbol of [left.symbol, right.symbol]) {
    try {
      const result = await fetchCandles({ context: { symbol, exchange: 'BINANCE', timeframe, resolution } })
      if (!result.ok) {
        failures.push(`${symbol}: ${result.reason}`)
        continue
      }
      const candles = result.candles
      const last = candles.at(-1)
      const previous = candles.at(-2)
      const intel = summarizeMarket({ candles, context: { timeframe, symbol }, source: result.source })
      const recent = candles.slice(-20)
      const volumeAverage = recent.reduce((total, candle) => total + (Number(candle.volume) || 0), 0) / Math.max(recent.length, 1)
      entries.push({
        symbol,
        price: last?.close ?? null,
        changePercent: previous?.close ? ((last.close - previous.close) / previous.close) * 100 : null,
        volumeRatio: volumeAverage > 0 && Number(last?.volume) > 0 ? Number(last.volume) / volumeAverage : null,
        intel,
        source: result.source,
      })
    } catch (error) {
      failures.push(`${symbol}: ${String(error?.message ?? error).slice(0, 60)}`)
    }
  }
  const comparison = compareAssets(entries, { timeframe })
  const lines = [describeAssetComparison(comparison)]
  for (const failure of failures)
    lines.push(`- sem dados em ${failure}`)
  box.textContent = lines.join('\n')
  box.className = comparison.ok ? 'action-result ok' : 'action-result bad'
  return comparison
}

async function compareFromChart () {
  const box = $('compareResult')
  if (!box)
    return
  box.hidden = false
  box.className = 'action-result'
  box.textContent = 'lendo 3 timeframes…'
  const context = charts.get(activeTabId)
  const symbol = normalizeSymbol($('actSymbol').value || context?.symbol)
  if (!symbol.ok) {
    box.textContent = `comparação não feita: ${symbol.reason}`
    box.className = 'action-result bad'
    return
  }
  const entries = []
  const failures = []
  for (const timeframe of COMPARE_TIMEFRAMES) {
    try {
      const result = await fetchCandles({ context: { symbol: symbol.symbol, exchange: 'BINANCE', timeframe, resolution: timeframe === '1h' ? '60' : timeframe === '4h' ? '240' : '15' } })
      if (!result.ok) {
        failures.push(`${timeframe}: ${result.reason}`)
        continue
      }
      const intel = summarizeMarket({ candles: result.candles, context: { timeframe, symbol: symbol.symbol }, source: result.source })
      entries.push({ timeframe, price: result.candles.at(-1)?.close ?? null, intel })
    } catch (error) {
      failures.push(`${timeframe}: ${String(error?.message ?? error).slice(0, 60)}`)
    }
  }
  const comparison = compareTimeframes(entries)
  const lines = [describeComparison(comparison)]
  for (const failure of failures)
    lines.push(`- sem dados em ${failure}`)
  box.textContent = lines.join('\n')
  box.className = comparison.ok ? 'action-result ok' : 'action-result bad'
  return comparison
}

async function applyChartAction (change) {
  const result = $('actionResult')
  result.textContent = 'aplicando…'
  result.className = 'action-result'
  const context = charts.get(activeTabId)
  const built = buildActionUrl({ href: document.baseURI, current: context, change })
  if (!built.ok) {
    result.textContent = `não aplicado: ${built.reason}`
    result.className = 'action-result bad'
    return
  }
  const runtime = runtimeApi()
  const sent = await new Promise((resolve) => {
    try {
      runtime.sendMessage({ type: 'dz23:chart:apply', tabId: activeTabId, url: built.url }, (reply) => {
        void runtime.lastError
        resolve(reply ?? { ok: false, reason: 'sem resposta do worker' })
      })
    } catch (error) {
      resolve({ ok: false, reason: String(error?.message ?? error) })
    }
  })
  if (!sent.ok) {
    result.textContent = `não aplicado: ${sent.reason ?? 'worker recusou'}`
    result.className = 'action-result bad'
    return
  }

  // The page reloads: wait for the bridge to report the new chart, then compare.
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 800))
    let observation = null
    try {
      const reply = await pingChart()
      observation = reply?.observation ?? null
      if (observation)
        charts.apply(activeTabId, observation)
      renderChart()
    } catch (error) {
      result.textContent = `aplicado, mas a releitura falhou: ${String(error?.message ?? error).slice(0, 90)}`
      result.className = 'action-result bad'
      return
    }
    const verification = verifyAction(built.expected, observation)
    if (verification.ok) {
      result.textContent = describeAction({ verified: true, expected: built.expected })
      result.className = 'action-result ok'
      renderChart()
      return
    }
  }
  const last = verifyAction(built.expected, (await pingChart())?.observation ?? null)
  result.textContent = describeAction({ verified: false, expected: built.expected, mismatches: last.mismatches })
  result.className = 'action-result bad'
}

async function send (text) {
  try {
    await sendMessage(text)
  } catch (error) {
    // a throw outside the request would leave the composer stuck and silent: report it instead
    console.error('[dz23] send falhou', error)
    renderError(Object.assign(new Error(String(error?.message ?? error)), { code: error?.code ?? 'send_failed' }))
    if (typeof controller !== 'undefined' && controller)
      controller = null
    setStreaming(false)
    renderAll()
  }
}

async function sendMessage (text) {
  lastError = null
  const typed = String(text ?? '').trim()
  const content = [typed, ...pending.map(renderForMessage)].filter(Boolean).join('\n\n')
  if (!content || controller)
    return
  const conversation = activeConversation() ?? newConversation()
  conversation.messages.push({ role: 'user', content, at: new Date().toISOString() })
  if (conversation.title === 'Nova conversa')
    conversation.title = content.slice(0, 44) + (content.length > 44 ? '…' : '')
  const assistant = { role: 'assistant', content: '', streaming: true, provider: state.settings.provider, model: state.settings.model, at: new Date().toISOString() }
  conversation.messages.push(assistant)
  conversation.updatedAt = new Date().toISOString()
  save()
  $('input').value = ''
  renderAll()
  setStreaming(true)

  controller = new AbortController()
  requestId = `r${Date.now()}`
  const payload = {
    provider: state.settings.provider,
    model: state.settings.model,
    requestId,
    // O gateway troca de provedor só se este falhar antes de entregar texto; a troca é anunciada num evento notice.
    fallback: true,
    system: buildSystemPrompt(conversation),
    messages: conversation.messages
      .filter((message) => !message.streaming)
      .map((message) => ({ role: message.role, content: message.content })),
  }

  try {
    await streamChat(payload, {
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === 'delta') {
          assistant.content += event.text
          renderMessages()
        } else if (event.type === 'done') {
          if (event.text && !assistant.content)
            assistant.content = event.text
          assistant.streaming = false
          // Proveniência vem do gateway: com fallback, o provedor que respondeu não é o pedido.
          assistant.provider = event.provider ?? payload.provider
          assistant.model = event.model ?? payload.model
          if (assistant.notice)
            assistant.content = `${assistant.content}\n\n_${assistant.notice}_`.trim()
        } else if (event.type === 'notice') {
          // Transparência: o texto abaixo não veio do provedor escolhido.
          if (event.code === 'provider_fallback')
            assistant.notice = `provedor alternativo: ${event.from} → ${event.to} (o primeiro falhou antes de responder)`
        } else if (event.type === 'error') {
          assistant.streaming = false
          throw Object.assign(new Error(event.error?.message ?? 'erro'), { code: event.error?.code })
        } else if (event.type === 'cancelled') {
          assistant.streaming = false
          assistant.content += assistant.content ? '' : '(cancelado)'
        }
      },
    })
  } catch (error) {
    assistant.streaming = false
    // an empty bubble with buttons and no text reads as a broken answer: drop it and show the error
    if (!String(assistant.content ?? '').trim())
      conversation.messages = conversation.messages.filter((message) => message !== assistant)
    if (error.name !== 'AbortError' && error.code !== 'cancelled')
      renderError(error)
    renderMessages()
  } finally {
    assistant.streaming = false
    controller = null
    requestId = null
    conversation.updatedAt = new Date().toISOString()
    save()
    setStreaming(false)
    renderAll()
  }
}

function stop () {
  if (!controller)
    return
  const id = requestId
  controller.abort()
  if (id)
    gatewayFetch('/cancel', { method: 'POST', body: JSON.stringify({ requestId: id }) }).catch(() => {})
}

function regenerate (index) {
  const conversation = activeConversation()
  if (!conversation)
    return
  const message = conversation.messages[index]
  if (!message || message.role !== 'assistant')
    return
  conversation.messages.splice(index, 1)
  const lastUser = [...conversation.messages].reverse().find((item) => item.role === 'user')
  save()
  renderAll()
  if (lastUser)
    send(lastUser.content)
}

function rate (index, value) {
  const conversation = activeConversation()
  const message = conversation?.messages[index]
  if (!message)
    return
  message.rating = message.rating === value ? null : value
  save()
  renderMessages()
}

/* ------------------------------------------------------------------ wiring */

let gatewayAutostartTried = false

// Asks the native host to start the gateway (one attempt per page load). A browser without the host answers nothing
// and the UI keeps saying "gateway off-line" — no spinner that never ends.
async function autostartGateway () {
  if (gatewayAutostartTried)
    return false
  gatewayAutostartTried = true
  const runtime = runtimeApi()
  if (!runtime?.sendMessage)
    return false
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 20_000)
    try {
      runtime.sendMessage({ type: 'dz23:gateway:ensure' }, (reply) => {
        clearTimeout(timer)
        void runtime.lastError
        resolve(Boolean(reply?.ok))
      })
    } catch {
      clearTimeout(timer)
      resolve(false)
    }
  })
}

async function refreshStatus () {
  try {
    const response = await fetch(`${gatewayBase()}/health`)
    const body = await response.json()
    if (body.status !== 'ok')
      throw new Error('not ok')
    if (!body.configured) {
      renderStatus('warn', 'gateway on-line, sem provedor configurado')
    $('setupHint').hidden = false
    } else {
      renderStatus('ok', `gateway on-line · ${body.configured} provedor(es)`)
    $('setupHint').hidden = true
    }
    return true
  } catch {
    renderStatus('bad', 'gateway off-line · tentando iniciar…')
    $('setupHint').hidden = false
    if (await autostartGateway()) {
      try {
        const retry = await fetch(`${gatewayBase()}/health`).then((response) => response.json())
        if (retry?.status === 'ok' && retry.configured) {
          renderStatus('ok', `gateway on-line · ${retry.configured} provedor(es)`)
          $('setupHint').hidden = true
          await ensureToken()
          await refreshProviders()
          return true
        }
      } catch {
        /* segue offline */
      }
    }
    renderStatus('bad', 'gateway off-line')
    return false
  }
}

async function refreshProviders () {
  try {
    const providers = await fetchProviders()
    renderSelectors(providers)
    return providers
  } catch (error) {
    renderStatus('bad', error.code === 'unauthorized' ? 'token recusado' : 'gateway off-line')
    renderSelectors([])
    return []
  }
}

async function openSettings () {
  $('gatewayUrl').value = state.settings.gatewayUrl
  $('settingsUserInput').value = state.settings.user === 'local' ? '' : state.settings.user
  $('settingsUser').textContent = state.settings.user || 'local'
  $('settingsAvatar').textContent = (state.settings.user || 'L').slice(0, 1)
  $('gatewayToken').value = state.settings.token
  const box = $('providerSettings')
  box.innerHTML = '<p class="hint">carregando…</p>'
  $('settings').showModal()
  let providers = []
  try {
    providers = await fetchProviders()
  } catch (error) {
    box.innerHTML = `<p class="error-box">${escapeHtml(error.code === 'unauthorized' ? 'Token recusado: salve o token correto abaixo.' : 'Gateway indisponível: inicie o processo local.')}</p>`
    return
  }
  box.innerHTML = ''
  for (const provider of providers) {
    const row = document.createElement('div')
    row.className = 'prov-row'
    const name = document.createElement('span')
    name.className = 'prov-name'
    name.textContent = provider.label
    const status = document.createElement('span')
    status.className = `prov-state${provider.configured ? ' ok' : ''}`
    status.textContent = provider.configured ? 'configurado' : 'sem chave'
    const test = document.createElement('button')
    test.type = 'button'
    test.className = 'chip-btn'
    test.textContent = 'testar'
    test.disabled = !provider.configured
    test.addEventListener('click', async () => {
      test.textContent = 'testando…'
      try {
        const response = await gatewayFetch('/test', { method: 'POST', body: JSON.stringify({ provider: provider.id }) })
        const body = await response.json()
        status.textContent = `ok · ${body.latencyMs} ms`
        status.className = 'prov-state ok'
      } catch (error) {
        status.textContent = error.code
        status.className = 'prov-state'
      }
      test.textContent = 'testar'
    })
    const diagnose = document.createElement('button')
    diagnose.type = 'button'
    diagnose.className = 'chip-btn'
    diagnose.textContent = 'diagnóstico'
    diagnose.disabled = !provider.configured
    diagnose.addEventListener('click', async () => {
      diagnose.textContent = 'diagnosticando…'
      try {
        const response = await gatewayFetch('/diagnose', { method: 'POST', body: JSON.stringify({ provider: provider.id }) })
        const body = await response.json()
        // credential/auth/streaming/cancel, each one backed by a real request made by the gateway
        status.textContent = body.checks.map((check) => `${check.name}:${check.ok ? 'ok' : 'falha'}`).join(' · ')
        status.className = body.ok ? 'prov-state ok' : 'prov-state'
      } catch (error) {
        status.textContent = error.code
        status.className = 'prov-state'
      }
      diagnose.textContent = 'diagnóstico'
    })
    row.append(name, status, test, diagnose)
    box.appendChild(row)
  }
}

function openContext () {
  const conversation = activeConversation() ?? newConversation()
  $('ctxAsset').value = conversation.context.asset ?? ''
  $('ctxTimeframe').value = conversation.context.timeframe ?? ''
  $('ctxStrategy').value = conversation.context.strategy ?? ''
  $('ctxNotes').value = conversation.context.notes ?? ''
  $('ctxMemory').value = memory.list(state.settings.user, $('ctxStrategy').value).join('\n')
  const preview = () => {
    const draft = {
      context: {
        asset: $('ctxAsset').value,
        timeframe: $('ctxTimeframe').value,
        strategy: $('ctxStrategy').value,
        notes: $('ctxNotes').value,
      },
    }
    $('ctxPreview').textContent = buildSystemPrompt(draft)  }
  for (const id of ['ctxAsset', 'ctxTimeframe', 'ctxStrategy', 'ctxNotes'])
    $(id).oninput = preview
  preview()
  $('ctxDialog').showModal()
}


// --- active chart -------------------------------------------------------------------------------------------
// The page reports its chart; the copilot keeps one context per tab so two tabs never mix.
const charts = createChartStore()
let activeTabId = null

// The Chrome APIs arrive through these two accessors: inside the extension they are chrome.*, and the E2E
// harness injects its own so the real detection path runs without fighting a non-writable window.chrome.
const tabsApi = () => globalThis.__dz23Tabs ?? (typeof chrome !== 'undefined' ? chrome.tabs : null)
const runtimeApi = () => globalThis.__dz23Runtime ?? (typeof chrome !== 'undefined' ? chrome.runtime : null)

function renderChart () {
  const context = charts.get(activeTabId)
  const view = describeContext(context)
  $('chartLabel').textContent = view.state === 'off' ? 'Sem gráfico ativo' : `Gráfico ativo: ${view.label}`
  $('chartChip').dataset.state = view.state
  $('chartChip').title = view.detail
  const intel = summarizeMarket({ candles: chartCandles.candles ?? [], context, source: chartCandles.source || null })
  // O diálogo usa exatamente as mesmas entradas do prompt: contexto, candles, indicadores e métricas
  $('chartDetail').textContent = [
    contextBlock({ context, candles: chartCandles.candles, indicators: context?.indicators ?? [], source: chartCandles.source || null }).text || view.detail,
    marketIntelBlock(intel),
  ].filter(Boolean).join('\n\n')
}

// After an extension reload the content script is gone from open tabs: ask the worker to inject it again
function ensureBridge (tabId) {
  const runtime = runtimeApi()
  if (!runtime?.sendMessage)
    return Promise.resolve(false)
  return new Promise((resolve) => {
    try {
      runtime.sendMessage({ type: 'dz23:chart:ensure', tabId }, (reply) => {
        void runtime.lastError
        resolve(Boolean(reply?.ok))
      })
    } catch {
      resolve(false)
    }
  })
}

// One ping to the bridge, shared by the refresh and by the action verification. The verification must not read the
// UI cache: it expires, and a cached glance is not evidence.
async function pingChart () {
  const tabs = tabsApi()
  const runtime = runtimeApi()
  if (!tabs?.sendMessage || !activeTabId)
    return null
  return new Promise((resolve) => {
    tabs.sendMessage(activeTabId, { type: 'dz23:chart:ping' }, (response) => {
      if (runtime?.lastError)
        return resolve(null)
      resolve(response ?? null)
    })
  })
}

async function refreshChart () {
  const tabs = tabsApi()
  const runtime = runtimeApi()
  if (!tabs?.query)
    return renderChart()
  try {
    const [tab] = await tabs.query({ active: true, currentWindow: true })
    activeTabId = Number.isInteger(tab?.id) ? tab.id : null
    if (!activeTabId)
      return renderChart()
    if (!/tradingview\.com/.test(tab.url ?? '')) {
      charts.apply(activeTabId, { source: 'none' })
      return renderChart()
    }
    // One ping per activation: no polling loop, and a closed tab simply has no context
    const ping = () => new Promise((resolve) => {
      tabs.sendMessage(activeTabId, { type: 'dz23:chart:ping' }, (response) => {
        if (runtime?.lastError)
          return resolve(null)
        resolve(response)
      })
    })
    let reply = await ping()
    if (!reply) {
      // nobody answered: the worker re-injects the bridge, and one more ping is enough
      await ensureBridge(activeTabId)
      reply = await ping()
    }
    charts.apply(activeTabId, reply?.observation ?? { source: 'none' })
    loadChartCandles(charts.get(activeTabId))
  } catch {
    if (activeTabId)
      charts.apply(activeTabId, { source: 'none' })
  }
  renderChart()
}

// Zero-typing pairing: the local gateway hands out its own token in development. A production gateway answers 404
// and the panel simply asks for the token in the settings dialog.
// Pede o token ao host nativo: caminho de produção, onde /token não é servido.
function tokenFromNativeHost () {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'dz23:gateway:token' }, (reply) => {
        if (chrome.runtime.lastError || !reply?.ok)
          resolve(null)
        else
          resolve(reply.token ? { token: reply.token, source: 'native-host' } : null)
      })
    } catch {
      resolve(null)
    }
  })
}

async function ensureToken () {
  if (state.settings.token)
    return true
  try {
    const response = await fetch(new URL('/token', gatewayBase()))
    if (!response.ok) {
      // produção: /token não existe; o host nativo entrega o token sem o usuário copiar nada
      const native = await tokenFromNativeHost()
      if (!native)
        return false
      await save({ gateway: { token: native.token } })
      state.settings.token = native.token
      return true
    }
    const body = await response.json()
    if (!body?.token || typeof body.token !== 'string')
      return false
    state.settings.token = body.token
    save()
    return true
  } catch {
    return false
  }
}

async function boot () {
  // The shared config wins over the localStorage cache: it is what the popup writes too.
  try {
    const loaded = await configStore.load()
    if (loaded.migrated || loaded.config.gateway.token || loaded.config.ai.provider) {
      state.settings = { ...state.settings, ...toSettings(loaded.config) }
      if (loaded.migrated)
        loadReport = { repaired: false, reason: 'configuração migrada para o formato único' }
    }
    if (loaded.issues.length)
      console.warn('[dz23] configuração:', loaded.issues.join('; '))
  } catch (error) {
    console.warn('[dz23] configuração indisponível:', error)
  }

  $('chartChip').addEventListener('click', async () => {
    $('chartDialog').showModal()
    const context = charts.get(activeTabId)
  // One source for the dialog: the same cache the prompt uses, so context, candles and metrics never disagree
  if (context) {
    chartCandles = { key: '', candles: null, source: '', error: '' }
    await loadChartCandles(context)
  }
  renderChart()
  })
  renderChart()
  refreshChart()
  const runtime = runtimeApi()
  const tabs = tabsApi()
  if (runtime?.onMessage)
    runtime.onMessage.addListener((message, sender) => {
      if (message?.type !== 'dz23:chart')
        return
      const tabId = sender?.tab?.id
      if (!Number.isInteger(tabId))
        return
      charts.apply(tabId, message.observation)
      if (tabId === activeTabId)
        renderChart()
    })
  if (tabs?.onRemoved)
    tabs.onRemoved.addListener((tabId) => { charts.remove(tabId); renderChart() })
  if (tabs?.onActivated)
    tabs.onActivated.addListener(() => refreshChart())
  // Cheap freshness tick: only re-renders the chip, never polls the page
  setInterval(renderChart, 5000)
  $('composer').addEventListener('submit', (event) => {
    event.preventDefault()
    send($('input').value)
  })
  $('input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send($('input').value)
    }
  })
  $('input').addEventListener('input', () => {
    const area = $('input')
    area.style.height = 'auto'
    area.style.height = `${Math.min(area.scrollHeight, 180)}px`
  })
  $('send').addEventListener('click', () => send($('input').value))
  $('attach').addEventListener('click', () => $('files').click())
  $('files').addEventListener('change', async (event) => {
    await attachFiles(event.target.files)
    event.target.value = ''
  })
  $('stop').addEventListener('click', stop)
  $('newChat').addEventListener('click', () => { newConversation(); renderAll() })
  $('openSettings').addEventListener('click', openSettings)
  $('closeSettings')?.addEventListener('click', () => $('settings').close())
  $('openFullSettings')?.addEventListener('click', () => {
    const runtime = runtimeApi()
    const url = runtime?.getURL?.('settings/index.html') ?? '../settings/index.html'
  // A tela está declarada como options_ui: a API padrão evita uma segunda forma de abrir a mesma página.
  if (runtime?.openOptionsPage) {
    runtime.openOptionsPage()
    return
  }
    const tabs = tabsApi()
    if (tabs?.create)
      tabs.create({ url })
    else
      window.open(url, '_blank')
  })
  $('testConnection').addEventListener('click', async () => {
    const result = $('connResult')
    result.className = 'conn-result'
    result.textContent = 'testando…'
    try {
      const base = $('gatewayUrl').value.trim() || DEFAULT_GATEWAY
      const token = $('gatewayToken').value.trim()
      const health = await fetch(new URL('/health', base)).then((response) => response.json())
      if (!health || health.status !== 'ok')
        throw Object.assign(new Error('health inesperado'), { code: 'bad_health' })
      let providers = []
      if (token) {
        const response = await fetch(new URL('/providers', base), { headers: { authorization: 'Bearer ' + token } })
        if (response.status === 401)
          throw Object.assign(new Error('token recusado'), { code: 'unauthorized' })
        providers = (await response.json()).providers ?? []
      }
      const configured = providers.filter((provider) => provider.configured)
      result.className = 'conn-result ok'
      result.textContent = token
        ? `gateway ok · ${configured.length} provedor(es): ${configured.map((provider) => provider.id).join(', ') || 'nenhum'}`
        : `gateway ok · falta o token (health respondeu)`
    } catch (error) {
      result.className = 'conn-result bad'
      result.textContent = error.code === 'unauthorized' ? 'token recusado pelo gateway' : `falhou: ${String(error.message).slice(0, 80)}`
    }
  })
  $('saveSettings').addEventListener('click', (event) => {
    event.preventDefault()
    state.settings.gatewayUrl = $('gatewayUrl').value.trim() || DEFAULT_GATEWAY
    state.settings.token = $('gatewayToken').value.trim()
    state.settings.user = $('settingsUserInput').value.trim() || 'local'
    save()
    $('settings').close()
    refreshStatus().then(async () => {
      await ensureToken()
      await refreshProviders()
    })
  })
  $('sofia')?.addEventListener('click', () => { void runSofia() })
  $('compareTimeframes')?.addEventListener('click', () => { void compareFromChart() })
  $('compareAssets')?.addEventListener('click', () => { void compareAssetsFromChart() })
  $('applyAction')?.addEventListener('click', () => {
    const symbol = $('actSymbol')?.value ?? ''
    const timeframe = $('actTimeframe')?.value ?? ''
    applyChartAction({ ...(symbol.trim() ? { symbol } : {}), ...(timeframe ? { timeframe } : {}) })
  })
  $('ctxEdit').addEventListener('click', openContext)
  $('saveCtx').addEventListener('click', (event) => {
    event.preventDefault()
    const conversation = activeConversation() ?? newConversation()
    conversation.context = {
      asset: $('ctxAsset').value.trim(),
      timeframe: $('ctxTimeframe').value.trim(),
      strategy: $('ctxStrategy').value.trim(),
      notes: $('ctxNotes').value.trim(),
    }
    // The memory belongs to (user, strategy): saving the context also saves the notes under that pair
    memory.replace(state.settings.user, conversation.context.strategy, $('ctxMemory').value.split('\n'))
    save()
    $('ctxDialog').close()
    renderChip()
  })
  $('expand').addEventListener('click', () => {
    if (window.chrome?.tabs?.create)
      window.chrome.tabs.create({ url: window.location.href })
    else
      window.open(window.location.href, '_blank', 'noopener')
  })
  // One owner for the rail state: toggle, close button, backdrop and picking a conversation all use it
  const setRail = (open) => $('app').classList.toggle('rail-open', Boolean(open))
  const narrow = window.matchMedia('(max-width: 760px)')
  $('toggleRail').addEventListener('click', () => setRail(!$('app').classList.contains('rail-open')))
  $('railClose').addEventListener('click', () => setRail(false))
  $('railBackdrop').addEventListener('click', () => setRail(false))
  narrow.addEventListener('change', () => setRail(false))
  $('providerSelect').addEventListener('change', (event) => {
    state.settings.provider = event.target.value
    state.settings.model = ''
    save()
    renderSelectors(renderSelectorsCache)
  })
  $('modelSelect').addEventListener('change', (event) => {
    state.settings.model = event.target.value
    if (!state.settings.modelsByProvider[state.settings.provider])
      state.settings.modelsByProvider[state.settings.provider] = []
    save()
  })

  if (!activeConversation())
    newConversation()
  renderAll()
  if (loadReport.repaired)
    renderStatus('warn', `histórico recuperado: ${loadReport.reason}`)
  refreshStatus().then(async (online) => {
    // pairing happens on every boot: a fresh install or a cleared storage reconnects without typing a token
    await ensureToken()
    if (online)
      refreshProviders().then((providers) => { renderSelectorsCache = providers })
  })
  setInterval(refreshStatus, 30_000)
}

let renderSelectorsCache = []
window.addEventListener('DOMContentLoaded', boot)
// Exposed for the automated UI test only: it reads the state the page persisted and the module it loaded
window.__dz23 = { state, renderMarkdown, buildSystemPrompt, send, chartState: () => ({ tabId: activeTabId, context: charts.get(activeTabId) }), applyChartAction, compareFromChart, compareAssetsFromChart, debugState: () => ({ busy: Boolean(controller), lastError: lastError?.code ?? null, gateway: state.settings.gatewayUrl, token: Boolean(state.settings.token), provider: state.settings.provider, model: state.settings.model, messages: activeConversation()?.messages.length ?? 0 }) }

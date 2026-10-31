// DZ23 — chart context: the single source of truth for "which chart is the copilot talking about".
//
// Pure functions, no chrome and no DOM, so the rules that matter are testable in Node: how a TradingView symbol
// becomes (exchange, symbol), how a resolution becomes a timeframe, how long an observation is valid, and what the
// model is told. Nothing here invents data: a missing candle set stays missing, with the reason.

import { indicatorLines } from './indicators.js'

export const CHART_CONTEXT_VERSION = 1
export const TTL_MS = 15_000

const RESOLUTION_TIMEFRAMES = {
  1: '1m', 3: '3m', 5: '5m', 15: '15m', 30: '30m', 45: '45m',
  60: '1h', 120: '2h', 180: '3h', 240: '4h', 360: '6h', 480: '8h', 720: '12h',
  D: '1D', '1D': '1D', '2D': '2D', '3D': '3D', W: '1W', '1W': '1W', M: '1M', '1M': '1M',
}

// "BINANCE:BTCUSDT" -> { exchange: 'BINANCE', symbol: 'BTCUSDT' }; a bare symbol keeps exchange null, never guessed
export function parseSymbol (raw) {
  const text = String(raw ?? '').trim().toUpperCase()
  if (!text)
    return null
  const [head, ...rest] = text.split(':')
  if (rest.length) {
    const symbol = rest.join(':').trim()
    if (!symbol || !head.trim())
      return null // a separator without an exchange is malformed
    return { exchange: head.trim(), symbol }
  }
  return { exchange: null, symbol: text }
}

const LABELLED_TIMEFRAME = /^(\d{1,3})(m|h|d|w)$/i

export function timeframeOf (resolution) {
  if (resolution === null || resolution === undefined || resolution === '')
    return null
  const text = String(resolution).trim()
  const labelled = text.match(LABELLED_TIMEFRAME)
  if (labelled) {
    const amount = Number(labelled[1])
    const unit = labelled[2].toLowerCase()
    if (unit === 'h') return RESOLUTION_TIMEFRAMES[amount * 60] ?? null
    if (unit === 'd') return amount === 1 ? '1D' : `${amount}D`
    if (unit === 'w') return amount === 1 ? '1W' : `${amount}W`
    return RESOLUTION_TIMEFRAMES[amount] ?? null
  }
  const key = text.toUpperCase()
  return RESOLUTION_TIMEFRAMES[key] ?? RESOLUTION_TIMEFRAMES[Number(key)] ?? null
}

/**
 * One observation of the page. `source: 'page'` means it came from the chart itself (DOM), `source: 'none'` means
 * there was no chart to read. The context carries when it was seen, so nobody can present an old observation as live.
 */
export function createChartContext ({ tabId, rawSymbol, resolution, source = 'page', observedAt = Date.now(), ttlMs = TTL_MS, url = null, indicators = [] } = {}) {
  const parsed = parseSymbol(rawSymbol)
  const timeframe = timeframeOf(resolution)
  const ok = Boolean(parsed?.symbol) && source === 'page'
  return {
    version: CHART_CONTEXT_VERSION,
    tabId: Number.isInteger(tabId) ? tabId : null,
    status: ok ? 'live' : 'unavailable',
    symbol: parsed?.symbol ?? null,
    exchange: parsed?.exchange ?? null,
    timeframe,
    source: ok ? 'page' : 'none',
    url: url ?? null,
    observedAt,
    expiresAt: observedAt + ttlMs,
    reason: ok ? null : (parsed?.symbol ? 'the chart did not report a timeframe' : 'no chart detected in this tab'),
    indicators: Array.isArray(indicators) ? indicators.slice(0, 20) : [],
  }
}

export function isFresh (context, now = Date.now()) {
  return Boolean(context) && context.status === 'live' && now < context.expiresAt
}

// An expired observation is explicitly stale: the UI can say so instead of showing it as current.
export function age (context, now = Date.now()) {
  if (!context)
    return 'none'
  if (now >= context.expiresAt)
    return 'stale'
  return now - context.observedAt < 2000 ? 'live' : 'recent'
}

export function sameChart (left, right) {
  if (!left || !right)
    return false
  return left.tabId === right.tabId && left.symbol === right.symbol && left.timeframe === right.timeframe
}

/**
 * The context of the active tab, and only that tab: a map keyed by tabId cannot leak another tab's chart, and a
 * context whose tab differs from the requested one is ignored instead of "closest match".
 */
export function contextForTab (contexts, tabId, now = Date.now()) {
  if (!Number.isInteger(tabId))
    return null
  const context = contexts instanceof Map ? contexts.get(tabId) : contexts?.[tabId]
  if (!context || context.tabId !== tabId)
    return null
  // Only a live observation can become stale; "unavailable" never had a chart to age
  if (context.status !== 'live')
    return context
  return isFresh(context, now) ? context : { ...context, status: 'stale' }
}

// Debounce for the page observer: one event per quiet window, with the latest value winning.
export function createDebouncer (delayMs, onFlush, now = () => Date.now()) {
  let timer = null
  let lastRun = 0
  let value
  return {
    push (next) {
      value = next
      lastRun = now()
      if (timer)
        return
      timer = setTimeout(() => {
        timer = null
        onFlush(value, lastRun)
      }, delayMs)
    },
    cancel () {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}

// --- candles ------------------------------------------------------------------------------------------------

const candleNumber = (value) => (typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : null))

/**
 * Validates rows as [time, open, high, low, close, volume] (or objects). A row that breaks the OHLC invariants is
 * rejected and counted, never repaired: a made-up candle is worse than a missing one.
 */
export function validateCandles (rows, { maxRows = 200 } = {}) {
  if (!Array.isArray(rows))
    return { ok: false, candles: [], rejected: 0, reason: 'no candle array was provided' }
  const candles = []
  let rejected = 0
  for (const row of rows) {
    const values = Array.isArray(row)
      ? { time: candleNumber(row[0]), open: candleNumber(row[1]), high: candleNumber(row[2]), low: candleNumber(row[3]), close: candleNumber(row[4]), volume: candleNumber(row[5]) }
      : { time: candleNumber(row?.time ?? row?.t), open: candleNumber(row?.open ?? row?.o), high: candleNumber(row?.high ?? row?.h), low: candleNumber(row?.low ?? row?.l), close: candleNumber(row?.close ?? row?.c), volume: candleNumber(row?.volume ?? row?.v) }
    const { time, open, high, low, close, volume } = values
    const invalid = [time, open, high, low, close, volume].some((value) => !Number.isFinite(value)) ||
      high < low || high < Math.max(open, close) || low > Math.min(open, close) || volume < 0
    if (invalid) {
      rejected += 1
      continue
    }
    candles.push({ time, open, high, low, close, volume })
  }
  if (!candles.length)
    return { ok: false, candles, rejected, reason: rejected ? `all ${rejected} rows were invalid` : 'the source returned no candles' }
  candles.sort((left, right) => left.time - right.time)
  const capped = candles.slice(-maxRows)
  return { ok: true, candles: capped, rejected, truncated: candles.length > capped.length, reason: null }
}

export function candleSummary (candles) {
  if (!Array.isArray(candles) || !candles.length)
    return null
  const first = candles[0]
  const last = candles[candles.length - 1]
  const highs = candles.map((candle) => candle.high)
  const lows = candles.map((candle) => candle.low)
  return {
    count: candles.length,
    from: first.time,
    to: last.time,
    lastClose: last.close,
    high: Math.max(...highs),
    low: Math.min(...lows),
    volume: candles.reduce((total, candle) => total + candle.volume, 0),
  }
}

/**
 * One candle set belongs to one (exchange, symbol, timeframe): a mismatch is reported and the set is discarded,
 * because mixing two exchanges silently is exactly the mistake the product must not make.
 */
export function candlesMatchContext (context, meta = {}) {
  if (!context)
    return { ok: false, reason: 'no chart context' }
  const issues = []
  if (meta.symbol && String(meta.symbol).toUpperCase() !== String(context.symbol).toUpperCase())
    issues.push(`candles are for ${meta.symbol}, the chart is ${context.symbol}`)
  if (meta.timeframe && meta.timeframe !== context.timeframe)
    issues.push(`candles are ${meta.timeframe}, the chart is ${context.timeframe}`)
  if (meta.exchange && context.exchange && String(meta.exchange).toUpperCase() !== String(context.exchange).toUpperCase())
    issues.push(`candles come from ${meta.exchange}, the chart is ${context.exchange}`)
  return issues.length ? { ok: false, reason: issues.join('; ') } : { ok: true, reason: null }
}

// --- what the model receives ---------------------------------------------------------------------------------

/**
 * The block for the system prompt. It states what was observed, where it came from, how old it is, and what is
 * missing — including "no candles" as a fact, so the model asks instead of inventing a price.
 */
export function contextBlock ({ context, candles = null, indicators = [], source = null, now = Date.now() } = {}) {
  if (!context)
    return { text: '', sources: [], missing: ['chart'] }
  const missing = []
  const lines = ['Contexto do gráfico (observado na página, não digitado):']
  if (context.symbol)
    lines.push(`- Ativo: ${context.symbol}${context.exchange ? ` (${context.exchange})` : ' (exchange não identificada)'}`)
  else
    missing.push('symbol')
  if (context.timeframe)
    lines.push(`- Timeframe: ${context.timeframe}`)
  else
    missing.push('timeframe')
  const state = age(context, now)
  lines.push(`- Observado: ${new Date(context.observedAt).toISOString()} (${state === 'live' ? 'agora' : state === 'recent' ? `${Math.round((now - context.observedAt) / 1000)}s atrás` : 'desatualizado'})`)
  const summary = candleSummary(candles)
  if (summary) {
    if (source)
      lines.push(`- Fonte dos candles: ${String(source).toUpperCase()}`)
    lines.push(`- Candles: ${summary.count}, de ${new Date(summary.from).toISOString()} a ${new Date(summary.to).toISOString()}, último fechamento ${summary.lastClose}, máxima ${summary.high}, mínima ${summary.low}`)
  } else {
    missing.push('candles')
    lines.push('- Candles: não disponíveis (nenhuma fonte confiável respondeu nesta sessão)')
  }
  const indicatorInfo = indicatorLines(context.indicators?.length ? context.indicators : indicators)
  lines.push(...indicatorInfo.lines)
  if (!indicatorInfo.counts.value)
    missing.push('indicators')
  lines.push('', 'Se um dado acima estiver ausente ou desatualizado, diga o que falta antes de concluir qualquer coisa.')
  return { text: lines.join('\n'), sources: [context.source, candles ? 'candles' : null].filter(Boolean), missing }
}

export function describeContext (context) {
  if (!context || context.status === 'unavailable')
    return { label: 'Sem gráfico ativo', detail: context?.reason ?? 'nenhuma aba do TradingView detectada', state: 'off' }
  if (context.status === 'stale')
    return { label: `${context.symbol ?? '—'}${context.timeframe ? ` · ${context.timeframe}` : ''}`, detail: 'observação desatualizada: recarregue o painel', state: 'stale' }
  return { label: `${context.symbol}${context.timeframe ? ` · ${context.timeframe}` : ''}${context.exchange ? ` · ${context.exchange}` : ''}`, detail: 'conectado ao gráfico', state: 'live' }
}

// --- store used by the copilot -------------------------------------------------------------------------------
// Kept here, not in app.js, so the rules for "which tab's chart is this?" are the tested ones.

export function createChartStore () {
  const byTab = new Map()
  return {
    // One message from a tab updates that tab and nothing else
    apply (tabId, observation = {}, now = Date.now()) {
      if (!Number.isInteger(tabId))
        return null
      const context = createChartContext({ tabId, ...observation, observedAt: now })
      byTab.set(tabId, context)
      return context
    },
    get (tabId, now = Date.now()) {
      return contextForTab(byTab, tabId, now)
    },
    remove (tabId) {
      return byTab.delete(tabId)
    },
    has (tabId) {
      return byTab.has(tabId)
    },
    all () {
      return new Map(byTab)
    },
    size () {
      return byTab.size
    },
    clear () {
      byTab.clear()
    },
  }
}

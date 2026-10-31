// DZ23 — market data layer: OHLCV from a public exchange API, independent of TradingView.
//
// Only public, documented endpoints are used (Binance's /api/v3/klines), with a timeout, a row limit and the source
// named on every result. When a source is not reachable, the answer is "unavailable" with the reason — never a
// fabricated candle, never a silent substitution of exchange. The fetch function is injected so the mapping and the
// failure modes are tested without network.

import { validateCandles } from './chartContext.js'

export const CANDLES_VERSION = 1
export const MAX_ROWS = 200
export const DEFAULT_TIMEOUT_MS = 8000

// Timeframe -> the interval spelling the exchange expects. An unknown timeframe is refused, not guessed.
const BINANCE_INTERVALS = {
  '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
  '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '8h': '8h', '12h': '12h',
  '1D': '1d', '2D': '2d', '3D': '3d', '1W': '1w', '1M': '1M',
}

export const SOURCES = {
  binance: {
    id: 'binance',
    exchange: 'BINANCE',
    supports: (symbol) => /^[A-Z0-9]{5,20}$/.test(symbol),
    url: ({ symbol, timeframe, limit }) => `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${BINANCE_INTERVALS[timeframe]}&limit=${limit}`,
  },
}

export function intervalOf (timeframe) {
  return BINANCE_INTERVALS[timeframe] ?? null
}

/**
 * Fetches candles for one chart context. Returns { ok:true, candles, source, exchange, symbol, timeframe, fetchedAt }
 * or { ok:false, reason, source }. A candle set that does not belong to the context is refused, not relabelled.
 */
export async function fetchCandles ({
  context,
  timeframe = null,
  limit = MAX_ROWS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  const symbol = context?.symbol ?? null
  const wantedTimeframe = timeframe ?? context?.timeframe ?? null
  if (!symbol)
    return { ok: false, reason: 'no chart context: there is no symbol to fetch candles for', source: null }
  if (!wantedTimeframe)
    return { ok: false, reason: 'the chart has no timeframe, so no interval can be requested', source: null }
  if (!intervalOf(wantedTimeframe))
    return { ok: false, reason: `timeframe ${wantedTimeframe} is not supported by any configured source`, source: null }
  if (typeof fetchImpl !== 'function')
    return { ok: false, reason: 'no fetch implementation available in this context', source: null }

  const source = SOURCES.binance
  // The chart exchange is respected: candles from another exchange are never used as if they were this chart's
  if (context.exchange && context.exchange !== source.exchange)
    return { ok: false, reason: `the chart is on ${context.exchange}; the only configured public source is ${source.exchange}`, source: null }
  if (!source.supports(symbol))
    return { ok: false, reason: `${symbol} is not a symbol ${source.exchange} publishes`, source: null }

  const rows = Math.max(1, Math.min(Number(limit) || MAX_ROWS, 1000))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetchImpl(source.url({ symbol, timeframe: wantedTimeframe, limit: rows }), {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!response.ok)
      return { ok: false, reason: `${source.exchange} answered HTTP ${response.status}`, source: source.id }
    const payload = await response.json()
    if (!Array.isArray(payload))
      return { ok: false, reason: `${source.exchange} returned an unexpected payload`, source: source.id }
    // Binance kline: [openTime, open, high, low, close, volume, closeTime, ...]
    const validation = validateCandles(payload.map((row) => [row[0], row[1], row[2], row[3], row[4], row[5]]), { maxRows: rows })
    if (!validation.ok)
      return { ok: false, reason: validation.reason, source: source.id, rejected: validation.rejected }
    return {
      ok: true,
      candles: validation.candles,
      rejected: validation.rejected,
      source: source.id,
      exchange: source.exchange,
      symbol,
      timeframe: wantedTimeframe,
      fetchedAt: now(),
      version: CANDLES_VERSION,
    }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return { ok: false, reason: timedOut ? `no answer from ${source.exchange} within ${timeoutMs} ms` : `could not reach ${source.exchange}: ${error?.message ?? error}`, source: source.id }
  } finally {
    clearTimeout(timer)
  }
}

// What the copilot shows when there are no candles: the fact plus the reason, so the user can act on it.
export function candlesUnavailable (result) {
  return {
    available: false,
    reason: result?.reason ?? 'candles are not available',
    source: result?.source ?? null,
  }
}

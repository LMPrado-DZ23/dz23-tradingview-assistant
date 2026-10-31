import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_ROWS, SOURCES, candlesUnavailable, fetchCandles, intervalOf } from '../../../extension/lib/candles.js'

// The market layer must be able to say "unavailable" for every way it can fail, and must never relabel a candle set.

const kline = (time, close = 100) => [time, '99', String(close + 1), '98', String(close), '12', time + 59999]

function context (overrides = {}) {
  return { symbol: 'BTCUSDT', exchange: 'BINANCE', timeframe: '1h', ...overrides }
}

function fakeFetch (payload, { status = 200 } = {}) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    return { ok: status >= 200 && status < 300, status, json: async () => payload }
  }
  impl.calls = calls
  return impl
}

test('the timeframe maps to the interval the exchange expects', () => {
  assert.equal(intervalOf('1h'), '1h')
  assert.equal(intervalOf('1D'), '1d')
  assert.equal(intervalOf('1W'), '1w')
  assert.equal(intervalOf('7m'), null, 'an unsupported timeframe is null, never a guess')
})

test('a good response becomes validated candles with their source named', async () => {
  const fetchImpl = fakeFetch([kline(1000, 100), kline(2000, 101)])
  const result = await fetchCandles({ context: context(), fetchImpl, now: () => 4242 })
  assert.equal(result.ok, true)
  assert.equal(result.source, 'binance')
  assert.equal(result.exchange, 'BINANCE')
  assert.equal(result.symbol, 'BTCUSDT')
  assert.equal(result.timeframe, '1h')
  assert.equal(result.fetchedAt, 4242)
  assert.equal(result.candles.length, 2)
  assert.equal(result.candles[1].close, 101)
  assert.match(fetchImpl.calls[0], /symbol=BTCUSDT&interval=1h&limit=200/)
})

test('the request respects the row limit and the documented endpoint', async () => {
  const fetchImpl = fakeFetch([kline(1000)])
  await fetchCandles({ context: context(), fetchImpl, limit: 50 })
  assert.match(fetchImpl.calls[0], /limit=50/)
  assert.ok(fetchImpl.calls[0].startsWith(SOURCES.binance.url({ symbol: 'BTCUSDT', timeframe: '1h', limit: 50 })))
  assert.equal(MAX_ROWS, 200)
})

test('a chart on another exchange is refused instead of silently substituted', async () => {
  const fetchImpl = fakeFetch([kline(1000)])
  const result = await fetchCandles({ context: context({ exchange: 'BYBIT' }), fetchImpl })
  assert.equal(result.ok, false)
  assert.match(result.reason, /BYBIT/)
  assert.equal(fetchImpl.calls.length, 0, 'nothing is requested when the exchange does not match')
})

test('missing context, timeframe or symbol says exactly what is missing', async () => {
  assert.match((await fetchCandles({})).reason, /no chart context/)
  assert.match((await fetchCandles({ context: { symbol: 'BTCUSDT' } })).reason, /no timeframe/)
  assert.match((await fetchCandles({ context: { symbol: 'BTCUSDT', timeframe: '7m' } })).reason, /not supported/)
  assert.match((await fetchCandles({ context: { symbol: 'BTC', exchange: 'BINANCE', timeframe: '1h' } })).reason, /not a symbol/)
})

test('an HTTP failure and an unexpected payload are reported, not turned into candles', async () => {
  const failed = await fetchCandles({ context: context(), fetchImpl: fakeFetch([], { status: 503 }) })
  assert.equal(failed.ok, false)
  assert.match(failed.reason, /HTTP 503/)
  const weird = await fetchCandles({ context: context(), fetchImpl: fakeFetch({ not: 'a list' }) })
  assert.equal(weird.ok, false)
  assert.match(weird.reason, /unexpected payload/)
  const invalid = await fetchCandles({ context: context(), fetchImpl: fakeFetch([[1, 'x', '2', '0', '1', '1']]) })
  assert.equal(invalid.ok, false)
  assert.match(invalid.reason, /invalid/)
})

test('a timeout is reported as a timeout', async () => {
  const slow = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')))
  })
  const result = await fetchCandles({ context: context(), fetchImpl: slow, timeoutMs: 30 })
  assert.equal(result.ok, false)
  assert.match(result.reason, /within 30 ms/)
})

test('a network error is reported with the exchange name', async () => {
  const broken = async () => { throw new Error('ECONNREFUSED') }
  const result = await fetchCandles({ context: context(), fetchImpl: broken })
  assert.equal(result.ok, false)
  assert.match(result.reason, /BINANCE/)
  assert.match(result.reason, /ECONNREFUSED/)
})

test('the unavailable view keeps the reason so the UI can show it', () => {
  const view = candlesUnavailable({ ok: false, reason: 'BINANCE answered HTTP 503', source: 'binance' })
  assert.deepEqual(view, { available: false, reason: 'BINANCE answered HTTP 503', source: 'binance' })
})

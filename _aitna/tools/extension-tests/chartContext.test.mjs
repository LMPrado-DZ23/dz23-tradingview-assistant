import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CHART_CONTEXT_VERSION,
  TTL_MS,
  age,
  candleSummary,
  candlesMatchContext,
  contextBlock,
  contextForTab,
  createChartContext,
  createChartStore,
  createDebouncer,
  describeContext,
  isFresh,
  parseSymbol,
  sameChart,
  timeframeOf,
  validateCandles,
} from '../../../extension/lib/chartContext.js'

// The rules the copilot depends on: which chart, which tab, how old, and what is honestly unknown.

test('a TradingView symbol keeps its exchange and never invents one', () => {
  assert.deepEqual(parseSymbol('BINANCE:BTCUSDT'), { exchange: 'BINANCE', symbol: 'BTCUSDT' })
  assert.deepEqual(parseSymbol('btcusdt'), { exchange: null, symbol: 'BTCUSDT' })
  assert.deepEqual(parseSymbol(' nasdaq:aapl '), { exchange: 'NASDAQ', symbol: 'AAPL' })
  assert.equal(parseSymbol(''), null)
  assert.equal(parseSymbol(':BTC'), null)
})

test('a resolution becomes the timeframe the chart shows', () => {
  assert.equal(timeframeOf(5), '5m')
  assert.equal(timeframeOf('15'), '15m')
  assert.equal(timeframeOf(60), '1h')
  assert.equal(timeframeOf('D'), '1D')
  assert.equal(timeframeOf('W'), '1W')
  assert.equal(timeframeOf('240'), '4h')
  assert.equal(timeframeOf(null), null)
  assert.equal(timeframeOf('1s'), null, 'an unknown resolution is null, not a guess')
  // the legend shows labels; the contract maps them to the same canonical timeframe
  assert.equal(timeframeOf('15m'), '15m')
  assert.equal(timeframeOf('1h'), '1h')
  assert.equal(timeframeOf('4h'), '4h')
  assert.equal(timeframeOf('1d'), '1D')
  assert.equal(timeframeOf('1w'), '1W')
})

test('a chart observation is live, carries its tab and expires', () => {
  const now = 1_000_000
  const context = createChartContext({ tabId: 7, rawSymbol: 'BINANCE:BTCUSDT', resolution: '60', observedAt: now })
  assert.equal(context.version, CHART_CONTEXT_VERSION)
  assert.equal(context.tabId, 7)
  assert.equal(context.symbol, 'BTCUSDT')
  assert.equal(context.exchange, 'BINANCE')
  assert.equal(context.timeframe, '1h')
  assert.equal(context.status, 'live')
  assert.equal(context.expiresAt, now + TTL_MS)
  assert.equal(isFresh(context, now + 1), true)
  assert.equal(isFresh(context, now + TTL_MS), false, 'at the deadline it is no longer live')
  assert.equal(age(context, now + TTL_MS + 1), 'stale')
})

test('a tab without a chart reports unavailable with a reason', () => {
  const context = createChartContext({ tabId: 3, rawSymbol: null, resolution: null, source: 'none' })
  assert.equal(context.status, 'unavailable')
  assert.match(context.reason, /no chart/)
  assert.equal(describeContext(context).state, 'off')
})

test('two tabs never share a context, and the wrong tab returns nothing', () => {
  const now = Date.now()
  const contexts = new Map([
    [1, createChartContext({ tabId: 1, rawSymbol: 'BTCUSDT', resolution: '5', observedAt: now })],
    [2, createChartContext({ tabId: 2, rawSymbol: 'ETHUSDT', resolution: '15', observedAt: now })],
  ])
  assert.equal(contextForTab(contexts, 1, now).symbol, 'BTCUSDT')
  assert.equal(contextForTab(contexts, 2, now).symbol, 'ETHUSDT')
  assert.equal(contextForTab(contexts, 3, now), null)
  assert.equal(contextForTab(contexts, null, now), null)
  assert.equal(sameChart(contexts.get(1), contexts.get(2)), false)
  assert.equal(sameChart(contexts.get(1), createChartContext({ tabId: 1, rawSymbol: 'BTCUSDT', resolution: '5', observedAt: now })), true)
})

test('an expired context is returned as stale instead of being shown as current', () => {
  const now = 1_000_000
  const contexts = new Map([[9, createChartContext({ tabId: 9, rawSymbol: 'SOLUSDT', resolution: '15', observedAt: now })]])
  const stale = contextForTab(contexts, 9, now + TTL_MS + 1)
  assert.equal(stale.status, 'stale')
  assert.match(describeContext(stale).detail, /desatualizada/)
})

test('the debouncer coalesces a burst into one call with the latest value', async () => {
  const calls = []
  const debouncer = createDebouncer(20, (value) => calls.push(value))
  debouncer.push('a')
  debouncer.push('b')
  debouncer.push('c')
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.deepEqual(calls, ['c'])
  debouncer.push('d')
  debouncer.cancel()
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.deepEqual(calls, ['c'], 'a cancelled pending event never fires')
})

test('valid candles are accepted, sorted and capped', () => {
  const rows = [
    [3000, 100, 101, 99, 100.5, 10],
    [1000, 90, 92, 89, 91, 5],
    [2000, 91, 93, 90, 92, 6],
  ]
  const result = validateCandles(rows, { maxRows: 2 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.candles.map((candle) => candle.time), [2000, 3000])
  assert.equal(result.truncated, true)
})

test('a candle that breaks the OHLC invariants is rejected, never repaired', () => {
  const rows = [
    [1, 10, 9, 11, 10, 1], // high < low
    [2, 10, 11, 9, 10, 1], // valid
    [3, 10, 10, 10, 10, -1], // negative volume
    [4, 'x', 10, 9, 10, 1], // not a number
  ]
  const result = validateCandles(rows)
  assert.equal(result.ok, true)
  assert.equal(result.candles.length, 1)
  assert.equal(result.rejected, 3)
})

test('an empty or invalid candle set says why instead of returning zeros', () => {
  assert.equal(validateCandles(null).ok, false)
  const allBad = validateCandles([[1, 0, 0, 1, 0, 0]])
  assert.equal(allBad.ok, false)
  assert.match(allBad.reason, /invalid/)
  assert.equal(validateCandles([]).ok, false)
})

test('candles from another symbol, timeframe or exchange are refused', () => {
  const context = createChartContext({ tabId: 1, rawSymbol: 'BINANCE:BTCUSDT', resolution: '5' })
  assert.equal(candlesMatchContext(context, { symbol: 'BTCUSDT', timeframe: '5m', exchange: 'BINANCE' }).ok, true)
  assert.match(candlesMatchContext(context, { symbol: 'ETHUSDT' }).reason, /candles are for ETHUSDT/)
  assert.match(candlesMatchContext(context, { timeframe: '15m' }).reason, /candles are 15m/)
  assert.match(candlesMatchContext(context, { exchange: 'BYBIT' }).reason, /BYBIT/)
  assert.equal(candlesMatchContext(null, { symbol: 'BTCUSDT' }).ok, false)
})

test('the summary of a candle set is computed, never estimated', () => {
  const summary = candleSummary([{ time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 }, { time: 2, open: 11, high: 13, low: 10, close: 12, volume: 7 }])
  assert.deepEqual(summary, { count: 2, from: 1, to: 2, lastClose: 12, high: 13, low: 9, volume: 12 })
  assert.equal(candleSummary([]), null)
})

test('the prompt block states the missing pieces and never invents a price', () => {
  const now = 1_000_000
  const context = createChartContext({ tabId: 1, rawSymbol: 'BINANCE:BTCUSDT', resolution: '60', observedAt: now })
  const withoutCandles = contextBlock({ context, candles: null, now })
  assert.match(withoutCandles.text, /Candles: não disponíveis/)
  assert.ok(withoutCandles.missing.includes('candles'))
  assert.match(withoutCandles.text, /Indicadores: nenhum valor acessível/)
  const withCandles = contextBlock({
    context,
    candles: [{ time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 }],
    indicators: [{ name: 'RSI', value: null }],
    now,
  })
  assert.match(withCandles.text, /Candles: 1/)
  assert.match(withCandles.text, /Indicador RSI: configurado, valor não acessível/)
  assert.ok(!withCandles.missing.includes('candles'))
  assert.match(withoutCandles.text, /diga o que falta/)
})

test('the chip label reflects live, stale and absent states', () => {
  const now = Date.now()
  const context = createChartContext({ tabId: 1, rawSymbol: 'BINANCE:ETHUSDT', resolution: '15', observedAt: now })
  assert.deepEqual(describeContext(context), { label: 'ETHUSDT · 15m · BINANCE', detail: 'conectado ao gráfico', state: 'live' })
  const stale = describeContext({ ...context, status: 'stale' })
  assert.equal(stale.state, 'stale')
  assert.equal(stale.label, 'ETHUSDT · 15m')
  assert.equal(describeContext(null).state, 'off')
})

test('a message from one tab updates that tab only', () => {
  const store = createChartStore()
  const now = 5_000_000
  store.apply(1, { rawSymbol: 'BINANCE:BTCUSDT', resolution: '5' }, now)
  store.apply(2, { rawSymbol: 'BINANCE:ETHUSDT', resolution: '15' }, now)
  assert.equal(store.get(1, now).symbol, 'BTCUSDT')
  assert.equal(store.get(2, now).symbol, 'ETHUSDT')
  // a later message from tab 2 must not touch tab 1
  store.apply(2, { rawSymbol: 'BINANCE:SOLUSDT', resolution: '60' }, now + 100)
  assert.equal(store.get(1, now + 100).symbol, 'BTCUSDT')
  assert.equal(store.get(2, now + 100).symbol, 'SOLUSDT')
  assert.equal(store.size(), 2)
})

test('closing a tab removes only its context', () => {
  const store = createChartStore()
  store.apply(1, { rawSymbol: 'BTCUSDT', resolution: '5' })
  store.apply(2, { rawSymbol: 'ETHUSDT', resolution: '15' })
  assert.equal(store.remove(2), true)
  assert.equal(store.has(2), false)
  assert.equal(store.get(1).symbol, 'BTCUSDT')
  assert.equal(store.get(2), null, 'a closed tab reports nothing, never a stale chart')
})

test('an unusable observation is stored as unavailable, not as a chart', () => {
  const store = createChartStore()
  const context = store.apply(4, { rawSymbol: null, resolution: null, source: 'none' })
  assert.equal(context.status, 'unavailable')
  assert.equal(store.get(4).status, 'unavailable')
  assert.equal(store.get(4).symbol, null)
  assert.equal(store.apply('nope', { rawSymbol: 'BTCUSDT', resolution: '5' }), null)
})

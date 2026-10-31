import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fetchCandles } from '../../../extension/lib/candles.js'

// Opt-in network check against the real exchange. Off by default: a suite that needs the internet is not a unit
// test, and a skipped run must never look like a passing one. Enable with DZ23_TEST_NETWORK=1.
const enabled = process.env.DZ23_TEST_NETWORK === '1'

test('the real exchange answers with candles for a known symbol', { skip: enabled ? false : 'BLOCKED_BY_EXTERNAL_DEPENDENCY: set DZ23_TEST_NETWORK=1 (needs network)' }, async () => {
  const result = await fetchCandles({
    context: { symbol: 'BTCUSDT', exchange: 'BINANCE', timeframe: '1h' },
    limit: 5,
    timeoutMs: 15_000,
  })
  assert.equal(result.ok, true, result.reason ?? '')
  assert.equal(result.source, 'binance')
  assert.equal(result.candles.length, 5)
  for (const candle of result.candles) {
    assert.ok(candle.high >= candle.low)
    assert.ok(Number.isFinite(candle.close))
    assert.ok(candle.time > 1_500_000_000_000, 'the timestamp is a real epoch, not a placeholder')
  }
  // the newest candle must be recent for a 1h chart: guards against a cached or stale payload
  const newest = result.candles.at(-1).time
  assert.ok(Date.now() - newest < 6 * 60 * 60 * 1000, 'the newest candle is older than 6 hours')
})

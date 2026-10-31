#!/usr/bin/env node
// Multi-timeframe comparison CLI.
//
//   npm run compare -- BTCUSDT 15m,1h,4h
//   npm run compare -- ETHUSDT 15m,4h --json
//
// Fetches the public candles for each timeframe, computes the same metrics the panel uses and prints the comparison:
// trend per timeframe, RSI zone, ATR%, position in the range and divergence. Facts only — no recommendation.
import { fetchCandles } from '../../../extension/lib/candles.js'
import { summarizeMarket } from '../../../extension/lib/marketIntel.js'
import { compareTimeframes, describeComparison } from '../../../extension/lib/compare.js'
import { normalizeInterval } from '../../../extension/lib/chartActions.js'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const positional = argv.filter((value) => !value.startsWith('--'))
const symbol = (positional[0] ?? '').toUpperCase()
const timeframes = (positional[1] ?? '15m,1h,4h').split(',').map((item) => item.trim()).filter(Boolean)

if (!symbol) {
  console.error('uso: npm run compare -- <SÍMBOLO> [15m,1h,4h] [--json]')
  process.exit(2)
}

const entries = []
const failures = []
for (const raw of timeframes) {
  const normalized = normalizeInterval(raw)
  if (!normalized.ok) {
    failures.push({ timeframe: raw, reason: normalized.reason })
    continue
  }
  try {
    const result = await fetchCandles({ context: { symbol, exchange: 'BINANCE', timeframe: normalized.timeframe, resolution: normalized.interval } })
    if (!result.ok) {
      failures.push({ timeframe: normalized.timeframe, reason: result.reason })
      continue
    }
    const intel = summarizeMarket({ candles: result.candles, context: { timeframe: normalized.timeframe }, source: result.source })
    entries.push({ timeframe: normalized.timeframe, price: result.candles.at(-1)?.close ?? null, intel })
  } catch (error) {
    failures.push({ timeframe: normalized.timeframe, reason: String(error?.message ?? error) })
  }
}

const comparison = compareTimeframes(entries)
if (failures.length)
  comparison.failedTimeframes = failures

if (json) {
  console.log(JSON.stringify({ symbol, comparison }, null, 2))
} else {
  console.log(`Ativo: ${symbol} · timeframes: ${timeframes.join(', ')}`)
  console.log(describeComparison(comparison))
  for (const failure of failures)
    console.log(`- falhou ${failure.timeframe}: ${failure.reason}`)
}

process.exit(comparison.ok ? 0 : 1)

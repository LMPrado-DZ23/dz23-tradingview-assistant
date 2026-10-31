#!/usr/bin/env node
// Asset comparison CLI: two or more symbols on the same timeframe, facts side by side.
//
//   npm run compare-assets -- BTCUSDT ETHUSDT --tf 1h
//   npm run compare-assets -- BTCUSDT ETHUSDT SOLUSDT --tf 4h --json
//
// Candles come from the same public source the panel uses. A symbol the source does not cover is reported as missing,
// never filled with a guess.
import { fetchCandles } from '../../../extension/lib/candles.js'
import { summarizeMarket } from '../../../extension/lib/marketIntel.js'
import { compareAssets, describeAssetComparison } from '../../../extension/lib/compareAssets.js'
import { normalizeInterval } from '../../../extension/lib/chartActions.js'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const timeframeIndex = argv.indexOf('--tf')
const timeframeRaw = timeframeIndex >= 0 ? argv[timeframeIndex + 1] : '1h'
const symbols = argv.filter((value, index) => !value.startsWith('--') && index !== timeframeIndex + 1)
  .map((value) => value.trim().toUpperCase())
  .filter(Boolean)

if (symbols.length < 2) {
  console.error('uso: npm run compare-assets -- <SÍMBOLO> <SÍMBOLO> [mais...] [--tf 1h] [--json]')
  process.exit(2)
}

const timeframe = normalizeInterval(timeframeRaw)
if (!timeframe.ok) {
  console.error(`timeframe inválido: ${timeframe.reason}`)
  process.exit(2)
}

const entries = []
const failures = []
for (const symbol of symbols) {
  try {
    const result = await fetchCandles({ context: { symbol, exchange: 'BINANCE', timeframe: timeframe.timeframe, resolution: timeframe.interval } })
    if (!result.ok) {
      failures.push({ symbol, reason: result.reason })
      continue
    }
    const candles = result.candles
    const last = candles.at(-1)
    const previous = candles.at(-2)
    const intel = summarizeMarket({ candles, context: { timeframe: timeframe.timeframe, symbol }, source: result.source })
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
    failures.push({ symbol, reason: String(error?.message ?? error).slice(0, 80) })
  }
}

const comparison = compareAssets(entries, { timeframe: timeframe.timeframe })
if (failures.length)
  comparison.failedAssets = failures

if (json) {
  console.log(JSON.stringify({ comparison }, null, 2))
} else {
  console.log(describeAssetComparison(comparison))
  for (const failure of failures)
    console.log(`- falhou ${failure.symbol}: ${failure.reason}`)
}

process.exit(comparison.ok ? 0 : 1)

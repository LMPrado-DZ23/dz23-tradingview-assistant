// DZ23 Quant Research — Monte Carlo by resampling the realized trades.
//
// The simulation answers "how differently could this same set of trades have been ordered?" — it does not predict
// the future and does not add information the sample does not have. With blockSize > 1 the resampling keeps runs
// of consecutive trades together, which preserves part of the dependency (streaks) instead of assuming i.i.d.
// A report is a distribution, never a guarantee.

import { maxDrawdown, normalizeTrades, percentiles } from './metrics.mjs'

export const MONTE_CARLO_VERSION = '1.0.0'

// Deterministic PRNG (mulberry32): the same seed and the same trades always produce the same report.
export function createRandom (seed = 1) {
  let state = seed >>> 0
  return function next () {
    state = (state + 0x6D2B79F5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function resample (pnls, random, blockSize) {
  const size = pnls.length
  if (blockSize <= 1) {
    const sample = new Array(size)
    for (let index = 0; index < size; index++)
      sample[index] = pnls[Math.floor(random() * size)]
    return sample
  }
  const sample = []
  while (sample.length < size) {
    const start = Math.floor(random() * size)
    for (let offset = 0; offset < blockSize && sample.length < size; offset++)
      sample.push(pnls[(start + offset) % size])
  }
  return sample
}

function longestLossStreak (pnls) {
  let longest = 0
  let current = 0
  for (const pnl of pnls) {
    if (pnl < 0) {
      current += 1
      longest = Math.max(longest, current)
    } else {
      current = 0
    }
  }
  return longest
}

/**
 * @param trades [{ pnl }] realized trades, in order
 * @param options.iterations (default 1000), seed (default 1), blockSize (default 1),
 *                initialCapital (default 0), ruinThreshold (default 0.5 of capital)
 */
export function runMonteCarlo (trades, { iterations = 1000, seed = 1, blockSize = 1, initialCapital = 0, ruinThreshold = 0 } = {}) {
  const normalized = normalizeTrades(trades)
  if (!normalized.length)
    throw new RangeError('no trades to resample')
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100_000)
    throw new RangeError('iterations must be an integer between 1 and 100000')
  const pnls = normalized.map((trade) => trade.pnl)
  const random = createRandom(seed)
  const runs = []
  for (let iteration = 0; iteration < iterations; iteration++) {
    const sample = resample(pnls, random, blockSize)
    const equity = initialCapital + sample.reduce((total, pnl) => total + pnl, 0)
    const drawdown = maxDrawdown(sample)
    runs.push({
      netProfit: equity - initialCapital,
      finalEquity: equity,
      maxDrawdown: drawdown.absolute,
      maxDrawdownPct: drawdown.percent === null ? null : drawdown.percent * 100,
      longestLossStreak: longestLossStreak(sample),
      ruined: initialCapital > 0 ? equity <= initialCapital * ruinThreshold : equity <= ruinThreshold && equity < 0,
    })
  }
  return summarizeRuns(runs, { iterations, seed, blockSize, initialCapital })
}

export function summarizeRuns (runs, meta = {}) {
  const netProfits = runs.map((run) => run.netProfit)
  const drawdowns = runs.map((run) => run.maxDrawdown)
  const streaks = runs.map((run) => run.longestLossStreak)
  const ruined = runs.filter((run) => run.ruined).length
  return {
    monteCarloVersion: MONTE_CARLO_VERSION,
    iterations: runs.length,
    seed: meta.seed ?? null,
    blockSize: meta.blockSize ?? 1,
    netProfit: percentiles(netProfits),
    maxDrawdown: percentiles(drawdowns),
    longestLossStreak: percentiles(streaks),
    meanNetProfit: netProfits.reduce((total, value) => total + value, 0) / runs.length,
    probabilityOfProfit: runs.filter((run) => run.netProfit > 0).length / runs.length,
    probabilityOfRuin: ruined / runs.length,
    worstNetProfit: Math.min(...netProfits),
    bestNetProfit: Math.max(...netProfits),
    runs,
  }
}

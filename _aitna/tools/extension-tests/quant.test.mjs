import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMetrics, equityCurve, maxDrawdown, percentiles, sharpeRatio, sortinoRatio } from '../../../extension/quant/metrics.mjs'
import {
  compareInOut,
  parameterRobustness,
  robustnessScore,
  runWalkForward,
  splitChronological,
  walkForwardWindows,
} from '../../../extension/quant/research.mjs'
import { runMonteCarlo } from '../../../extension/quant/montecarlo.mjs'

// Every case here has a value that can be computed by hand: a metric that silently changes meaning fails a test.

const TRADES = [{ pnl: 10 }, { pnl: -5 }, { pnl: 20 }, { pnl: -15 }]

test('the equity curve and the drawdown match a hand calculation', () => {
  assert.deepEqual(equityCurve(TRADES), [0, 10, 5, 25, 10])
  const drawdown = maxDrawdown(TRADES)
  assert.equal(drawdown.absolute, 15, '25 -> 10')
  assert.equal(drawdown.percent, 15 / 25)
})

test('a curve that only goes up has no drawdown', () => {
  // shape ganhou o par do maior recuo em DINHEIRO, separado do percentual (que é o "máximo drawdown" de mercado)
  assert.deepEqual(maxDrawdown([{ pnl: 1 }, { pnl: 2 }]), {
    absolute: 0,
    percent: 0,
    peakAt: 0,
    troughAt: 0,
    absolutePercent: null,
    absolutePeakAt: 0,
    absoluteTroughAt: 0,
  })
})

test('the report of four trades matches the arithmetic', () => {
  const metrics = computeMetrics(TRADES)
  assert.equal(metrics.trades, 4)
  assert.equal(metrics.netProfit, 10)
  assert.equal(metrics.grossProfit, 30)
  assert.equal(metrics.grossLoss, -20)
  assert.equal(metrics.profitFactor, 1.5)
  assert.equal(metrics.winRate, 50)
  assert.equal(metrics.expectancy, 2.5)
  assert.equal(metrics.averageWin, 15)
  assert.equal(metrics.averageLoss, -10)
  assert.equal(metrics.averageWinLossRatio, 1.5)
  assert.equal(metrics.maxDrawdown, 15)
  assert.equal(metrics.recoveryFactor, 10 / 15)
})

test('a percent metric without initial capital is null with a reason, never zero', () => {
  const metrics = computeMetrics(TRADES)
  assert.equal(metrics.netProfitPct, null)
  assert.equal(metrics.annualizedReturnPct, null)
  assert.match(metrics.annualizedReturnReason, /initialCapital/)
  assert.equal(metrics.exposurePct, null)
})

test('a percent metric with capital is the ratio of the capital', () => {
  const metrics = computeMetrics(TRADES, { initialCapital: 100 })
  assert.equal(metrics.netProfitPct, 10)
  assert.equal(metrics.maxDrawdownPct, 60)
})

test('a trade without a finite pnl is refused instead of counted as zero', () => {
  assert.throws(() => computeMetrics([{ pnl: 1 }, { pnl: Number.NaN }]), /no finite pnl/)
  assert.throws(() => computeMetrics([{ other: 1 }]), /no finite pnl/)
})

test('a zero-variance series has no Sharpe ratio', () => {
  assert.deepEqual(sharpeRatio([1, 1, 1]), { value: null, reason: 'zero variance' })
  assert.deepEqual(sharpeRatio([5]).value, null)
})

test('Sharpe and Sortino match a hand calculation', () => {
  // [1,2,3]: mean 2, sample std 1
  assert.equal(sharpeRatio([1, 2, 3]).value, 2)
  // [-1,2,3]: mean 4/3, downside deviation sqrt(1/3)
  assert.ok(Math.abs(sortinoRatio([-1, 2, 3]).value - (4 / 3) / Math.sqrt(1 / 3)) < 1e-12)
  // annualized: per-period ratio * sqrt(periods)
  assert.equal(sharpeRatio([1, 2, 3], { periodsPerYear: 252 }).value, 2 * Math.sqrt(252))
})

test('percentiles interpolate between neighbours', () => {
  assert.deepEqual(percentiles([1, 2, 3, 4], [0, 50, 100]), { p0: 1, p50: 2.5, p100: 4 })
  assert.deepEqual(percentiles([], [50]), { p50: null })
})

test('the chronological split keeps the order and never shuffles', () => {
  const items = Array.from({ length: 10 }, (_, index) => index)
  const split = splitChronological(items, { isRatio: 0.7 })
  assert.equal(split.boundary, 7)
  assert.deepEqual(split.is, [0, 1, 2, 3, 4, 5, 6])
  assert.deepEqual(split.oos, [7, 8, 9])
  assert.throws(() => splitChronological(items, { isRatio: 1 }), /isRatio/)
})

test('walk-forward windows never overlap their own test part', () => {
  const windows = walkForwardWindows(10, { trainSize: 4, testSize: 2 })
  assert.deepEqual(windows.map((window) => window.train.start), [0, 2, 4])
  assert.deepEqual(windows.map((window) => window.test.start), [4, 6, 8])
  for (const window of windows)
    assert.equal(window.train.end, window.test.start, 'the test starts where the train ends')
  const anchored = walkForwardWindows(10, { trainSize: 4, testSize: 2, anchored: true })
  assert.deepEqual(anchored.map((window) => window.train.start), [0, 0, 0])
})

test('walk-forward evaluates slices, not the whole series', () => {
  const series = Array.from({ length: 8 }, (_, index) => index)
  const windows = walkForwardWindows(8, { trainSize: 2, testSize: 2 })
  const report = runWalkForward(series, windows, (slice) => ({ sum: slice.reduce((total, value) => total + value, 0) }))
  assert.equal(report.length, 3, 'starts 0, 2 and 4 fit')
  assert.deepEqual(report[0].train, { sum: 1 })
  assert.deepEqual(report[0].test, { sum: 5 })
})

test('the in/out comparison classifies a stable, a degraded and a collapsed strategy', () => {
  assert.equal(compareInOut({ is: 100, oos: 80 }).verdict, 'stable')
  assert.equal(compareInOut({ is: 100, oos: 50 }).verdict, 'degraded')
  assert.equal(compareInOut({ is: 100, oos: 10 }).verdict, 'collapsed')
  assert.equal(compareInOut({ is: 100, oos: 50 }).degradationPct, 50)
  const negative = compareInOut({ is: -10, oos: -20 })
  assert.equal(negative.ratio, null)
  assert.equal(negative.verdict, 'unknown')
})

test('a grid whose best point is alone is reported as an isolated spike', () => {
  const points = []
  for (const a of [1, 2, 3])
    for (const b of [1, 2, 3])
      points.push({ params: { a, b }, value: a === 2 && b === 2 ? 100 : 10 })
  const report = parameterRobustness(points, { dimensions: ['a', 'b'] })
  assert.equal(report.gridSize, 9)
  assert.equal(report.isIsolatedSpike, true)
  assert.equal(report.plateauSize, 1)
  assert.ok(robustnessScore(report).score < 0.2)
})

test('a flat grid is a plateau and scores high', () => {
  const points = []
  for (const a of [1, 2, 3])
    for (const b of [1, 2, 3])
      points.push({ params: { a, b }, value: 10 })
  const report = parameterRobustness(points, { dimensions: ['a', 'b'] })
  assert.equal(report.isIsolatedSpike, false)
  assert.equal(report.plateauSize, 9)
  assert.equal(report.plateauShare, 1)
  assert.equal(robustnessScore(report).score, 1)
})

test('a neighbour is a real grid adjacency, not a numeric coincidence', () => {
  const points = [
    { params: { a: 1 }, value: 10 },
    { params: { a: 5 }, value: 20 },
    { params: { a: 9 }, value: 30 },
  ]
  const report = parameterRobustness(points, { dimensions: ['a'] })
  // a=5 has the two others as neighbours (one step each), so its stability is (10+30)/2/20 = 1
  assert.equal(report.points[1].neighbours, 2)
  assert.equal(report.points[1].stability, 1)
  // The best point (a=9) has a single neighbour 33% worse, which is an isolated peak by definition
  assert.equal(report.isIsolatedSpike, true)
})

test('Monte Carlo is deterministic for a seed and reproducible by hand', () => {
  const trades = [{ pnl: 10 }, { pnl: -5 }, { pnl: 20 }, { pnl: -15 }]
  const first = runMonteCarlo(trades, { iterations: 200, seed: 7 })
  const second = runMonteCarlo(trades, { iterations: 200, seed: 7 })
  assert.deepEqual(first.netProfit, second.netProfit)
  assert.equal(first.iterations, 200)
  assert.ok(first.probabilityOfProfit >= 0 && first.probabilityOfProfit <= 1)
  assert.ok(first.netProfit.p5 <= first.netProfit.p50)
  assert.ok(first.netProfit.p50 <= first.netProfit.p95)
})

test('a sample of only winning trades cannot lose in any resampling', () => {
  const report = runMonteCarlo([{ pnl: 5 }, { pnl: 10 }], { iterations: 50, seed: 1 })
  assert.equal(report.probabilityOfProfit, 1)
  assert.equal(report.probabilityOfRuin, 0)
  assert.equal(report.worstNetProfit, 10)
})

test('the block size keeps consecutive trades together', () => {
  const trades = [{ pnl: 1 }, { pnl: -1 }, { pnl: 1 }, { pnl: -1 }]
  const report = runMonteCarlo(trades, { iterations: 40, seed: 3, blockSize: 2 })
  assert.equal(report.blockSize, 2)
  // Two-trade blocks of the sample end at 0, so no run can end above 0
  assert.equal(report.bestNetProfit, 0)
})

test('Monte Carlo refuses an empty sample and an absurd iteration count', () => {
  assert.throws(() => runMonteCarlo([]), /no trades/)
  assert.throws(() => runMonteCarlo([{ pnl: 1 }], { iterations: 0 }), /iterations/)
  assert.throws(() => runMonteCarlo([{ pnl: 1 }], { iterations: 100_001 }), /iterations/)
})

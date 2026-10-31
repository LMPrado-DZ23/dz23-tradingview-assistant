import { test } from 'node:test'
import assert from 'node:assert/strict'
import { attachTrades, experimentFromBacktest, heatmap, parameterGrid, parameterNamesOf } from '../../../extension/quant/fromBacktest.mjs'
import { validateExperiment } from '../../../extension/quant/contract.mjs'

// A result set shaped like the one the extension stores: one row per tested parameter set.
function results () {
  return {
    optParamName: 'Net PnL: All',
    paramsNames: ['length', 'risk'],
    perfomanceSummary: [
      { 'Net PnL: All': 100, 'Profit factor: All': 1.2, 'Max drawdown %: All': 8, 'Total trades: All': 40, __length: 10, __risk: 0.01 },
      { 'Net PnL: All': 400, 'Profit factor: All': 1.5, 'Max drawdown %: All': 6, 'Total trades: All': 55, __length: 20, __risk: 0.01 },
      { 'Net PnL: All': 250, 'Profit factor: All': 1.3, 'Max drawdown %: All': 9, 'Total trades: All': 48, __length: 10, __risk: 0.02 },
      { 'Net PnL: All': 380, 'Profit factor: All': 1.4, 'Max drawdown %: All': 7, 'Total trades: All': 50, __length: 20, __risk: 0.02 },
      { 'Net PnL: All': 300, 'Profit factor: All': 1.35, 'Max drawdown %: All': 7.5, 'Total trades: All': 52, __length: 30, __risk: 0.01 },
      { comment: 'stale report', __length: 30, __risk: 0.02 },
    ],
  }
}

test('the parameter names come from the result set, not from a guess', () => {
  assert.deepEqual(parameterNamesOf(results()), ['length', 'risk'])
})

test('the grid keeps only rows with a real value for the optimized metric', () => {
  const grid = parameterGrid(results())
  assert.equal(grid.metric, 'Net PnL: All')
  assert.equal(grid.points.length, 5)
  assert.equal(grid.ignored, 1)
  assert.deepEqual(grid.points[1].params, { length: 20, risk: 0.01 })
  assert.equal(grid.points[1].value, 400)
})

test('an unknown metric is refused instead of producing an empty grid', () => {
  const broken = results()
  delete broken.optParamName
  assert.throws(() => parameterGrid(broken), /optimized metric is unknown/)
})

test('the heatmap puts each value in its cell and leaves missing combinations null', () => {
  const { points } = parameterGrid(results())
  const map = heatmap(points, { xParam: 'length', yParam: 'risk' })
  assert.deepEqual(map.xValues, [10, 20, 30])
  assert.deepEqual(map.yValues, [0.01, 0.02])
  assert.deepEqual(map.cells, [[100, 400, 300], [250, 380, null]])
})

test('the experiment from a real run validates against the contract', () => {
  const { experiment, robustness, score } = experimentFromBacktest(results(), {
    strategyId: 'smc', strategyVersion: '1.2.0', asset: 'BTCUSDT', timeframe: '1h',
    dataProvider: 'tradingview-ui', period: { from: '2024-01-01T00:00:00Z', to: '2024-12-31T00:00:00Z' },
    costs: { commissionPct: 0.04, slippagePct: 0.01 },
  })
  const validation = validateExperiment(experiment)
  assert.equal(validation.ok, true, JSON.stringify(validation.errors))
  assert.equal(experiment.metrics.netProfit, 400)
  assert.equal(experiment.metrics.metricSource.netProfit, 'Net PnL: All')
  assert.equal(experiment.metrics.testedCombinations, 5)
  assert.equal(experiment.robustness.dimensions.length, 2)
  assert.equal(experiment.in_sample, null)
  assert.equal(typeof score.score, 'number')
  assert.equal(robustness.gridSize, 5)
})

test('a single run states what it cannot validate', () => {
  const { experiment } = experimentFromBacktest(results(), { strategyId: 'smc', strategyVersion: '1', asset: 'BTCUSDT', timeframe: '1h', dataProvider: 'tv', period: { from: '2024-01-01T00:00:00Z', to: '2024-06-01T00:00:00Z' } })
  const codes = experiment.warnings.map((warning) => warning.code)
  for (const code of ['no_out_of_sample', 'no_trial_series', 'rows_ignored'])
    assert.ok(codes.includes(code), `${code} is missing`)
  assert.equal(experiment.out_of_sample, null)
  assert.equal(experiment.overfitting, null)
})

test('an isolated peak becomes a warning the agent can see', () => {
  const isolated = results()
  isolated.perfomanceSummary = [
    { 'Net PnL: All': 1000, __length: 10, __risk: 0.01 },
    { 'Net PnL: All': 100, __length: 20, __risk: 0.01 },
    { 'Net PnL: All': 100, __length: 10, __risk: 0.02 },
    { 'Net PnL: All': 100, __length: 20, __risk: 0.02 },
  ]
  const { experiment } = experimentFromBacktest(isolated, { strategyId: 'smc', strategyVersion: '1', asset: 'BTCUSDT', timeframe: '1h', dataProvider: 'tv', period: { from: '2024-01-01T00:00:00Z', to: '2024-06-01T00:00:00Z' } })
  assert.equal(experiment.robustness.isolatedSpike, true)
  assert.ok(experiment.warnings.some((warning) => warning.code === 'isolated_spike'))
})

test('an empty result set is refused', () => {
  assert.throws(() => experimentFromBacktest({ optParamName: 'Net PnL: All', perfomanceSummary: [] }, { period: { from: '2024-01-01T00:00:00Z', to: '2024-06-01T00:00:00Z' } }), /no usable parameter/)
})

test('a run without a period is refused instead of producing an unverifiable record', () => {
  assert.throws(() => experimentFromBacktest(results(), { strategyId: 'smc' }), /period/)
})

test('trades, when available, add the full metric set without invalidating the record', () => {
  const { experiment } = experimentFromBacktest(results(), { strategyId: 'smc', strategyVersion: '1', asset: 'BTCUSDT', timeframe: '1h', dataProvider: 'tv', period: { from: '2024-01-01T00:00:00Z', to: '2024-06-01T00:00:00Z' } })
  const enriched = attachTrades(experiment, [{ pnl: 10 }, { pnl: -4 }, { pnl: 6 }], { initialCapital: 1000 })
  assert.equal(enriched.metrics.tradeMetrics.netProfit, 12)
  assert.equal(enriched.metrics.netProfit, 400, 'the report values stay untouched')
  assert.equal(validateExperiment(enriched).ok, true)
})

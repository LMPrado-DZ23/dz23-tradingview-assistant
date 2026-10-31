import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  deflatedSharpeRatio,
  normalCdf,
  normalInv,
  overfittingReport,
  probabilityOfBacktestOverfitting,
} from '../../../extension/quant/overfitting.mjs'
import {
  EXPERIMENT_SCHEMA_VERSION,
  createExperiment,
  parseExperiment,
  serializeExperiment,
  summarizeExperiment,
  validateExperiment,
} from '../../../extension/quant/contract.mjs'

// Overfitting diagnostics: the two checks are pinned with series whose answer is known by construction.

test('the normal distribution helpers match tabulated values', () => {
  assert.equal(normalCdf(0), 0.5)
  assert.ok(Math.abs(normalCdf(1.959963984540054) - 0.975) < 1e-4)
  assert.ok(Math.abs(normalInv(0.975) - 1.959963984540054) < 1e-4)
  assert.equal(normalInv(0.5), 0)
  assert.equal(normalInv(0), -Infinity)
})

test('the deflated Sharpe refuses the cases where it means nothing', () => {
  assert.equal(deflatedSharpeRatio({ sharpe: 0.2, observations: 100, trials: 1 }).value, null)
  assert.match(deflatedSharpeRatio({ sharpe: 0.2, observations: 100, trials: 1 }).reason, /trials/)
  assert.equal(deflatedSharpeRatio({ sharpe: 0.2, observations: 1, trials: 10 }).value, null)
})

test('more trials and a weaker Sharpe both lower the deflated Sharpe', () => {
  const few = deflatedSharpeRatio({ sharpe: 0.15, observations: 500, trials: 2 }).value
  const many = deflatedSharpeRatio({ sharpe: 0.15, observations: 500, trials: 500 }).value
  assert.ok(few > many, 'a winner chosen among 500 trials is less surprising than one among 2')
  const weak = deflatedSharpeRatio({ sharpe: 0.02, observations: 500, trials: 500 }).value
  assert.ok(weak < many)
  assert.ok(few > 0.9 && few <= 1)
})

test('a strategy selected by chance is caught by PBO', () => {
  // Trial A only wins in the first half of the sample, B only in the second half: whichever wins in-sample loses
  // out-of-sample, for every partition.
  const a = [1, 1, 1, 1, -1, -1, -1, -1]
  const b = [-1, -1, -1, -1, 1, 1, 1, 1]
  const report = probabilityOfBacktestOverfitting({ returns: [a, b], splits: 4 })
  assert.equal(report.pbo, 1)
  assert.equal(report.combinations, 6)
  assert.equal(report.trials, 2)
})

test('a genuinely better strategy is not flagged', () => {
  const good = [2, 2, 2, 2, 2, 2, 2, 2]
  const bad = [-1, -1, -1, -1, -1, -1, -1, -1]
  const report = probabilityOfBacktestOverfitting({ returns: [good, bad], splits: 4 })
  assert.equal(report.pbo, 0)
})

test('PBO refuses malformed matrices instead of guessing', () => {
  assert.throws(() => probabilityOfBacktestOverfitting({ returns: [] }), /2 trials/)
  assert.throws(() => probabilityOfBacktestOverfitting({ returns: [[1, 2, 3, 4]] }), /same length|2 trials/)
  assert.throws(() => probabilityOfBacktestOverfitting({ returns: [[1, 2], [3, 4]] }), /same length|observations/)
  assert.throws(() => probabilityOfBacktestOverfitting({ returns: [[1, 2, 3, 4], [1, 2, 3, Number.NaN]] }), /finite/)
  assert.throws(() => probabilityOfBacktestOverfitting({ returns: [[1, 2, 3, 4], [5, 6, 7, 8]], splits: 5 }), /even/)
})

test('the report turns a collapse into a warning the agent can read', () => {
  const report = overfittingReport({
    inSample: { netProfit: 1000 },
    outOfSample: { netProfit: 50 },
    testedCombinations: 5000,
    pbo: 0.8,
    deflated: deflatedSharpeRatio({ sharpe: 0.02, observations: 200, trials: 500 }),
  })
  assert.equal(report.comparison.verdict, 'collapsed')
  const codes = report.warnings.map((warning) => warning.code)
  for (const code of ['oos_collapsed', 'many_trials', 'pbo_high', 'dsr_low'])
    assert.ok(codes.includes(code), `${code} is missing`)
  assert.ok(report.limitations.length >= 2)
})

test('a stable strategy with few trials produces no warning', () => {
  const report = overfittingReport({
    inSample: { netProfit: 100 },
    outOfSample: { netProfit: 90 },
    testedCombinations: 20,
    pbo: 0.1,
    deflated: deflatedSharpeRatio({ sharpe: 0.3, observations: 400, trials: 2 }),
  })
  assert.equal(report.comparison.verdict, 'stable')
  assert.deepEqual(report.warnings, [])
})

// The contract is what the DZ23 agents consume: a versioned, validated, reproducible record.

function sampleExperiment (overrides = {}) {
  return createExperiment({
    strategyId: 'smc-breakout',
    strategyVersion: '1.2.0',
    asset: 'BTCUSDT',
    timeframe: '1h',
    dataProvider: 'binance-public',
    dataLicenseReference: 'public-market-data',
    period: { from: '2024-01-01T00:00:00Z', to: '2024-12-31T00:00:00Z' },
    parameters: { length: 20, risk: 0.01 },
    metrics: { netProfit: 1200, profitFactor: 1.4, maxDrawdownPct: 12 },
    costs: { commissionPct: 0.04, slippagePct: 0.01 },
    inSample: { metrics: { netProfit: 900 }, verdict: 'stable' },
    outOfSample: { metrics: { netProfit: 300 }, verdict: 'stable' },
    robustness: { score: 0.8, plateauSize: 6, isolatedSpike: false, dimensions: ['length'] },
    warnings: [],
    createdAt: '2025-01-05T10:00:00.000Z',
    ...overrides,
  })
}

test('a complete experiment validates and carries its schema version', () => {
  const experiment = sampleExperiment()
  assert.equal(experiment.schema_version, EXPERIMENT_SCHEMA_VERSION)
  assert.equal(experiment.engine_version, '1.0.0')
  assert.match(experiment.experiment_id, /^exp_/)
  assert.deepEqual(validateExperiment(experiment), { ok: true, errors: [] })
})

test('the validator reports every problem with its path', () => {
  const experiment = sampleExperiment()
  experiment.strategy_id = '  '
  experiment.metrics.netProfit = Number.NaN
  experiment.period = { from: '2024-12-31T00:00:00Z', to: '2024-01-01T00:00:00Z' }
  experiment.warnings = [{ code: 1 }]
  const { ok, errors } = validateExperiment(experiment)
  assert.equal(ok, false)
  const paths = errors.map((error) => error.path)
  for (const path of ['strategy_id', 'metrics.netProfit', 'period', 'warnings[0]'])
    assert.ok(paths.includes(path), `${path} is missing from ${paths.join(', ')}`)
})

test('an unknown verdict and a missing engine version are refused', () => {
  const experiment = sampleExperiment({ outOfSample: { metrics: { netProfit: 10 }, verdict: 'maybe' } })
  experiment.engine_version = ''
  const { errors } = validateExperiment(experiment)
  const paths = errors.map((error) => error.path)
  assert.ok(paths.includes('out_of_sample.verdict'))
  assert.ok(paths.includes('engine_version'))
})

test('serialization is stable and round-trips', () => {
  const experiment = sampleExperiment()
  const first = serializeExperiment(experiment)
  const shuffled = Object.fromEntries(Object.entries(experiment).reverse())
  assert.equal(serializeExperiment(shuffled), first, 'key order does not change the bytes')
  const parsed = parseExperiment(first)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.experiment.experiment_id, experiment.experiment_id)
})

test('the summary tells an agent whether the result can be acted on', () => {
  const experiment = sampleExperiment()
  const summary = summarizeExperiment(experiment)
  assert.equal(summary.ok, true)
  assert.equal(summary.reproducible, true)
  assert.equal(summary.outOfSampleVerdict, 'stable')
  assert.equal(summary.robustnessScore, 0.8)
  const broken = summarizeExperiment({ ...experiment, parameters: {} })
  assert.equal(broken.reproducible, false)
})

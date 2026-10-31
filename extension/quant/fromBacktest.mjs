// DZ23 Quant Research — bridge from the extension's backtest result to the research engine.
//
// The extension stores one row per tested parameter set (TradingView report metrics plus `__<parameter>` columns),
// not the individual trades. So this bridge can build the parameter grid, its robustness and an experiment record
// with the metrics the report actually has — and it says out loud what a single run cannot provide (an
// out-of-sample split, per-trial return series for PBO/DSR). Nothing is invented to fill a field.

import { parameterRobustness, robustnessScore } from './research.mjs'
import { createExperiment } from './contract.mjs'
import { computeMetrics } from './metrics.mjs'

// TradingView metric names differ across UI versions; the first match wins and the caller can see which one was used.
const METRIC_ALIASES = {
  netProfit: ['Net PnL: All', 'Net PnL', 'Total PnL'],
  profitFactor: ['Profit factor: All', 'Profit factor'],
  maxDrawdownPct: ['Max drawdown %: All', 'Max drawdown %'],
  trades: ['Total trades: All', 'Total trades'],
  winRate: ['Percent profitable: All', 'Percent profitable'],
  sharpe: ['Sharpe ratio'],
  sortino: ['Sortino ratio'],
}

function pick (row, candidates) {
  for (const name of candidates)
    if (typeof row?.[name] === 'number')
      return { value: row[name], name }
  return { value: null, name: null }
}

export function parameterNamesOf (testResults) {
  const rows = testResults?.perfomanceSummary ?? []
  const names = testResults?.paramsNames?.length
    ? testResults.paramsNames
    : [...new Set(rows.flatMap((row) => Object.keys(row ?? {}).filter((key) => key.startsWith('__')).map((key) => key.slice(2))))]
  return names.filter((name) => rows.some((row) => Object.hasOwn(row, `__${name}`)))
}

/**
 * One point per tested parameter set, valued by the optimized metric. A row without a finite value of that metric
 * (a stale report, a filtered combination) is counted in `ignored`, never filled with a zero.
 */
export function parameterGrid (testResults, { valueKey = null } = {}) {
  const rows = testResults?.perfomanceSummary ?? []
  const metric = valueKey ?? testResults?.optParamName
  if (!metric)
    throw new TypeError('the optimized metric is unknown: pass valueKey or a result set with optParamName')
  const params = parameterNamesOf(testResults)
  const points = []
  let ignored = 0
  for (const row of rows) {
    const value = row?.[metric]
    const hasAllParams = params.every((name) => Object.hasOwn(row, `__${name}`))
    if (typeof value !== 'number' || !Number.isFinite(value) || !hasAllParams) {
      ignored += 1
      continue
    }
    points.push({
      params: Object.fromEntries(params.map((name) => [name, row[`__${name}`]])),
      value,
    })
  }
  return { metric, params, points, ignored, rows: rows.length }
}

// 2D matrix for a heatmap. Missing cells are null: an absent combination is not a zero.
export function heatmap (points, { xParam, yParam } = {}) {
  if (!Array.isArray(points) || !points.length)
    throw new TypeError('points must be a non-empty array')
  const x = xParam ?? Object.keys(points[0].params)[0]
  const y = yParam ?? Object.keys(points[0].params)[1]
  if (!x || !y)
    throw new RangeError('a heatmap needs two parameters')
  const compare = (left, right) => (left > right ? 1 : left < right ? -1 : 0)
  const xValues = [...new Set(points.map((point) => point.params[x]))].sort(compare)
  const yValues = [...new Set(points.map((point) => point.params[y]))].sort(compare)
  const lookup = new Map(points.map((point) => [`${point.params[x]}|${point.params[y]}`, point.value]))
  return {
    xParam: x,
    yParam: y,
    xValues,
    yValues,
    cells: yValues.map((yValue) => xValues.map((xValue) => {
      const value = lookup.get(`${xValue}|${yValue}`)
      return typeof value === 'number' ? value : null
    })),
  }
}

/**
 * An experiment record from one real run. Honest by construction:
 *  - IS/OOS is null and a warning explains that one run cannot be split;
 *  - PBO/DSR are null and explained, because they need a per-trial return series;
 *  - only metrics present in the report are copied, with the name that was found.
 */
export function experimentFromBacktest (testResults, {
  strategyId = 'unknown',
  strategyVersion = '0',
  asset = '',
  timeframe = '',
  dataProvider = '',
  dataLicenseReference = 'not declared',
  period = {},
  initialCapital = null,
  costs = {},
  engineVersion = '1.0.0',
} = {}) {
  // The period is what makes a run reproducible: it is required, never guessed
  if (typeof period.from !== 'string' || typeof period.to !== 'string' || Number.isNaN(Date.parse(period.from)) || Number.isNaN(Date.parse(period.to)))
    throw new RangeError('period.from and period.to (ISO dates) are required for a reproducible experiment')
  const grid = parameterGrid(testResults)
  if (!grid.points.length)
    throw new RangeError('the result set has no usable parameter/value row')
  const bestRow = testResults.perfomanceSummary.find((row) => row?.[grid.metric] === Math.max(...grid.points.map((point) => point.value))) ?? {}
  const mapped = Object.fromEntries(Object.entries(METRIC_ALIASES).map(([key, names]) => [key, pick(bestRow, names)]))

  const robustness = parameterRobustness(grid.points, { dimensions: grid.params })
  const score = robustnessScore(robustness)
  const warnings = []
  if (!pick(bestRow, METRIC_ALIASES.netProfit).value)
    warnings.push({ code: 'metric_missing', message: `the report has no net profit column (looked for ${METRIC_ALIASES.netProfit.join(', ')})` })
  warnings.push({ code: 'no_out_of_sample', message: 'one backtest cannot be split in-sample/out-of-sample: run a second period to validate' })
  warnings.push({ code: 'no_trial_series', message: 'PBO and DSR need the return series of every trial, which the report does not store' })
  if (grid.ignored)
    warnings.push({ code: 'rows_ignored', message: `${grid.ignored} of ${grid.rows} rows had no value for "${grid.metric}" and were ignored` })
  if (grid.points.length > 1000)
    warnings.push({ code: 'many_trials', message: `${grid.points.length} combinations were tested: the best one is partly luck by construction` })
  if (robustness.isIsolatedSpike)
    warnings.push({ code: 'isolated_spike', message: 'the best parameter set has no comparable neighbours' })

  const metrics = {
    netProfit: mapped.netProfit.value,
    profitFactor: mapped.profitFactor.value,
    maxDrawdownPct: mapped.maxDrawdownPct.value,
    trades: mapped.trades.value,
    winRate: mapped.winRate.value,
    sharpe: mapped.sharpe.value,
    sortino: mapped.sortino.value,
    testedCombinations: grid.points.length,
    metricSource: Object.fromEntries(Object.entries(mapped).filter(([, found]) => found.name).map(([key, found]) => [key, found.name])),
  }

  const experiment = createExperiment({
    strategyId,
    strategyVersion: String(strategyVersion),
    asset,
    timeframe,
    dataProvider,
    dataLicenseReference,
    period,
    parameters: { optimizedMetric: grid.metric, names: grid.params, best: robustness.best?.params ?? null, tested: grid.points.length },
    metrics,
    costs,
    inSample: null,
    outOfSample: null,
    robustness: {
      score: score.score,
      plateauSize: robustness.plateauSize,
      isolatedSpike: robustness.isIsolatedSpike,
      dimensions: robustness.dimensions,
    },
    warnings,
    engineVersion,
  })
  return { experiment, grid, robustness, score, initialCapital }
}

// Trades are optional: when the caller has them (e.g. imported from a broker statement), the full metric set is
// computed and attached; the experiment is still valid without them.
export function attachTrades (experiment, trades, options = {}) {
  const metrics = computeMetrics(trades, options)
  return { ...experiment, metrics: { ...experiment.metrics, tradeMetrics: metrics } }
}

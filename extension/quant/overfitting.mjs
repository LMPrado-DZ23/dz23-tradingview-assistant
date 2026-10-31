// DZ23 Quant Research — overfitting diagnostics.
//
// Two independent checks, both from the backtest-overfitting literature (Bailey, Borwein, López de Prado, Zhu):
//  - PBO (probability of backtest overfitting) by CSCV: if the trial that wins in-sample lands in the bottom half
//    out-of-sample, that selection was noise.
//  - DSR (Deflated Sharpe Ratio): how surprising the best Sharpe is once the number of trials is known.
//
// Both are reported as probabilities with their assumptions stated. Neither is a guarantee, and a high value does
// not prove a strategy is overfitted: it says the selection process gives no edge.

import { compareInOut } from './research.mjs'

export const OVERFITTING_VERSION = '1.0.0'

// Abramowitz-Stegun based erf (|error| < 1.5e-7), enough for a probability reported with 4 decimals
function erf (x) {
  if (x === 0)
    return 0
  const sign = x < 0 ? -1 : 1
  const value = Math.abs(x)
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const t = 1 / (1 + p * value)
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-value * value)
  return sign * y
}

export function normalCdf (x) {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

// Acklam's inverse normal CDF (relative error < 1.15e-9)
export function normalInv (p) {
  if (p <= 0)
    return -Infinity
  if (p >= 1)
    return Infinity
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const low = 0.02425
  const high = 1 - low
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p <= high) {
    const q = p - 0.5
    const r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  }
  const q = Math.sqrt(-2 * Math.log(1 - p))
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
}

/**
 * Deflated Sharpe Ratio for the best trial of `trials` tests.
 * sharpe: per-period Sharpe of the selected strategy (same unit as the observations)
 * observations: number of return observations of that strategy
 * trials: how many parameter sets were tested (the number that makes the selection)
 * trialSharpeVariance: variance of the Sharpes across trials; when omitted, 1/(observations) is used, which is the
 *                      variance of the estimator under the null and is the conservative default
 * skew, kurtosis: of the returns; kurtosis is the non-excess one (3 for a normal distribution)
 */
export function deflatedSharpeRatio ({ sharpe, observations, trials, trialSharpeVariance = null, skew = 0, kurtosis = 3 } = {}) {
  if (!(Number.isFinite(sharpe) && Number.isFinite(observations) && observations > 1))
    return { value: null, reason: 'sharpe and observations (> 1) are required' }
  if (!(Number.isInteger(trials) && trials >= 2))
    return { value: null, reason: 'the number of trials (>= 2) is required: with one trial there is nothing to deflate' }
  const variance = Number.isFinite(trialSharpeVariance) && trialSharpeVariance > 0
    ? trialSharpeVariance
    : 1 / observations
  const gamma = 0.5772156649015329
  // Expected maximum Sharpe of `trials` independent trials with no skill
  const sr0 = Math.sqrt(variance) * ((1 - gamma) * normalInv(1 - 1 / trials) + gamma * normalInv(1 - 1 / (trials * Math.E)))
  const denominator = Math.sqrt(1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe ** 2)
  if (!(denominator > 0))
    return { value: null, reason: 'the skewness/kurtosis combination makes the statistic undefined' }
  const z = ((sharpe - sr0) * Math.sqrt(observations - 1)) / denominator
  return {
    value: normalCdf(z),
    z,
    expectedMaxSharpe: sr0,
    trials,
    observations,
    trialSharpeVariance: variance,
    reason: null,
  }
}

function mean (values) {
  return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
}

// All combinations of `size` indexes out of `count`, capped so a report cannot explode
function combinations (count, size, cap) {
  const result = []
  const pick = []
  const walk = (start) => {
    if (result.length >= cap)
      return
    if (pick.length === size) {
      result.push([...pick])
      return
    }
    for (let index = start; index < count; index++) {
      pick.push(index)
      walk(index + 1)
      pick.pop()
    }
  }
  walk(0)
  return result
}

function blocksOf (observations, splits) {
  const size = Math.floor(observations / splits)
  const blocks = []
  for (let index = 0; index < splits; index++)
    blocks.push({ start: index * size, end: (index + 1) * size })
  return blocks
}

function meanOfColumns (row, columns) {
  return mean(columns.map((column) => row[column]))
}

/**
 * Probability of backtest overfitting by combinatorial symmetric cross-validation (CSCV).
 * returns: one array per trial, all the same length (per-period returns of that parameter set).
 * splits: even number of contiguous blocks (8 by default); each half is used once as in-sample.
 * Returns {pbo, combinations, splits, trials, observations, medianRank}.
 */
export function probabilityOfBacktestOverfitting ({ returns, splits = 8, maxCombinations = 5000 } = {}) {
  if (!Array.isArray(returns) || returns.length < 2)
    throw new TypeError('returns must be an array with at least 2 trials')
  const trials = returns.length
  const length = returns[0]?.length ?? 0
  if (length < 4 || returns.some((row) => !Array.isArray(row) || row.length !== length))
    throw new TypeError('every trial must be an array of the same length (>= 4 observations)')
  if (returns.some((row) => row.some((value) => typeof value !== 'number' || !Number.isFinite(value))))
    throw new TypeError('every observation must be a finite number')
  if (splits % 2 !== 0 || splits < 4)
    throw new RangeError('splits must be an even number >= 4')
  let resolvedSplits = Math.min(splits, length)
  if (resolvedSplits % 2 !== 0)
    resolvedSplits -= 1
  if (resolvedSplits < 4)
    throw new RangeError('not enough observations for 4 blocks')

  const blocks = blocksOf(length, resolvedSplits)
  const half = resolvedSplits / 2
  const cap = Math.max(1, maxCombinations)
  const partitionCombinations = combinations(resolvedSplits, half, cap)
  const columnsOf = (picked) => picked.flatMap((blockIndex) => {
    const block = blocks[blockIndex]
    const columns = []
    for (let column = block.start; column < block.end; column++)
      columns.push(column)
    return columns
  })

  let overfit = 0
  const ranks = []
  for (const picked of partitionCombinations) {
    const inSampleColumns = columnsOf(picked)
    const outOfSampleColumns = columnsOf([...Array(resolvedSplits).keys()].filter((index) => !picked.includes(index)))
    const inSample = returns.map((row) => meanOfColumns(row, inSampleColumns))
    const outOfSample = returns.map((row) => meanOfColumns(row, outOfSampleColumns))
    const bestIndex = inSample.indexOf(Math.max(...inSample))
    const sortedOos = [...outOfSample].sort((left, right) => left - right)
    const rank = sortedOos.indexOf(outOfSample[bestIndex])
    const relativeRank = trials > 1 ? rank / (trials - 1) : 0
    ranks.push(relativeRank)
    if (relativeRank <= 0.5)
      overfit += 1
  }

  return {
    overfittingVersion: OVERFITTING_VERSION,
    pbo: overfit / partitionCombinations.length,
    combinations: partitionCombinations.length,
    splits: resolvedSplits,
    trials,
    observations: blocks.at(-1).end,
    medianRank: mean(ranks),
    capped: partitionCombinations.length >= cap,
  }
}

/**
 * The overfitting section of an experiment report: how the holdout compares with the fitted part, how many
 * combinations were tried, how surprising the winner is, and the warnings that follow from all of it.
 */
export function overfittingReport ({
  inSample,
  outOfSample,
  metric = 'netProfit',
  testedCombinations = null,
  deflated = null,
  pbo = null,
} = {}) {
  const comparison = compareInOut({ is: inSample, oos: outOfSample, metric })
  const warnings = []
  const limitations = [
    'PBO and DSR assume the trials are comparable and roughly independent; correlated parameter sets make both optimistic.',
    'A low PBO does not prove a strategy works; it only says the selection is not obviously noise.',
  ]
  const saturated = deflated?.value !== null && deflated?.value !== undefined && deflated.value >= 0.999
  if (saturated)
    limitations.push('A saturated DSR (>= 0.999) is uninformative about overfitting: it cannot tell an excellent strategy from a merely strong one, so read PBO and the out-of-sample comparison instead.')
  else if (deflated?.value !== null && deflated?.value !== undefined && deflated.value >= 0.95)
    limitations.push(`The DSR of ${deflated.value.toFixed(3)} is a borderline clearance; more trials would lower it.`)
  if (comparison.verdict === 'collapsed')
    warnings.push({ code: 'oos_collapsed', message: `out-of-sample ${metric} keeps less than 30% of the fitted result` })
  else if (comparison.verdict === 'degraded')
    warnings.push({ code: 'oos_degraded', message: `out-of-sample ${metric} keeps only ${Math.round(comparison.degradationPct)}% less than the fitted result` })
  if (Number.isInteger(testedCombinations) && testedCombinations > 1000)
    warnings.push({ code: 'many_trials', message: `${testedCombinations} parameter sets were tested: the best one is partly luck by construction` })
  if (pbo !== null && Number(pbo) >= 0.5)
    warnings.push({ code: 'pbo_high', message: `probability of backtest overfitting is ${(Number(pbo) * 100).toFixed(0)}%` })
  if (deflated?.value !== null && deflated?.value !== undefined && deflated.value < 0.95)
    warnings.push({ code: 'dsr_low', message: `deflated Sharpe ratio is ${deflated.value.toFixed(3)}: the result does not clear the trials it took to find it` })
  return {
    overfittingVersion: OVERFITTING_VERSION,
    comparison,
    pbo: pbo === null ? null : Number(pbo),
    deflatedSharpe: deflated ?? null,
    testedCombinations,
    warnings,
    limitations,
  }
}

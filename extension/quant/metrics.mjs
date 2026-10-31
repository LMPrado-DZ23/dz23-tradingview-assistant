// DZ23 Quant Research — performance metrics.
//
// Every number here is derived from a list of closed trades, in the order they happened. A metric that cannot be
// computed from the data returns `null` and a `reason`: this module never invents a value and never reports 0 as
// "no data". Formulas and conventions: quant/FORMULAS.md.

export const METRIC_VERSION = '1.0.0'

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * A trade is { pnl, durationMs?, exposureMs? }. `pnl` is the net result of the trade in account currency:
 * costs and slippage are expected to be already subtracted by whoever produced the trade.
 */
export function normalizeTrades (trades) {
  if (!Array.isArray(trades))
    throw new TypeError('trades must be an array of { pnl } objects')
  return trades.map((trade, index) => {
    const pnl = typeof trade === 'number' ? trade : trade?.pnl
    if (!isNumber(pnl))
      throw new TypeError(`trade #${index} has no finite pnl`)
    return {
      pnl,
      durationMs: isNumber(trade?.durationMs) ? trade.durationMs : null,
      exposureMs: isNumber(trade?.exposureMs) ? trade.exposureMs : null,
    }
  })
}

export function equityCurve (trades) {
  const curve = [0]
  let equity = 0
  for (const trade of normalizeTrades(trades)) {
    equity += trade.pnl
    curve.push(equity)
  }
  return curve
}

function sum (values) {
  return values.reduce((total, value) => total + value, 0)
}

function mean (values) {
  return values.length ? sum(values) / values.length : null
}

function sampleStdDev (values) {
  if (values.length < 2)
    return null
  const average = mean(values)
  const variance = sum(values.map((value) => (value - average) ** 2)) / (values.length - 1)
  return Math.sqrt(variance)
}

export function maxDrawdown (trades) {
  const curve = equityCurve(trades)
  let peak = curve[0]
  let worstAbs = 0
  let worstAbsPct = null
  let absolutePeakAt = 0
  let absoluteTroughAt = 0
  // O drawdown que o mercado chama de "máximo" é o maior recuo PERCENTUAL desde um pico. Antes esta função
  // escolhia o maior recuo em DINHEIRO e tirava a porcentagem desse par — com capital crescente, um tombo de
  // 50% no começo (100 → 50) ficava escondido atrás de um de 40% no fim (250 → 150).
  let worstPct = 0
  let hasPositivePeak = curve[0] > 0
  let percentPeakAt = 0
  let percentTroughAt = 0
  let currentPeakIndex = 0
  for (let index = 1; index < curve.length; index++) {
    if (curve[index] > peak) {
      peak = curve[index]
      currentPeakIndex = index
      if (peak > 0)
        hasPositivePeak = true
    }
    const dropAbs = peak - curve[index]
    const dropPct = peak > 0 ? dropAbs / peak : null
    if (dropAbs > worstAbs) {
      worstAbs = dropAbs
      worstAbsPct = dropPct
      absolutePeakAt = currentPeakIndex
      absoluteTroughAt = index
    }
    if (dropPct !== null && dropPct > worstPct) {
      worstPct = dropPct
      percentPeakAt = currentPeakIndex
      percentTroughAt = index
    }
  }
  return {
    absolute: worstAbs,
    percent: hasPositivePeak ? worstPct : null,
    peakAt: percentPeakAt,
    troughAt: percentTroughAt,
    absolutePercent: worstAbsPct,
    absolutePeakAt,
    absoluteTroughAt,
  }
}

// Periods: trades are not time-uniform, so the risk ratios are computed per trade and annualized only when the
// caller says how many trades a year the strategy produces (`periodsPerYear`).
export function sharpeRatio (returns, { periodsPerYear = null, riskFreePerPeriod = 0 } = {}) {
  if (returns.length < 2)
    return { value: null, reason: 'needs at least 2 observations' }
  const excess = returns.map((value) => value - riskFreePerPeriod)
  const deviation = sampleStdDev(excess)
  if (!deviation)
    return { value: null, reason: 'zero variance' }
  const perPeriod = mean(excess) / deviation
  return { value: periodsPerYear ? perPeriod * Math.sqrt(periodsPerYear) : perPeriod, perPeriod }
}

export function sortinoRatio (returns, { periodsPerYear = null, riskFreePerPeriod = 0 } = {}) {
  if (!returns.length)
    return { value: null, reason: 'needs at least 1 observation' }
  const excess = returns.map((value) => value - riskFreePerPeriod)
  const downside = excess.map((value) => (value < 0 ? value : 0))
  const downsideDeviation = Math.sqrt(sum(downside.map((value) => value ** 2)) / excess.length)
  if (!downsideDeviation)
    return { value: null, reason: 'no downside deviation' }
  const perPeriod = mean(excess) / downsideDeviation
  return { value: periodsPerYear ? perPeriod * Math.sqrt(periodsPerYear) : perPeriod, perPeriod }
}

/**
 * The full report. `initialCapital` is required for percent-based metrics; without it they are `null` with a
 * reason, because a percentage of an unknown capital is not a number.
 */
export function computeMetrics (trades, options = {}) {
  const { initialCapital = null, periodsPerYear = null, totalPeriodMs = null } = options
  const normalized = normalizeTrades(trades)
  const pnls = normalized.map((trade) => trade.pnl)
  const count = pnls.length
  const wins = pnls.filter((value) => value > 0)
  const losses = pnls.filter((value) => value < 0)
  const grossProfit = sum(wins)
  const grossLoss = sum(losses)
  const netProfit = sum(pnls)
  const drawdown = maxDrawdown(normalized)
  const returns = pnls
  const sharpe = sharpeRatio(returns, { periodsPerYear })
  const sortino = sortinoRatio(returns, { periodsPerYear })
  const averageWin = wins.length ? mean(wins) : null
  const averageLoss = losses.length ? mean(losses) : null

  const percent = (value, reason) => (initialCapital && initialCapital > 0
    ? { value: (value / initialCapital) * 100, reason: null }
    : { value: null, reason: reason ?? 'initialCapital is required' })

  const netProfitPct = percent(netProfit)
  const annualizedReturn = (() => {
    if (!initialCapital || initialCapital <= 0 || !isNumber(totalPeriodMs) || totalPeriodMs <= 0)
      return { value: null, reason: 'initialCapital and totalPeriodMs are required' }
    const years = totalPeriodMs / (365.25 * 24 * 3600 * 1000)
    const totalReturn = netProfit / initialCapital
    if (years <= 0)
      return { value: null, reason: 'period is too short' }
    return { value: ((1 + totalReturn) ** (1 / years) - 1) * 100 }
  })()

  const calmarValue = (annualizedReturn.value !== null && drawdown.percent)
    ? annualizedReturn.value / (drawdown.percent * 100)
    : null

  const exposure = (() => {
    if (!isNumber(totalPeriodMs) || totalPeriodMs <= 0)
      return { value: null, reason: 'totalPeriodMs is required' }
    const known = normalized.some((trade) => isNumber(trade.exposureMs) || isNumber(trade.durationMs))
    if (!known)
      return { value: null, reason: 'no trade carries exposureMs or durationMs' }
    const exposed = sum(normalized.map((trade) => trade.exposureMs ?? trade.durationMs ?? 0))
    return { value: (exposed / totalPeriodMs) * 100 }
  })()

  return {
    metricVersion: METRIC_VERSION,
    trades: count,
    wins: wins.length,
    losses: losses.length,
    breakeven: count - wins.length - losses.length,
    netProfit,
    netProfitPct: netProfitPct.value,
    profitFactor: grossLoss < 0 ? grossProfit / Math.abs(grossLoss) : { value: null, reason: 'no losing trades' }.value,
    winRate: count ? (wins.length / count) * 100 : null,
    expectancy: count ? netProfit / count : null,
    averageWin,
    averageLoss,
    averageWinLossRatio: averageWin !== null && averageLoss ? averageWin / Math.abs(averageLoss) : null,
    grossProfit,
    grossLoss,
    maxDrawdown: drawdown.absolute,
    maxDrawdownPct: drawdown.percent === null ? null : drawdown.percent * 100,
    recoveryFactor: drawdown.absolute > 0 ? netProfit / drawdown.absolute : null,
    sharpe: sharpe.value,
    sharpeReason: sharpe.reason ?? null,
    sortino: sortino.value,
    sortinoReason: sortino.reason ?? null,
    annualizedReturnPct: annualizedReturn.value,
    annualizedReturnReason: annualizedReturn.reason ?? null,
    calmar: calmarValue,
    exposurePct: exposure.value,
    exposureReason: exposure.reason ?? null,
    totalPeriodMs,
  }
}

export function percentiles (values, points = [5, 50, 95]) {
  const sorted = [...values].filter(isNumber).sort((left, right) => left - right)
  if (!sorted.length)
    return Object.fromEntries(points.map((point) => [`p${point}`, null]))
  const result = {}
  for (const point of points) {
    const position = ((sorted.length - 1) * point) / 100
    const lower = Math.floor(position)
    const upper = Math.ceil(position)
    const weight = position - lower
    result[`p${point}`] = sorted[lower] * (1 - weight) + sorted[upper] * weight
  }
  return result
}

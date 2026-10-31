#!/usr/bin/env node
// Strategy comparison CLI for the Strategy Lab.
//
//   npm run strat:compare -- a.json b.json [--metric sharpe]
//
// Each file may be:
//   - an experiment (versioned contract, schema_version "1.0.0") → one candidate per experiment;
//   - a batch: { candidates: [ { name, trades | metrics, period, costs }, ... ] };
//   - a single candidate: { name, trades | metrics, period, costs }.
//
// The comparison refuses unequal periods/costs, ranks by ONE declared metric and prints the selection-bias note: the best
// of N is inflated, so a historical winner is not a forecast.
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseExperiment } from '../../../extension/quant/contract.mjs'
import { COMPARE_METRICS, compareStrategies, describeComparison, spreadOf } from '../../../extension/quant/compareStrategies.mjs'
import { deflatedSharpeRatio, overfittingReport, probabilityOfBacktestOverfitting } from '../../../extension/quant/overfitting.mjs'
import { runMonteCarlo } from '../../../extension/quant/montecarlo.mjs'
import { runWalkForward, splitChronological, walkForwardWindows } from '../../../extension/quant/research.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const montecarlo = argv.includes('--montecarlo')
const walkforward = argv.includes('--walkforward')
const metric = argv.includes('--metric') ? argv[argv.indexOf('--metric') + 1] : 'sharpe'
const files = argv.filter((value, index) => !value.startsWith('--') && argv[index - 1] !== '--metric')

if (files.length < 2) {
  console.error(`uso: npm run strat:compare -- <a.json> <b.json> [mais...] [--metric ${COMPARE_METRICS.join('|')}] [--json]`)
  process.exit(2)
}

const candidates = []
const problems = []

function fromCandidate (candidate, fallbackName) {
  if (!candidate || typeof candidate !== 'object')
    return
  candidates.push({
    name: String(candidate.name ?? fallbackName),
    trades: Array.isArray(candidate.trades) ? candidate.trades : undefined,
    metrics: candidate.metrics && typeof candidate.metrics === 'object' ? candidate.metrics : undefined,
    period: candidate.period ?? undefined,
    costs: candidate.costs ?? undefined,
  })
}

const trialSeries = []
for (const file of files) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    problems.push(`${file}: não é JSON (${error.message})`)
    continue
  }
  if (parsed?.schema_version) {
    const experiment = parseExperiment(JSON.stringify(parsed))
    fromCandidate({
      name: `${experiment.strategy?.name ?? basename(file)} ${JSON.stringify(experiment.parameters ?? {})}`.trim(),
      metrics: experiment.metrics,
      period: { start: experiment.period?.from, end: experiment.period?.to },
      costs: experiment.costs,
    }, basename(file))
    continue
  }
  if (Array.isArray(parsed?.candidates)) {
    for (const candidate of parsed.candidates)
      fromCandidate(candidate, basename(file))
    continue
  }
  trialSeries.push({ name: basename(file), returns: Array.isArray(parsed?.returns) ? parsed.returns : null, sharpe: parsed?.sharpe, observations: parsed?.observations, trials: parsed?.trials })
  fromCandidate(parsed, basename(file))
}

// §7: overfitting declarado, não presumido. PBO exige séries por tentativa; DSR exige Sharpe, observações e nº de tentativas.
const withSeries = trialSeries.filter((item) => Array.isArray(item.returns))
let pbo = null
let pboReason = null
if (withSeries.length >= 2) {
  try {
    const result = probabilityOfBacktestOverfitting({ returns: withSeries.map((item) => item.returns) })
    pbo = { value: result.pbo, combinations: result.combinations, splits: result.splits, trials: result.trials, capped: result.capped }
  } catch (error) {
    pboReason = String(error.message).slice(0, 120)
  }
} else {
  pboReason = 'sem séries de retorno por tentativa (campo "returns") em 2+ candidatos'
}
const withSharpe = trialSeries.find((item) => Number.isFinite(item.sharpe) && Number.isFinite(item.observations) && Number.isInteger(item.trials))
const deflated = withSharpe
  ? deflatedSharpeRatio({ sharpe: withSharpe.sharpe, observations: withSharpe.observations, trials: withSharpe.trials })
  : { value: null, reason: 'sem sharpe/observations/trials declarados no arquivo' }

// Monte Carlo sobre a série de retornos do primeiro candidato que trouxer uma (embaralha a ordem, mede ruína).
const seriesOwner = trialSeries.find((item) => Array.isArray(item.returns) && item.returns.length >= 10)
let monteCarlo = null
let monteCarloReason = null
if (montecarlo) {
  if (!seriesOwner) {
    monteCarloReason = 'sem série de retornos (campo "returns" com 10+ pontos) em nenhum candidato'
  } else {
    try {
      const result = runMonteCarlo(seriesOwner.returns.map((value) => ({ pnl: value })), { iterations: 2000, seed: 7 })
      monteCarlo = { iterations: result.iterations, netProfit: result.netProfit, maxDrawdown: result.maxDrawdown, probabilityOfRuin: result.probabilityOfRuin, probabilityOfProfit: result.probabilityOfProfit }
    } catch (error) {
      monteCarloReason = String(error.message).slice(0, 120)
    }
  }
}

// Walk-forward: divide a série em janelas cronológicas e reporta o resultado treino × teste por janela.
let walkForward = null
let walkForwardReason = null
if (walkforward) {
  if (!seriesOwner) {
    walkForwardReason = 'sem série de retornos para dividir em janelas'
  } else {
    const series = seriesOwner.returns
    const total = series.length
    if (total < 12) {
      walkForwardReason = `série curta: ${total} ponto(s), são necessários 12+`
    } else {
      const windows = walkForwardWindows(total, { trainSize: Math.max(4, Math.floor(total * 0.5)), testSize: Math.max(2, Math.floor(total * 0.25)) })
      const scored = runWalkForward(series, windows, (slice) => slice.reduce((sum, value) => sum + value, 0))
      walkForward = { windows: scored.length, results: scored.map((item) => ({ index: item.index, train: Number(item.train.toFixed(4)), test: Number(item.test.toFixed(4)) })) }
    }
  }
}

// O relatório de overfitting junta IS/OOS, PBO, DSR e os avisos num lugar só — em vez de eu montar a sopa aqui.
let report = null
if (seriesOwner) {
  const split = splitChronological(seriesOwner.returns, { isRatio: 0.7 })
  const sum = (values) => Number(values.reduce((total, value) => total + value, 0).toFixed(6))
  report = overfittingReport({
    inSample: sum(split.is),
    outOfSample: sum(split.oos),
    metric: 'netProfit',
    testedCombinations: candidates.length,
    deflated: deflated.value === null ? null : deflated,
    pbo: pbo === null ? null : pbo.value,
  })
}

const comparison = compareStrategies(candidates, { metric })
if (problems.length)
  comparison.problems = [...(comparison.problems ?? []), ...problems]

if (json) {
  const spread = spreadOf(comparison)
  console.log(JSON.stringify({ comparison: { ...comparison, spread, overfitting: { pbo, pboReason, deflated }, monteCarlo: montecarlo ? (monteCarlo ?? { reason: monteCarloReason }) : null,
    overfittingReport: report, walkForward: walkforward ? (walkForward ?? { reason: walkForwardReason }) : null } }, null, 2))
  process.exit(comparison.ok && comparison.comparable ? 0 : 1)
}

console.log(describeComparison(comparison))
if (report) {
  console.log(`\nRelatório de overfitting (${report.comparison?.verdict ?? '—'}): IS ${report.comparison?.isValue ?? '—'} → OOS ${report.comparison?.oosValue ?? '—'}${report.comparison?.degradationPct !== null && report.comparison?.degradationPct !== undefined ? ` (${Math.round(report.comparison.degradationPct)}% de degradação)` : ''}`)
  for (const warning of report.warnings) console.log(`  aviso ${warning.code}: ${warning.message}`)
  if (!report.warnings.length) console.log('  sem avisos automáticos')
}
console.log(`\nOverfitting (${withSeries.length} série(s) por tentativa):`)
console.log(pbo === null ? `  PBO: não calculado — ${pboReason}` : `  PBO: ${(pbo.value * 100).toFixed(0)}% (CSCV · ${pbo.combinations} combinações, ${pbo.splits} blocos)${pbo.value >= 0.5 ? ' · ALTO: o melhor resultado é compatível com sorte' : ''}`)
if (montecarlo)
  console.log(monteCarlo === null ? `  Monte Carlo: não calculado — ${monteCarloReason}` : `  Monte Carlo (${monteCarlo.iterations} reamostragens): lucro p5 ${monteCarlo.netProfit.p5.toFixed(3)} · p50 ${monteCarlo.netProfit.p50.toFixed(3)} · p95 ${monteCarlo.netProfit.p95.toFixed(3)} · ruína ${(monteCarlo.probabilityOfRuin * 100).toFixed(1)}% · P(lucro) ${(monteCarlo.probabilityOfProfit * 100).toFixed(0)}%`)
if (walkforward)
  console.log(walkForward === null ? `  Walk-forward: não calculado — ${walkForwardReason}` : `  Walk-forward (${walkForward.windows} janela(s)): ${walkForward.results.map((item) => `t${item.index} treino ${item.train} / teste ${item.test}`).join(' · ')}`)
console.log(deflated.value === null ? `  DSR: não calculado — ${deflated.reason}` : `  DSR: ${deflated.value.toFixed(3)}${deflated.value < 0.95 ? ' · ABAIXO de 0,95: não supera as tentativas testadas' : ''}`)
const spread = spreadOf(comparison)
if (spread)
  console.log(`- Distribuição de ${metric} entre as candidatas: ${Object.entries(spread).map(([key, value]) => `${key} ${Number(value).toFixed(2)}`).join(' · ')}`)
process.exit(comparison.ok && comparison.comparable ? 0 : 1)

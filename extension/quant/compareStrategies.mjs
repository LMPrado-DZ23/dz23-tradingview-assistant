// Strategy comparison for the Strategy Lab.
//
// Honest part first: choosing the best of N candidates inflates the winner. This module refuses to compare things that are
// not comparable (different periods or different cost assumptions), ranks by ONE declared metric, and quantifies how much
// of the winner's edge is expected to be selection noise — the maximum of N standard normals, times the metric's standard
// error is not available here, so it reports the expected-max z and the winner's z-score to be read against it.

import { computeMetrics, percentiles } from './metrics.mjs'
import { createRandom } from './montecarlo.mjs'

export const COMPARE_VERSION = '1.0.0'

// E[max of n standard normals], by deterministic simulation (seeded), cached per n.
const maxZCache = new Map()
export function expectedMaxZ (n, { samples = 20_000, seed = 7 } = {}) {
  if (!Number.isInteger(n) || n < 1)
    throw new Error('n precisa ser inteiro >= 1')
  if (n === 1)
    return 0
  if (maxZCache.has(n))
    return maxZCache.get(n)
  const random = createRandom(seed)
  let total = 0
  for (let sample = 0; sample < samples; sample += 1) {
    let best = -Infinity
    for (let candidate = 0; candidate < n; candidate += 1) {
      // Box-Muller with two uniforms from the seeded generator
      const u1 = Math.max(random(), Number.EPSILON)
      const u2 = random()
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      if (z > best)
        best = z
    }
    total += best
  }
  const value = Math.round((total / samples) * 1000) / 1000
  maxZCache.set(n, value)
  return value
}

function periodOf (candidate) {
  const trades = candidate.trades ?? []
  const entries = trades.map((trade) => trade.entryTime ?? trade.entry_time ?? null).filter(Boolean)
  const exits = trades.map((trade) => trade.exitTime ?? trade.exit_time ?? null).filter(Boolean)
  return {
    start: entries.length ? String(entries.reduce((a, b) => (String(a) < String(b) ? a : b))) : candidate.metrics?.period?.start ?? null,
    end: exits.length ? String(exits.reduce((a, b) => (String(a) > String(b) ? a : b))) : candidate.metrics?.period?.end ?? null,
  }
}

export const COMPARE_METRICS = ['sharpe', 'sortino', 'profitFactor', 'expectancy', 'winRate', 'maxDrawdown']

export function compareStrategies (candidates = [], { metric = 'sharpe', periodsPerYear = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length < 2)
    return { ok: false, reason: 'comparação precisa de pelo menos duas estratégias' }
  if (!COMPARE_METRICS.includes(metric))
    return { ok: false, reason: `métrica inválida: use ${COMPARE_METRICS.join(', ')}` }

  const prepared = []
  const problems = []
  for (const candidate of candidates) {
    const name = String(candidate?.name ?? '').trim()
    if (!name) {
      problems.push('estratégia sem nome')
      continue
    }
    const metrics = candidate.metrics ?? (Array.isArray(candidate.trades) ? computeMetrics(candidate.trades, { periodsPerYear }) : null)
    if (!metrics) {
      problems.push(`${name}: sem métricas nem trades para calcular`)
      continue
    }
    prepared.push({ name, metrics, period: candidate.period ?? periodOf(candidate), costs: candidate.costs ?? null })
  }
  if (prepared.length < 2)
    return { ok: false, reason: 'restaram menos de duas estratégias comparáveis', problems }

  // Comparabilidade: mesmo período e mesmas premissas de custo, senão a comparação seria enganosa.
  const periods = new Set(prepared.map((item) => `${item.period?.start ?? '?'}..${item.period?.end ?? '?'}`))
  const costs = new Set(prepared.map((item) => JSON.stringify(item.costs ?? null)))
  const comparable = periods.size === 1 && costs.size === 1
  if (!comparable) {
    if (periods.size > 1)
      problems.push(`períodos diferentes: ${[...periods].join(' vs ')}`)
    if (costs.size > 1)
      problems.push('premissas de custo diferentes entre as estratégias')
  }

  const rows = prepared.map((item) => ({
    name: item.name,
    sharpe: item.metrics.sharpe ?? null,
    sortino: item.metrics.sortino ?? null,
    profitFactor: item.metrics.profitFactor ?? null,
    expectancy: item.metrics.expectancy ?? null,
    winRate: item.metrics.winRate ?? null,
    maxDrawdown: item.metrics.maxDrawdown ?? null,
    trades: item.metrics.trades ?? item.metrics.count ?? null,
    value: item.metrics[metric] ?? null,
  }))

  const ranked = [...rows]
    .filter((row) => typeof row.value === 'number')
    .sort((a, b) => (metric === 'maxDrawdown' ? a.value - b.value : b.value - a.value))
  const best = ranked[0] ?? null
  const maxZ = expectedMaxZ(rows.length)

  return {
    ok: true,
    version: COMPARE_VERSION,
    metric,
    rows,
    ranked,
    best: best?.name ?? null,
    comparable,
    problems,
    selectionBias: {
      candidates: rows.length,
      expectedMaxZ: maxZ,
      note: `escolher a melhor de ${rows.length} candidatas infla o resultado: o máximo de ${rows.length} ruídos padrão fica em torno de ${maxZ}σ. Só trate a vencedora como superior se a diferença sobreviver a um teste fora da amostra.`,
    },
    disclaimer: 'comparação de resultados históricos, não previsão nem recomendação de operação',
  }
}

export function describeComparison (comparison) {
  if (!comparison?.ok)
    return `comparação indisponível: ${comparison?.reason ?? 'sem dados'}${comparison?.problems?.length ? ` (${comparison.problems.join('; ')})` : ''}`
  const lines = [`Comparação por ${comparison.metric} · ${comparison.rows.length} estratégias${comparison.comparable ? '' : ' · NÃO comparáveis'}`]
  for (const row of comparison.rows) {
    const mark = row.name === comparison.best ? ' ← melhor' : ''
    lines.push(`- ${row.name}: ${comparison.metric} ${format(row.value)} · PF ${format(row.profitFactor)} · expectância ${format(row.expectancy)} · DD ${format(row.maxDrawdown)} · ${row.trades ?? '?'} trades${mark}`)
  }
  if (comparison.problems.length)
    lines.push(`- Avisos: ${comparison.problems.join('; ')}`)
  lines.push(`- Viés de seleção: ${comparison.selectionBias.note}`)
  lines.push(`- ${comparison.disclaimer}`)
  return lines.join('\n')
}

function format (value) {
  if (value === null || value === undefined)
    return '—'
  return typeof value === 'number' ? value.toFixed(2) : String(value)
}

// Distribution of the metric across candidates, useful to see whether the "winner" is an outlier or the middle of noise.
export function spreadOf (comparison) {
  if (!comparison?.ok)
    return null
  const values = comparison.rows.map((row) => row.value).filter((value) => typeof value === 'number')
  if (values.length < 2)
    return null
  return percentiles(values, [5, 50, 95])
}

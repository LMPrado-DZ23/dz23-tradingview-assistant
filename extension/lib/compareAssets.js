// Head-to-head asset comparison: facts side by side, with the rule stated and nothing called a "better trade".
//
// Two symbols are comparable only on the same timeframe and from the same source; anything else is reported as a caveat.
// Metrics that do not exist for one side are shown as "—" instead of being filled with zero.

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)

const zoneOf = (rsi) => {
  if (typeof rsi !== 'number')
    return '—'
  if (rsi >= 70) return 'sobrecompra'
  if (rsi <= 30) return 'sobrevenda'
  if (rsi >= 55) return 'força'
  if (rsi <= 45) return 'fraqueza'
  return 'neutra'
}

export const COMPARE_ASSET_METRICS = ['rsi', 'atrPercent', 'changePercent', 'volumeRatio', 'distanceToVwap']

export function compareAssets (entries = [], { timeframe = null } = {}) {
  if (!Array.isArray(entries) || entries.length < 2)
    return { ok: false, reason: 'comparação precisa de pelo menos dois ativos' }

  const rows = []
  const missing = []
  for (const entry of entries) {
    const symbol = String(entry?.symbol ?? '').trim().toUpperCase()
    if (!symbol) {
      missing.push({ symbol: '?', reason: 'entrada sem símbolo' })
      continue
    }
    const intel = entry.intel
    if (!intel?.available) {
      missing.push({ symbol, reason: intel?.missing?.[0] ?? 'sem dados' })
      continue
    }
    const price = Number(entry.price)
    const vwapDistance = Number.isFinite(price) && Number.isFinite(intel.vwap) && intel.vwap > 0
      ? round(((price - intel.vwap) / intel.vwap) * 100, 3)
      : null
    rows.push({
      symbol,
      price: Number.isFinite(price) ? price : null,
      trend: intel.trend ?? null,
      rsi: round(intel.rsi),
      zone: zoneOf(intel.rsi),
      atrPercent: round(intel.atrPercent),
      changePercent: round(entry.changePercent),
      volumeRatio: round(entry.volumeRatio),
      distanceToVwap: vwapDistance,
      divergence: intel.divergence?.bearish ? 'baixa' : intel.divergence?.bullish ? 'alta' : null,
      source: entry.source ?? intel.source ?? null,
      sample: intel.sample ?? 0,
    })
  }

  if (rows.length < 2)
    return { ok: false, reason: 'menos de dois ativos com dados', rows, missing }

  const sources = new Set(rows.map((row) => row.source ?? '?'))
  const caveats = []
  if (sources.size > 1)
    caveats.push(`fontes diferentes (${[...sources].join(', ')}): os números não são estritamente comparáveis`)
  if (timeframe && rows.some((row) => row.sample < 20))
    caveats.push('amostra insuficiente em pelo menos um ativo (< 20 candles)')

  // Regra declarada: força relativa = RSI normalizado + tendência + distância ao VWAP. Não é recomendação.
  const scoreOf = (row) => {
    let score = 0
    if (row.trend === 'alta') score += 1
    if (row.trend === 'baixa') score -= 1
    if (typeof row.rsi === 'number') score += (row.rsi - 50) / 100
    if (typeof row.distanceToVwap === 'number') score += Math.sign(row.distanceToVwap) * 0.25
    return round(score, 3)
  }
  for (const row of rows)
    row.relativeStrength = scoreOf(row)

  const ranked = [...rows].sort((a, b) => (b.relativeStrength ?? 0) - (a.relativeStrength ?? 0))
  const metricWinners = {}
  for (const metric of COMPARE_ASSET_METRICS) {
    const valid = rows.filter((row) => typeof row[metric] === 'number')
    if (!valid.length) {
      metricWinners[metric] = null
      continue
    }
    metricWinners[metric] = [...valid].sort((a, b) => b[metric] - a[metric])[0].symbol
  }

  return {
    ok: true,
    timeframe,
    rows,
    ranked,
    leader: ranked[0].symbol,
    metricWinners,
    caveats,
    missing,
    rule: 'força relativa = tendência (±1) + (RSI−50)/100 + sinal da distância ao VWAP (0,25); comparação de fatos, não recomendação',
  }
}

export function describeAssetComparison (result) {
  if (!result?.ok)
    return `comparação indisponível: ${result?.reason ?? 'sem dados'}${result?.missing?.length ? ` (sem dados: ${result.missing.map((item) => item.symbol).join(', ')})` : ''}`
  const lines = [result.rule]
  for (const row of result.rows) {
    lines.push(`- ${row.symbol}: ${row.price ?? '—'} · tendência ${row.trend ?? '—'} · RSI ${row.rsi ?? '—'} (${row.zone}) · ATR ${row.atrPercent ?? '—'}% · variação ${row.changePercent ?? '—'}% · VWAP ${row.distanceToVwap ?? '—'}% · vol. rel. ${row.volumeRatio ?? '—'}${row.divergence ? ` · divergência de ${row.divergence}` : ''}`)
  }
  lines.push(`- Força relativa (regra declarada): ${result.ranked.map((row) => `${row.symbol} ${row.relativeStrength}`).join(' · ')}`)
  if (result.caveats.length)
    lines.push(`- Ressalvas: ${result.caveats.join('; ')}`)
  lines.push('Isto é comparação de fatos calculados; qualquer decisão é interpretação.')
  return lines.join('\n')
}

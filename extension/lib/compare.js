// Multi-timeframe comparison: the brief asks "compare the 15-minute scenario with the 4-hour one".
//
// This is a fixed comparison of computed facts — trend per timeframe, RSI zone, ATR% and position in the recent range —
// and it names agreement and conflict explicitly. It never says "buy": the interpretation is the model's job and must be
// labelled as such. Missing data is listed as missing, not filled with a guess.

const round = (value, digits = 2) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)

const zoneOf = (rsi) => {
  if (typeof rsi !== 'number')
    return 'desconhecida'
  if (rsi >= 70) return 'sobrecompra'
  if (rsi <= 30) return 'sobrevenda'
  if (rsi >= 55) return 'força'
  if (rsi <= 45) return 'fraqueza'
  return 'neutra'
}

export function compareTimeframes (entries = []) {
  const facts = []
  const missing = []
  const usable = []
  for (const entry of entries) {
    const timeframe = entry?.timeframe ?? entry?.intel?.timeframe ?? null
    const intel = entry?.intel
    if (!intel?.available) {
      missing.push({ timeframe, reason: intel?.missing?.[0] ?? 'sem dados' })
      continue
    }
    const fact = {
      timeframe,
      trend: intel.trend ?? null,
      rsi: intel.rsi ?? null,
      zone: zoneOf(intel.rsi),
      atrPercent: intel.atrPercent ?? null,
      closePosition: typeof entry.price === 'number' && intel.structure?.rangeHigh > intel.structure?.rangeLow
        ? round((entry.price - intel.structure.rangeLow) / (intel.structure.rangeHigh - intel.structure.rangeLow), 3)
        : null,
      divergence: intel.divergence?.bearish ? 'baixa' : intel.divergence?.bullish ? 'alta' : null,
      sample: intel.sample ?? 0,
    }
    usable.push(fact)
    facts.push(fact)
  }

  if (usable.length < 2)
    return { ok: false, reason: 'comparação precisa de pelo menos dois timeframes com dados', facts, missing, usable: false }

  const trends = new Set(usable.map((fact) => fact.trend).filter(Boolean))
  const aligned = trends.size === 1 && !trends.has(null)
  const conflicts = []
  if (!aligned) {
    for (const fact of usable)
      conflicts.push(`${fact.timeframe}: tendência ${fact.trend ?? 'indefinida'}`)
  }

  // Volatilidade relativa: ATR% do timeframe menor vs maior, como razão explícita.
  const withAtr = usable.filter((fact) => typeof fact.atrPercent === 'number').sort((a, b) => (a.atrPercent ?? 0) - (b.atrPercent ?? 0))
  const volatility = withAtr.length >= 2
    ? { low: withAtr[0].timeframe, high: withAtr[withAtr.length - 1].timeframe, ratio: round(withAtr[withAtr.length - 1].atrPercent / (withAtr[0].atrPercent || 1), 2) }
    : null

  const zones = usable.map((fact) => `${fact.timeframe} ${fact.zone}`)
  const divergences = usable.filter((fact) => fact.divergence).map((fact) => `${fact.timeframe} ${fact.divergence}`)

  return {
    ok: true,
    usable: true,
    facts,
    missing,
    aligned,
    conflicts,
    volatility,
    zones,
    divergences,
    rule: 'tendência por médias em cada timeframe + zona de RSI + ATR% + posição na faixa; comparação de fatos, não recomendação',
  }
}

export function describeComparison (result) {
  if (!result?.ok)
    return `comparação indisponível: ${result?.reason ?? 'sem dados'}${result?.missing?.length ? ` (faltou: ${result.missing.map((item) => item.timeframe ?? '?').join(', ')})` : ''}`
  const lines = [result.rule]
  for (const fact of result.facts) {
    lines.push(`- ${fact.timeframe}: tendência ${fact.trend ?? 'indefinida'} · RSI ${fact.rsi ?? '—'} (${fact.zone}) · ATR ${fact.atrPercent ?? '—'}% · posição na faixa ${fact.closePosition === null ? '—' : `${(fact.closePosition * 100).toFixed(0)}%`}${fact.divergence ? ` · divergência de ${fact.divergence}` : ''}`)
  }
  lines.push(`- Alinhamento de tendência: ${result.aligned ? 'sim, todos os timeframes concordam' : `não — ${result.conflicts.join('; ')}`}`)
  if (result.volatility)
    lines.push(`- Volatilidade (ATR%): ${result.volatility.high} é ${result.volatility.ratio}× o ${result.volatility.low}`)
  if (result.divergences.length)
    lines.push(`- Divergências: ${result.divergences.join('; ')}`)
  if (result.missing.length)
    lines.push(`- Sem dados: ${result.missing.map((item) => `${item.timeframe ?? '?'} (${item.reason})`).join('; ')}`)
  lines.push('Isto é comparação de fatos calculados; qualquer conclusão de operação é interpretação.')
  return lines.join('\n')
}

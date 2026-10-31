// DZ23 — indicators: classify what the page actually exposes. Nothing here computes an indicator.
//
// A chart can show an indicator whose numeric value is not readable (it is painted on a canvas). The product must
// then say "configured, value not accessible" instead of inventing an RSI. Three states, one function.

export const INDICATOR_STATES = { value: 'value', configured: 'configured_no_value', unknown: 'unknown' }

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9 ()+._-]{0,40}$/

/**
 * One row from the page becomes { name, value, state }:
 *  - value: a finite number that the page really exposed;
 *  - configured_no_value: the indicator is there, the number is not readable;
 *  - unknown: no usable name, so nothing can be claimed about it.
 */
export function classifyIndicator (row) {
  const name = typeof row?.name === 'string' ? row.name.trim() : ''
  const raw = row?.value
  const value = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : null)
  if (!name || !NAME_PATTERN.test(name))
    return { name: name || null, value: null, state: INDICATOR_STATES.unknown, reason: 'the page did not expose an indicator name' }
  if (Number.isFinite(value) && value !== null)
    return { name, value, state: INDICATOR_STATES.value, reason: null }
  return { name, value: null, state: INDICATOR_STATES.configured, reason: 'configured on the chart, value not accessible' }
}

export function classifyIndicators (rows) {
  const list = Array.isArray(rows) ? rows.map(classifyIndicator) : []
  return {
    indicators: list,
    counts: {
      value: list.filter((indicator) => indicator.state === INDICATOR_STATES.value).length,
      configured: list.filter((indicator) => indicator.state === INDICATOR_STATES.configured).length,
      unknown: list.filter((indicator) => indicator.state === INDICATOR_STATES.unknown).length,
    },
  }
}

// Only indicators with a real value may be quoted as numbers; the others carry their state.
export function indicatorLines (rows) {
  const { indicators, counts } = classifyIndicators(rows)
  if (!indicators.length)
    return { lines: ['- Indicadores: nenhum valor acessível'], counts }
  return {
    lines: indicators.map((indicator) => indicator.state === INDICATOR_STATES.value
      ? `- Indicador ${indicator.name}: ${indicator.value}`
      : indicator.state === INDICATOR_STATES.configured
        ? `- Indicador ${indicator.name}: configurado, valor não acessível`
        : '- Indicador não identificado'),
    counts,
  }
}

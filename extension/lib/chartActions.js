// Chart actions for the copilot: change symbol / timeframe on the TradingView tab and prove the change happened.
//
// TradingView exposes no stable public API for "set symbol" from a page script, and clicking painted widgets breaks on
// every redesign. The stable integration point is the chart URL: `/chart/<EXCHANGE:SYMBOL>/?interval=<n>`. The content
// script navigates to that URL; the bridge then reads the legend back and the panel compares the new observation with
// what was requested. "Sent" is never reported as "done": the result carries the expected state and the observed one.

export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9._-]{1,20}(:[A-Z][A-Z0-9._-]{1,20})?$/
export const INTERVALS = {
  '1m': 1,
  '3m': 3,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '45m': 45,
  '1h': 60,
  '2h': 120,
  '4h': 240,
  '6h': 360,
  '12h': 720,
  '1D': 'D',
  '1W': 'W',
  '1M': 'M',
}

export function normalizeSymbol (value) {
  const raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (!raw)
    return { ok: false, reason: 'símbolo vazio' }
  const withExchange = raw.includes(':') ? raw : raw
  if (!SYMBOL_PATTERN.test(withExchange))
    return { ok: false, reason: 'símbolo inválido: use BTCUSDT ou BINANCE:BTCUSDT' }
  return { ok: true, symbol: withExchange }
}

export function normalizeInterval (value) {
  const raw = String(value ?? '').trim()
  if (!raw)
    return { ok: false, reason: 'timeframe vazio' }
  const upper = raw.toUpperCase()
  for (const key of Object.keys(INTERVALS)) {
    if (key.toUpperCase() === upper)
      return { ok: true, timeframe: key, interval: INTERVALS[key] }
  }
  // "60" is a valid TradingView interval even when it has no label
  const numeric = Number(raw)
  if (Number.isInteger(numeric) && numeric > 0 && numeric <= 10080)
    return { ok: true, timeframe: `${numeric}`, interval: numeric }
  return { ok: false, reason: `timeframe inválido: use ${Object.keys(INTERVALS).join(', ')}` }
}

// Builds the URL for the requested change from the chart the tab is showing right now.
export function buildActionUrl ({ href, current, change = {} }) {
  const base = new URL(href ?? 'https://www.tradingview.com/chart/')
  const symbol = change.symbol ? normalizeSymbol(change.symbol) : null
  const interval = change.timeframe ? normalizeInterval(change.timeframe) : null
  if (symbol && !symbol.ok)
    return { ok: false, reason: symbol.reason }
  if (interval && !interval.ok)
    return { ok: false, reason: interval.reason }
  if (!symbol && !interval)
    return { ok: false, reason: 'nada para mudar' }

  const target = symbol ? symbol.symbol : (current?.symbol ?? '')
  if (!target)
    return { ok: false, reason: 'ativo atual desconhecido: informe o símbolo' }
  const exchange = target.includes(':') ? target.split(':')[0] : (current?.exchange ?? '')
  const pair = exchange && !target.includes(':') ? `${exchange}:${target}` : target

  const url = new URL(`/chart/${encodeURIComponent(pair).replace(/%3A/gi, ':')}/`, base)
  const wantedInterval = interval ? interval.interval : (current?.resolution ?? null)
  if (wantedInterval !== null && wantedInterval !== undefined)
    url.searchParams.set('interval', String(wantedInterval))
  // keep the layout the user is on, when the current URL carries one
  const layout = base.searchParams.get('layout')
  if (layout)
    url.searchParams.set('layout', layout)
  return {
    ok: true,
    url: url.toString(),
    expected: {
      symbol: (pair.split(':')[1] ?? pair).toUpperCase(),
      exchange: pair.includes(':') ? pair.split(':')[0].toUpperCase() : '',
      timeframe: interval ? interval.timeframe : (current?.timeframe ?? null),
    },
  }
}

// Compares what was asked with what the bridge read afterwards. Missing pieces are mismatches, never "assumed".
export function verifyAction (expected, observation) {
  const mismatches = []
  if (!observation || observation.source === 'none')
    return { ok: false, mismatches: ['nenhum gráfico observado na aba'] }

  const observedSymbol = String(observation.rawSymbol ?? '').toUpperCase()
  const observedPair = observedSymbol.includes(':') ? observedSymbol.split(':')[1] : observedSymbol
  if (expected.symbol && observedPair !== expected.symbol.toUpperCase())
    mismatches.push(`ativo: esperado ${expected.symbol}, observado ${observedPair || 'nada'}`)

  if (expected.exchange && observedSymbol.includes(':')) {
    const observedExchange = observedSymbol.split(':')[0]
    if (observedExchange && observedExchange !== expected.exchange.toUpperCase())
      mismatches.push(`exchange: esperada ${expected.exchange}, observada ${observedExchange}`)
  }

  if (expected.timeframe) {
    const wanted = normalizeInterval(expected.timeframe)
    const observed = observation.resolution === 'D' || observation.resolution === 'W' || observation.resolution === 'M'
      ? `${observation.resolution === 'D' ? '1D' : observation.resolution === 'W' ? '1W' : '1M'}`
      : `${observation.resolution}m`
    if (wanted.ok && observed !== wanted.timeframe)
      mismatches.push(`timeframe: esperado ${wanted.timeframe}, observado ${observed}`)
  }

  return { ok: mismatches.length === 0, mismatches }
}

// Human-readable outcome for the panel
export function describeAction (result) {
  if (!result)
    return 'sem resultado'
  if (result.verified)
    return `aplicado e confirmado: ${result.expected.symbol}${result.expected.timeframe ? ` · ${result.expected.timeframe}` : ''}`
  if (result.mismatches?.length)
    return `enviado, mas não confirmado — ${result.mismatches.join('; ')}`
  return `falhou: ${result.reason ?? 'motivo desconhecido'}`
}

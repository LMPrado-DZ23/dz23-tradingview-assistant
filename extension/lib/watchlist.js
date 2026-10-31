// Watchlists: local lists of symbols, with comparison and an honest ranking.
//
// A watchlist here is DZ23 data stored in the shared configuration — not a TradingView list, which has no public API.
// "Opportunities" are not buy signals: each entry carries the numbers used and the rule applied, and a symbol without
// data is listed with the reason instead of a guess.

export const MAX_LISTS = 20
export const MAX_SYMBOLS = 60
export const SYMBOL_PATTERN = /^[A-Z][A-Z0-9._-]{1,20}(:[A-Z][A-Z0-9._-]{1,20})?$/

export function normalizeSymbol (value) {
  const raw = String(value ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (!raw)
    return { ok: false, reason: 'símbolo vazio' }
  if (!SYMBOL_PATTERN.test(raw))
    return { ok: false, reason: `símbolo inválido: ${raw}` }
  return { ok: true, symbol: raw }
}

const sameSymbol = (left, right) => left.toUpperCase() === right.toUpperCase()

// O limite é do conjunto, não da lista: só faz sentido no ponto que conhece quantas já existem.
export function canAddList (lists) {
  const total = Array.isArray(lists) ? lists.length : 0
  return total < MAX_LISTS
    ? { ok: true, remaining: MAX_LISTS - total }
    : { ok: false, reason: `limite de ${MAX_LISTS} listas atingido` }
}

export function createList (name, symbols = []) {
  const cleanName = String(name ?? '').trim().slice(0, 40)
  if (!cleanName)
    return { ok: false, reason: 'a lista precisa de um nome' }
  const accepted = []
  for (const candidate of symbols.slice(0, MAX_SYMBOLS)) {
    const normalized = normalizeSymbol(candidate)
    if (normalized.ok && !accepted.includes(normalized.symbol))
      accepted.push(normalized.symbol)
  }
  return { ok: true, list: { id: `wl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, name: cleanName, symbols: accepted, createdAt: new Date().toISOString() } }
}

export function addSymbol (lists, listId, symbol) {
  const normalized = normalizeSymbol(symbol)
  if (!normalized.ok)
    return { ok: false, reason: normalized.reason }
  const list = lists.find((item) => item.id === listId)
  if (!list)
    return { ok: false, reason: 'lista não encontrada' }
  if (list.symbols.some((item) => sameSymbol(item, normalized.symbol)))
    return { ok: false, reason: `${normalized.symbol} já está na lista`, duplicate: true, lists }
  if (list.symbols.length >= MAX_SYMBOLS)
    return { ok: false, reason: `a lista já tem ${MAX_SYMBOLS} símbolos` }
  const updated = lists.map((item) => (item.id === listId ? { ...item, symbols: [...item.symbols, normalized.symbol] } : item))
  return { ok: true, symbol: normalized.symbol, lists: updated }
}

export function removeSymbol (lists, listId, symbol) {
  const list = lists.find((item) => item.id === listId)
  if (!list)
    return { ok: false, reason: 'lista não encontrada' }
  if (!list.symbols.some((item) => sameSymbol(item, symbol)))
    return { ok: false, reason: `${symbol} não está na lista` }
  const updated = lists.map((item) => (item.id === listId ? { ...item, symbols: item.symbols.filter((entry) => !sameSymbol(entry, symbol)) } : item))
  return { ok: true, lists: updated }
}

// Comparison between two lists: what is only in one, and what both share (order-independent).
export function compareLists (left = [], right = []) {
  const leftSet = new Set(left.map((symbol) => symbol.toUpperCase()))
  const rightSet = new Set(right.map((symbol) => symbol.toUpperCase()))
  return {
    onlyLeft: [...leftSet].filter((symbol) => !rightSet.has(symbol)),
    onlyRight: [...rightSet].filter((symbol) => !leftSet.has(symbol)),
    both: [...leftSet].filter((symbol) => rightSet.has(symbol)),
  }
}

// Turns per-symbol market readings into a ranked list. The rule is fixed and stated; missing data is reported.
export function rankOpportunities (entries = [], { minSample = 20 } = {}) {
  const scored = []
  const withoutData = []
  for (const entry of entries) {
    const { symbol, intel, source, timeframe } = entry
    if (!intel?.available || (intel.sample ?? 0) < minSample) {
      withoutData.push({ symbol, reason: intel?.missing?.[0] ?? `amostra insuficiente (< ${minSample} candles)`, sample: intel?.sample ?? 0 })
      continue
    }
    // Regra fixa: tendência pela média, RSI em zona, distância ao VWAP. Não é sinal de compra.
    let score = 0
    const reasons = []
    if (intel.trend === 'alta') { score += 2; reasons.push('tendência de alta (EMA20 > EMA50 e preço acima da EMA20)') }
    if (intel.trend === 'baixa') { score -= 2; reasons.push('tendência de baixa') }
    if (typeof intel.rsi === 'number') {
      if (intel.rsi >= 55 && intel.rsi <= 70) { score += 1; reasons.push(`RSI ${intel.rsi} em zona de força`) }
      if (intel.rsi < 30) { score += 0.5; reasons.push(`RSI ${intel.rsi} em sobrevenda`) }
      if (intel.rsi > 75) { score -= 0.5; reasons.push(`RSI ${intel.rsi} esticado`) }
    }
    if (typeof intel.vwap === 'number' && typeof entry.price === 'number' && intel.vwap > 0) {
      const distance = ((entry.price - intel.vwap) / intel.vwap) * 100
      if (distance > 0) { score += 0.5; reasons.push(`preço ${distance.toFixed(2)}% acima do VWAP`) }
      else reasons.push(`preço ${Math.abs(distance).toFixed(2)}% abaixo do VWAP`)
    }
    scored.push({ symbol, score: Number(score.toFixed(2)), reasons, source: source ?? intel.source ?? null, timeframe: timeframe ?? intel.timeframe ?? null, sample: intel.sample, rsi: intel.rsi ?? null, trend: intel.trend ?? null })
  }
  scored.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
  return {
    ranked: scored,
    withoutData,
    rule: 'tendência (EMA20/EMA50 e preço) + RSI (força/sobrevenda/esticado) + distância ao VWAP; não é recomendação de operação',
    minSample,
  }
}

export function describeRanking (result) {
  if (!result)
    return 'sem avaliação'
  const lines = [result.rule]
  for (const entry of result.ranked)
    lines.push(`- ${entry.symbol}: score ${entry.score} · ${entry.reasons.join('; ') || 'sem justificativa'} · ${entry.sample} candles`)
  for (const entry of result.withoutData)
    lines.push(`- ${entry.symbol}: sem dados (${entry.reason})`)
  return lines.join('\n')
}

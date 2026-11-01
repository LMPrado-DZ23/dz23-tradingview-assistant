// Market Intelligence: the numbers the copilot may cite instead of describing candles in prose.
//
// Everything here is computed from the OHLCV the panel already fetches (extension/lib/candles.js). The output always
// carries where it came from — source, timeframe, how many candles, the timestamp of the last one — and every metric
// that could not be computed is reported as unavailable with the reason, never as zero or as a guess.
//
// Pure functions: no fetch, no DOM. Tests use fixed series with hand-checked values.

export const INDICATOR_LIMITS = { rsi: 15, macd: 35, bollinger: 20, atr: 15, ema: 50, structure: 20 }

const round = (value, digits = 4) => (Number.isFinite(value) ? Number(value.toFixed(digits)) : null)
const closesOf = (candles) => candles.map((candle) => candle.close)

export function sma (values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0)
    return null
  const slice = values.slice(-period)
  return slice.reduce((total, value) => total + value, 0) / period
}

export function ema (values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0)
    return null
  const k = 2 / (period + 1)
  let value = values.slice(0, period).reduce((total, item) => total + item, 0) / period
  for (let index = period; index < values.length; index += 1)
    value = values[index] * k + value * (1 - k)
  return value
}

// Wilder's RSI: average gains/losses over the period, then smoothed. 100 on a monotonic rise, 0 on a fall.
export function rsi (values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1)
    return null
  const changes = []
  for (let index = 1; index < values.length; index += 1)
    changes.push(values[index] - values[index - 1])
  let gain = 0
  let loss = 0
  for (let index = 0; index < period; index += 1) {
    if (changes[index] > 0) gain += changes[index]
    else loss -= changes[index]
  }
  let averageGain = gain / period
  let averageLoss = loss / period
  for (let index = period; index < changes.length; index += 1) {
    const change = changes[index]
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
  }
  if (averageLoss === 0)
    return averageGain === 0 ? 50 : 100
  const strength = averageGain / averageLoss
  return 100 - 100 / (1 + strength)
}

// Série do RSI: necessária para comparar o indicador em dois pivôs de preço (divergência).
export function rsiSeries (values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1)
    return []
  const out = new Array(values.length).fill(null)
  let gain = 0
  let loss = 0
  for (let index = 1; index <= period; index += 1) {
    const change = values[index] - values[index - 1]
    if (change > 0) gain += change
    else loss -= change
  }
  let averageGain = gain / period
  let averageLoss = loss / period
  out[period] = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
  for (let index = period + 1; index < values.length; index += 1) {
    const change = values[index] - values[index - 1]
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period
    out[index] = averageLoss === 0 ? (averageGain === 0 ? 50 : 100) : 100 - 100 / (1 + averageGain / averageLoss)
  }
  return out
}

// Padrões de candle: geometria pura de OHLC sobre a barra atual e a anterior. Cada achado cita a regra aplicada,
// e nenhum é interpretado aqui — "martelo" é um formato, não um sinal de compra.
export const CANDLE_PATTERNS = {
  doji: 'corpo <= 10% da amplitude (avaliado depois de martelo/estrela/marubozu)',
  hammer: 'sombra inferior >= 2x o corpo e superior <= corpo',
  shooting_star: 'sombra superior >= 2x o corpo e inferior <= corpo',
  bullish_engulfing: 'barra de alta que engole o corpo da anterior de baixa',
  bearish_engulfing: 'barra de baixa que engole o corpo da anterior de alta',
  inside_bar: 'amplitude dentro da anterior',
  marubozu: 'corpo >= 90% da amplitude',
}

export function detectCandlestickPatterns (candles, { lookback = 10 } = {}) {
  if (!Array.isArray(candles) || candles.length < 3)
    return []
  const found = []
  const start = Math.max(1, candles.length - lookback)
  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index]
    const previous = candles[index - 1]
    const range = candle.high - candle.low
    if (!(range > 0))
      continue
    const body = Math.abs(candle.close - candle.open)
    const upper = candle.high - Math.max(candle.open, candle.close)
    const lower = Math.min(candle.open, candle.close) - candle.low
    const prevBody = Math.abs(previous.close - previous.open)
    const at = { index, time: candle.time ?? null, rule: null }
    // Ordem por especificidade: um martelo de corpo pequeno também é "doji", e o formato com sombra longa
    // diz mais do que "corpo pequeno" — então as regras específicas vêm antes.
    if (lower >= body * 2 && upper <= body)
      found.push({ ...at, pattern: 'hammer', rule: CANDLE_PATTERNS.hammer })
    else if (upper >= body * 2 && lower <= body)
      found.push({ ...at, pattern: 'shooting_star', rule: CANDLE_PATTERNS.shooting_star })
    else if (body >= range * 0.9)
      found.push({ ...at, pattern: 'marubozu', rule: CANDLE_PATTERNS.marubozu })
    else if (body <= range * 0.1)
      found.push({ ...at, pattern: 'doji', rule: CANDLE_PATTERNS.doji })
    if (previous.close < previous.open && candle.close > candle.open && candle.open <= previous.close && candle.close >= previous.open)
      found.push({ ...at, pattern: 'bullish_engulfing', rule: CANDLE_PATTERNS.bullish_engulfing })
    else if (previous.close > previous.open && candle.close < candle.open && candle.open >= previous.close && candle.close <= previous.open)
      found.push({ ...at, pattern: 'bearish_engulfing', rule: CANDLE_PATTERNS.bearish_engulfing })
    if (candle.high < previous.high && candle.low > previous.low && prevBody > 0)
      found.push({ ...at, pattern: 'inside_bar', rule: CANDLE_PATTERNS.inside_bar })
  }
  return found.slice(-6)
}

// Divergência clássica entre preço e RSI nos dois últimos pivôs do mesmo tipo.
// Fato geométrico, com os quatro números citados; a leitura fica para o modelo, rotulada.
export function detectDivergence (candles, period = 14, lookback = 60) {
  if (!Array.isArray(candles) || candles.length < period + 10)
    return null
  const window = candles.slice(-lookback)
  const closes = window.map((candle) => candle.close)
  const series = rsiSeries(closes, period)
  const highs = []
  const lows = []
  for (let index = 2; index < window.length - 2; index += 1) {
    if (series[index] === null)
      continue
    const candle = window[index]
    const before = window.slice(index - 2, index)
    const after = window.slice(index + 1, index + 3)
    if (before.every((item) => item.high < candle.high) && after.every((item) => item.high < candle.high))
      highs.push({ index, price: candle.high, rsi: series[index] })
    if (before.every((item) => item.low > candle.low) && after.every((item) => item.low > candle.low))
      lows.push({ index, price: candle.low, rsi: series[index] })
  }
  const result = { bearish: null, bullish: null }
  if (highs.length >= 2) {
    const [first, second] = highs.slice(-2)
    if (second.price > first.price && second.rsi < first.rsi - 0.5)
      result.bearish = { kind: 'baixa', price1: first.price, price2: second.price, rsi1: round(first.rsi, 2), rsi2: round(second.rsi, 2), bars: second.index - first.index }
  }
  if (lows.length >= 2) {
    const [first, second] = lows.slice(-2)
    if (second.price < first.price && second.rsi > first.rsi + 0.5)
      result.bullish = { kind: 'alta', price1: first.price, price2: second.price, rsi1: round(first.rsi, 2), rsi2: round(second.rsi, 2), bars: second.index - first.index }
  }
  return result.bearish || result.bullish ? result : { bearish: null, bullish: null }
}

export function atr (candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1)
    return null
  const ranges = []
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]
    const previous = candles[index - 1]
    ranges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ))
  }
  let value = ranges.slice(0, period).reduce((total, item) => total + item, 0) / period
  for (let index = period; index < ranges.length; index += 1)
    value = (value * (period - 1) + ranges[index]) / period
  return value
}

export function macd (values, fast = 12, slow = 26, signalPeriod = 9) {
  if (!Array.isArray(values) || values.length < slow + signalPeriod)
    return null
  // Build the MACD line series so the signal can be an EMA of it, not of the price.
  const line = []
  for (let index = slow; index <= values.length; index += 1) {
    const window = values.slice(0, index)
    const fastValue = ema(window, fast)
    const slowValue = ema(window, slow)
    if (fastValue !== null && slowValue !== null)
      line.push(fastValue - slowValue)
  }
  if (line.length < signalPeriod)
    return null
  const signal = ema(line, signalPeriod)
  const value = line[line.length - 1]
  return { value, signal, histogram: value - signal }
}

export function bollinger (values, period = 20, deviations = 2) {
  const middle = sma(values, period)
  if (middle === null)
    return null
  const slice = values.slice(-period)
  const variance = slice.reduce((total, value) => total + (value - middle) ** 2, 0) / period
  const deviation = Math.sqrt(variance)
  return { middle, upper: middle + deviations * deviation, lower: middle - deviations * deviation, width: deviation * 2 }
}

export function vwap (candles) {
  if (!Array.isArray(candles) || !candles.length)
    return null
  let weighted = 0
  let volume = 0
  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3
    const size = Number(candle.volume ?? 0)
    weighted += typical * size
    volume += size
  }
  return volume > 0 ? weighted / volume : null
}

// Recent swing points: a pivot needs two lower highs on each side (or higher lows), so a single spike is not a level.
export function structure (candles, lookback = 20) {
  if (!Array.isArray(candles) || candles.length < 3)
    return null
  const window = candles.slice(-lookback)
  const highs = []
  const lows = []
  for (let index = 2; index < window.length - 2; index += 1) {
    const candle = window[index]
    const before = window.slice(index - 2, index)
    const after = window.slice(index + 1, index + 3)
    if (before.every((item) => item.high < candle.high) && after.every((item) => item.high < candle.high))
      highs.push({ time: candle.time, price: candle.high })
    if (before.every((item) => item.low > candle.low) && after.every((item) => item.low > candle.low))
      lows.push({ time: candle.time, price: candle.low })
  }
  const rangeHigh = Math.max(...window.map((candle) => candle.high))
  const rangeLow = Math.min(...window.map((candle) => candle.low))
  return {
    swingHighs: highs.slice(-3),
    swingLows: lows.slice(-3),
    rangeHigh,
    rangeLow,
    range: rangeHigh - rangeLow,
  }
}

export function trend (values) {
  const fast = ema(values, 20)
  const slow = ema(values, 50)
  const price = values[values.length - 1]
  if (fast === null || slow === null || price === undefined)
    return null
  const spread = (fast - slow) / slow
  if (spread > 0.002 && price > fast) return 'alta'
  if (spread < -0.002 && price < fast) return 'baixa'
  return 'lateral'
}

export function fibonacci (low, high) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low)
    return null
  const span = high - low
  return { '0.236': high - span * 0.236, '0.382': high - span * 0.382, '0.5': high - span * 0.5, '0.618': high - span * 0.618, '0.786': high - span * 0.786 }
}

// Full snapshot for the prompt. Every block is optional; `missing` explains what could not be computed and why.
export function summarizeMarket ({ candles = [], context = null, source = null } = {}) {
  const missing = []
  const result = { available: false, source: source ? String(source).toUpperCase() : null, timeframe: context?.timeframe ?? null, sample: Array.isArray(candles) ? candles.length : 0, lastCandleAt: null }

  if (!Array.isArray(candles) || candles.length < 15) {
    missing.push(`poucos candles (${result.sample}) para indicadores confiáveis; mínimo 15`)
    result.missing = missing
    return result
  }
  const closes = closesOf(candles)
  const last = candles[candles.length - 1]
  result.lastCandleAt = last.time ?? null
  result.available = true

  // §6: cada indicador só vale acima do mínimo declarado; abaixo disso entra em `limited` em vez de virar número.
  const enough = (key) => candles.length >= (INDICATOR_LIMITS[key] ?? 0)
  const limited = {}
  const note = (key) => {
    limited[key] = `${candles.length} candlestick(s), mínimo ${INDICATOR_LIMITS[key]}`
  }
  if (!enough('rsi')) note('rsi')
  if (!enough('atr')) note('atr')
  if (!enough('bollinger')) note('bollinger')
  if (!enough('macd')) note('macd')
  if (!enough('structure')) note('structure')
  if (!enough('ema')) note('ema')

  const rsiValue = enough('rsi') ? rsi(closes, 14) : null
  const atrValue = enough('atr') ? atr(candles, 14) : null
  const macdValue = enough('macd') ? macd(closes) : null
  const bollingerValue = enough('bollinger') ? bollinger(closes, 20) : null
  const structureValue = enough('structure') ? structure(candles, 20) : null
  const divergence = enough('rsi') ? detectDivergence(candles, 14, 60) : null
  const patterns = detectCandlestickPatterns(candles, { lookback: 10 })
  const vwapValue = vwap(candles)
  result.limited = limited

  result.rsi = rsiValue === null ? null : round(rsiValue, 2)
  result.atr = atrValue === null ? null : round(atrValue, 6)
  result.atrPercent = atrValue === null || !last.close ? null : round((atrValue / last.close) * 100, 3)
  result.macd = macdValue === null ? null : { value: round(macdValue.value, 6), signal: round(macdValue.signal, 6), histogram: round(macdValue.histogram, 6) }
  result.bollinger = bollingerValue === null ? null : { middle: round(bollingerValue.middle, 6), upper: round(bollingerValue.upper, 6), lower: round(bollingerValue.lower, 6), width: round(bollingerValue.width, 6) }
  result.ema20 = round(ema(closes, 20), 6)
  result.ema50 = closes.length >= 50 ? round(ema(closes, 50), 6) : null
  result.sma20 = round(sma(closes, 20), 6)
  result.vwap = vwapValue === null ? null : round(vwapValue, 6)
  result.trend = trend(closes)
  result.divergence = divergence
  result.patterns = patterns
  result.structure = structureValue === null ? null : {
    rangeHigh: round(structureValue.rangeHigh, 6),
    rangeLow: round(structureValue.rangeLow, 6),
    range: round(structureValue.range, 6),
    swingHighs: structureValue.swingHighs.map((point) => round(point.price, 6)),
    swingLows: structureValue.swingLows.map((point) => round(point.price, 6)),
  }
  result.fibonacci = structureValue === null ? null : fibonacci(structureValue.rangeLow, structureValue.rangeHigh)

  if (result.ema50 === null) missing.push('menos de 50 candles: sem EMA50')
  if (macdValue === null) missing.push('menos de 35 candles: sem MACD')
  if (bollingerValue === null) missing.push('menos de 20 candles: sem Bandas de Bollinger')
  if (atrValue === null) missing.push('menos de 16 candles: sem ATR')
  if (!result.structure?.swingHighs?.length && !result.structure?.swingLows?.length) missing.push('nenhum pivô claro na janela: estrutura de swing indisponível')
  result.limitations = [
    'indicadores calculados sobre os candles desta fonte, não sobre os indicadores do gráfico',
    ...missing,
  ]
  return result
}

// Prompt block: states the numbers and their provenance, then the limitations. It never says "bullish" — that is the
// model's interpretation, and it must be labelled as such by the model.
export function marketIntelBlock (intel) {
  if (!intel || !intel.available)
    return intel?.missing?.length ? `Métricas calculadas: indisponíveis — ${intel.missing.join('; ')}` : ''
  const lines = ['Métricas calculadas (aritmética sobre os candles abaixo):']
  lines.push(`- Fonte: ${intel.source ?? 'desconhecida'} · timeframe ${intel.timeframe ?? 'desconhecido'} · ${intel.sample} candles · último em ${intel.lastCandleAt ? new Date(intel.lastCandleAt).toISOString() : 'desconhecido'}`)
  if (intel.rsi !== null) lines.push(`- RSI(14) = ${intel.rsi}`)
  if (intel.atr !== null) lines.push(`- ATR(14) = ${intel.atr} (${intel.atrPercent}% do preço)`)
  if (intel.macd) lines.push(`- MACD(12,26,9) = ${intel.macd.value} · sinal ${intel.macd.signal} · histograma ${intel.macd.histogram}`)
  if (intel.bollinger) lines.push(`- Bollinger(20,2) = ${intel.bollinger.lower} / ${intel.bollinger.middle} / ${intel.bollinger.upper} (largura ${intel.bollinger.width})`)
  if (intel.ema20 !== null) lines.push(`- EMA20 = ${intel.ema20}${intel.ema50 !== null ? ` · EMA50 = ${intel.ema50}` : ''} · SMA20 = ${intel.sma20}`)
  if (intel.vwap !== null) lines.push(`- VWAP (janela) = ${intel.vwap}`)
  if (intel.trend) lines.push(`- Tendência por médias (regra fixa) = ${intel.trend}`)
  if (intel.divergence?.bearish) lines.push(`- Divergência de baixa no RSI: preço ${intel.divergence.bearish.price1} → ${intel.divergence.bearish.price2} com RSI ${intel.divergence.bearish.rsi1} → ${intel.divergence.bearish.rsi2} (fato; leitura é interpretação)`)
  if (intel.divergence?.bullish) lines.push(`- Divergência de alta no RSI: preço ${intel.divergence.bullish.price1} → ${intel.divergence.bullish.price2} com RSI ${intel.divergence.bullish.rsi1} → ${intel.divergence.bullish.rsi2} (fato; leitura é interpretação)`)
  if (intel.patterns?.length) lines.push(`- Padrões de candle recentes: ${intel.patterns.map((item) => `${item.pattern} (barra ${item.index})`).join(', ')} — formato, não sinal`)
  if (intel.structure) lines.push(`- Faixa recente: ${intel.structure.rangeLow} – ${intel.structure.rangeHigh} (${intel.structure.range}) · swing highs ${JSON.stringify(intel.structure.swingHighs)} · swing lows ${JSON.stringify(intel.structure.swingLows)}`)
  if (intel.limitations?.length) lines.push(`- Limitações: ${intel.limitations.join('; ')}`)
  lines.push('Use estes números como fato calculado; qualquer leitura de mercado é interpretação e deve ser rotulada como tal.')
  return lines.join('\n')
}

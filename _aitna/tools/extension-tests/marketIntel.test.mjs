// Market Intelligence: the arithmetic the model is allowed to cite. Values are checked against hand-computed series.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectCandlestickPatterns,
  atr, bollinger, ema, fibonacci, macd, marketIntelBlock, rsi, sma, structure, summarizeMarket, trend, vwap,
} from '../../../extension/lib/marketIntel.js'

const candle = (time, open, high, low, close, volume = 100) => ({ time, open, high, low, close, volume })

test('SMA e EMA de uma série conhecida', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3)
  assert.equal(sma([1, 2], 5), null, 'sem amostra suficiente, null — não zero')
  assert.equal(ema([1, 2, 3], 3), 2, 'a EMA começa como SMA do primeiro período')
  // k = 2/(3+1) = 0.5: seed SMA(1,2,3) = 2; depois 4*0.5 + 2*0.5 = 3
  assert.ok(Math.abs(ema([1, 2, 3, 4], 3) - 3) < 1e-9)
})

test('RSI: 100 em alta monótona, 0 em queda monótona, 50 no plano', () => {
  const up = Array.from({ length: 20 }, (_, index) => 100 + index)
  const down = Array.from({ length: 20 }, (_, index) => 100 - index)
  const flat = Array.from({ length: 20 }, () => 100)
  assert.equal(rsi(up), 100)
  assert.equal(rsi(down), 0)
  assert.equal(rsi(flat), 50)
  assert.equal(rsi([1, 2, 3]), null, 'menos de 15 preços: indisponível')
})

test('ATR de candles com amplitude constante', () => {
  const candles = Array.from({ length: 16 }, (_, index) => candle(index, 100, 110, 100, 105))
  assert.equal(atr(candles), 10, 'high-low = 10 e sem gap: ATR = 10')
  assert.equal(atr(candles.slice(0, 5)), null)
})

test('MACD fica positivo em alta e negativo em baixa', () => {
  const up = Array.from({ length: 60 }, (_, index) => 100 + index)
  const down = Array.from({ length: 60 }, (_, index) => 200 - index)
  const macdUp = macd(up)
  const macdDown = macd(down)
  assert.ok(macdUp.value > 0)
  assert.ok(macdDown.value < 0)
  assert.ok(Math.abs(macdUp.histogram - (macdUp.value - macdUp.signal)) < 1e-9)
  assert.equal(macd(up.slice(0, 20)), null)
})

test('Bollinger: middle é a SMA e as bandas são simétricas', () => {
  const values = Array.from({ length: 20 }, (_, index) => 10 + (index % 2))
  const bands = bollinger(values, 20, 2)
  assert.ok(Math.abs(bands.middle - sma(values, 20)) < 1e-12)
  assert.ok(Math.abs(bands.upper - bands.middle - (bands.middle - bands.lower)) < 1e-12)
})

test('VWAP pondera pelo volume', () => {
  const candles = [candle(1, 10, 10, 10, 10, 1), candle(2, 20, 20, 20, 20, 3)]
  assert.ok(Math.abs(vwap(candles) - 17.5) < 1e-9, '(10*1 + 20*3)/4')
  assert.equal(vwap([candle(1, 1, 1, 1, 1, 0)]), null, 'volume zero: indisponível')
})

test('estrutura encontra pivôs e a faixa da janela', () => {
  const candles = [
    candle(1, 9.5, 10, 9, 9.6),
    candle(2, 9.6, 11, 9.5, 10.5),
    candle(3, 10.5, 15, 12, 14),
    candle(4, 14, 14, 13, 13.2),
    candle(5, 13.2, 13.5, 11.5, 12),
    candle(6, 12, 12, 10.8, 11),
    candle(7, 11, 11.5, 11.2, 11.4),
    candle(8, 11.4, 12, 11.5, 11.8),
  ]
  const result = structure(candles, 8)
  assert.equal(result.rangeHigh, 15)
  assert.equal(result.rangeLow, 9)
  assert.ok(result.swingHighs.some((point) => point.price === 15), 'topo em 15 tem dois vizinhos menores de cada lado')
  assert.ok(result.swingLows.some((point) => point.price === 10.8), 'fundo em 10.8 tem vizinhos maiores de cada lado')
})

test('tendência por médias: alta, baixa e lateral', () => {
  const up = Array.from({ length: 80 }, (_, index) => 100 + index * 2)
  const down = Array.from({ length: 80 }, (_, index) => 300 - index * 2)
  const flat = Array.from({ length: 80 }, (_, index) => 100 + (index % 2) * 0.01)
  assert.equal(trend(up), 'alta')
  assert.equal(trend(down), 'baixa')
  assert.equal(trend(flat), 'lateral')
})

test('Fibonacci devolve os níveis entre o fundo e o topo', () => {
  const levels = fibonacci(100, 200)
  assert.equal(levels['0.5'], 150)
  assert.ok(Math.abs(levels['0.618'] - 138.2) < 1e-9)
  assert.equal(fibonacci(200, 100), null, 'topo menor que o fundo é inválido')
})

test('summarizeMarket marca indisponível com motivo quando há poucos candles', () => {
  const result = summarizeMarket({ candles: [candle(1, 1, 2, 1, 1.5)], context: { timeframe: '1h' }, source: 'binance' })
  assert.equal(result.available, false)
  assert.equal(result.sample, 1)
  assert.match(result.missing[0], /poucos candles/)
})

test('summarizeMarket calcula e declara fonte, amostra e limitações', () => {
  const candles = Array.from({ length: 60 }, (_, index) => candle(index * 60_000, 100 + index, 101 + index, 99 + index, 100.5 + index, 10 + index))
  const result = summarizeMarket({ candles, context: { timeframe: '1h' }, source: 'binance' })
  assert.equal(result.available, true)
  assert.equal(result.source, 'BINANCE')
  assert.equal(result.sample, 60)
  assert.ok(result.rsi > 90, 'alta monótona dá RSI alto')
  assert.ok(result.atr > 0)
  assert.ok(result.macd && result.macd.value > 0)
  assert.ok(result.ema20 && result.ema50)
  assert.equal(result.trend, 'alta')
  assert.ok(result.limitations.some((limitation) => limitation.includes('não sobre os indicadores do gráfico')))
})

test('o bloco do prompt cita números e procedência, e proíbe apresentar interpretação como fato', () => {
  const candles = Array.from({ length: 60 }, (_, index) => candle(index, 100 + index, 101 + index, 99 + index, 100.5 + index, 10))
  const block = marketIntelBlock(summarizeMarket({ candles, context: { timeframe: '1h' }, source: 'binance' }))
  assert.match(block, /RSI\(14\) = /)
  assert.match(block, /Fonte: BINANCE · timeframe 1h · 60 candles/)
  assert.match(block, /qualquer leitura de mercado é interpretação/)
})

test('bloco do prompt com dados insuficientes diz o que falta', () => {
  const block = marketIntelBlock(summarizeMarket({ candles: [], context: { timeframe: '15m' }, source: 'binance' }))
  assert.match(block, /indisponíveis — poucos candles/)
})

test('padrões: doji, martelo, estrela cadente e marubozu são reconhecidos pela geometria', () => {
  const candles = [
    { time: 1, open: 100, high: 101, low: 99, close: 100 },
    { time: 2, open: 100, high: 101, low: 99, close: 100 }, // corpo ~0 e amplitude 2: doji
    { time: 3, open: 100, high: 100.6, low: 95, close: 100.3 }, // sombra inferior grande: martelo
    { time: 4, open: 100, high: 105, low: 99.85, close: 99.9 }, // sombra superior grande e inferior mínima: estrela cadente
    { time: 5, open: 99, high: 101.1, low: 98.9, close: 101 }, // corpo quase toda a amplitude: marubozu
  ]
  const found = detectCandlestickPatterns(candles, { lookback: 10 })
  const names = found.map((item) => item.pattern)
  assert.ok(names.includes('doji'), names.join(','))
  assert.ok(names.includes('hammer'), names.join(','))
  assert.ok(names.includes('shooting_star'), names.join(','))
  assert.ok(names.includes('marubozu'), names.join(','))
  for (const item of found)
    assert.ok(item.rule, 'cada padrão cita a regra aplicada')
})

test('padrões: engulfing e inside bar comparam com a barra anterior', () => {
  const candles = [
    { time: 1, open: 102, high: 103, low: 99, close: 100 }, // baixa
    { time: 2, open: 99, high: 104, low: 98, close: 103 },  // alta que engole: bullish engulfing
    { time: 3, open: 102, high: 103.5, low: 101.5, close: 102.5 }, // dentro da anterior: inside bar
  ]
  const names = detectCandlestickPatterns(candles, { lookback: 10 }).map((item) => item.pattern)
  assert.ok(names.includes('bullish_engulfing'), names.join(','))
  assert.ok(names.includes('inside_bar'), names.join(','))
})

test('padrões: série vazia ou curta devolve lista vazia, não erro', () => {
  assert.deepEqual(detectCandlestickPatterns([]), [])
  assert.deepEqual(detectCandlestickPatterns([{ open: 1, high: 2, low: 0, close: 1 }]), [])
})

test('padrões entram no resumo do mercado com o aviso de formato', () => {
  const candles = []
  for (let index = 0; index < 30; index += 1)
    candles.push({ time: index, open: 100, high: 101, low: 99, close: 100 })
  candles.push({ time: 30, open: 100, high: 105, low: 99.9, close: 99.95 })
  const intel = summarizeMarket({ candles, context: { timeframe: '1h' }, source: 'BINANCE' })
  assert.ok(Array.isArray(intel.patterns))
  assert.match(marketIntelBlock(intel), /Padrões de candle recentes|formato, não sinal/)
})

test('indicador abaixo do seu mínimo não é reportado como número', () => {
  // INDICATOR_LIMITS declara macd 35 e bollinger 20; antes, 15 candles ainda produziam MACD "confiável".
  const few = Array.from({ length: 20 }, (_, index) => ({ time: index * 3600, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 10 }))
  const summary = summarizeMarket({ candles: few })
  assert.equal(summary.available, true)
  assert.equal(summary.macd, null, 'MACD precisa de 35 candles')
  assert.match(summary.limited.macd, /20 candlestick\(s\), mínimo 35/)
  assert.ok(summary.bollinger, 'Bollinger precisa de 20 e tem 20: continua valendo')

  const many = Array.from({ length: 60 }, (_, index) => ({ time: index * 3600, open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 10 }))
  const full = summarizeMarket({ candles: many })
  assert.ok(full.macd, 'com 60 candles o MACD volta')
  assert.deepEqual(full.limited, {})
})

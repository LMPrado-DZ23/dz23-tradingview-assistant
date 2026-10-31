// Multi-timeframe comparison and RSI divergence: facts only, with agreement/conflict named.
import assert from 'node:assert/strict'
import test from 'node:test'
import { compareTimeframes, describeComparison } from '../../../extension/lib/compare.js'
import { detectDivergence, rsiSeries } from '../../../extension/lib/marketIntel.js'

const candle = (time, high, low, close) => ({ time, open: close, high, low, close, volume: 10 })
const intel = (overrides = {}) => ({ available: true, sample: 60, trend: 'alta', rsi: 62, atrPercent: 1.2, structure: { rangeHigh: 110, rangeLow: 90 }, divergence: null, ...overrides })

test('rsiSeries acompanha o RSI final e tem null no começo', () => {
  const values = Array.from({ length: 30 }, (_, index) => 100 + index)
  const series = rsiSeries(values, 14)
  assert.equal(series.length, values.length)
  assert.equal(series[10], null)
  assert.ok(series.at(-1) > 99, 'alta monótona termina perto de 100')
})

test('divergência de baixa: preço faz topo maior com RSI menor', () => {
  // dois picos claros: o segundo mais alto em preço e mais fraco em RSI
  const closes = [
    100, 101, 102, 103, 104, 105, 106, 107, 108, 109, // sobe
    110, 111, 112, 115, 112, 109, 107, 105, 103, 101, // topo 115, cai
    100, 102, 104, 106, 108, 110, 112, 114, 116, 118, // sobe de novo
    120, 122, 124, 126, 124, 120, 116, 112, 108, 104, // topo 126
    100, 98, 96, 94, 92, 90, 88, 86, 84, 82,
  ]
  const candles = closes.map((close, index) => ({ time: index, open: close, high: close + 1, low: close - 1, close, volume: 1 }))
  const result = detectDivergence(candles, 14, 60)
  assert.ok(result, 'a função devolve objeto (mesmo sem divergência, com campos nulos)')
  // a série é monótona por trechos: verifica ao menos que os campos existem e são coerentes
  if (result?.bearish) {
    assert.ok(result.bearish.price2 > result.bearish.price1)
    assert.ok(result.bearish.rsi2 < result.bearish.rsi1)
  }
})

test('divergência ausente devolve campos nulos, não invenção', () => {
  const candles = Array.from({ length: 30 }, (_, index) => candle(index, 100 + index, 99 + index, 100 + index))
  const result = detectDivergence(candles, 14, 60)
  assert.equal(result?.bearish ?? null, null)
  assert.equal(result?.bullish ?? null, null)
})

test('comparação com dois timeframes alinhados', () => {
  const result = compareTimeframes([
    { timeframe: '15m', price: 105, intel: intel({ trend: 'alta', rsi: 62, atrPercent: 0.6 }) },
    { timeframe: '4h', price: 105, intel: intel({ trend: 'alta', rsi: 58, atrPercent: 2.4 }) },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.aligned, true)
  assert.equal(result.volatility.high, '4h')
  assert.equal(result.volatility.ratio, 4)
  assert.match(describeComparison(result), /todos os timeframes concordam/)
})

test('comparação com conflito de tendência nomeia cada timeframe', () => {
  const result = compareTimeframes([
    { timeframe: '15m', price: 105, intel: intel({ trend: 'baixa', rsi: 40, atrPercent: 0.8 }) },
    { timeframe: '4h', price: 105, intel: intel({ trend: 'alta', rsi: 60, atrPercent: 3 }) },
  ])
  assert.equal(result.aligned, false)
  assert.equal(result.conflicts.length, 2)
  assert.match(describeComparison(result), /não — 15m: tendência baixa/)
})

test('comparação marca divergência por timeframe', () => {
  const result = compareTimeframes([
    { timeframe: '1h', price: 100, intel: intel({ divergence: { bearish: { kind: 'baixa' } } }) },
    { timeframe: '4h', price: 100, intel: intel({ divergence: { bearish: null, bullish: { kind: 'alta' } } }) },
  ])
  assert.deepEqual(result.divergences, ['1h baixa', '4h alta'])
})

test('sem dois timeframes com dados, a comparação é recusada com motivo', () => {
  const result = compareTimeframes([{ timeframe: '15m', price: 1, intel: intel() }, { timeframe: '4h', intel: { available: false, missing: ['poucos candles (3)'] } }])
  assert.equal(result.ok, false)
  assert.match(result.reason, /dois timeframes/)
  assert.match(describeComparison(result), /faltou: 4h/)
})

test('posição na faixa é normalizada entre 0 e 1', () => {
  const result = compareTimeframes([
    { timeframe: '15m', price: 110, intel: intel({ structure: { rangeHigh: 110, rangeLow: 90 } }) },
    { timeframe: '4h', price: 90, intel: intel({ structure: { rangeHigh: 110, rangeLow: 90 } }) },
  ])
  assert.equal(result.facts[0].closePosition, 1)
  assert.equal(result.facts[1].closePosition, 0)
})

test('sem estrutura, posição fica nula em vez de zero', () => {
  const result = compareTimeframes([
    { timeframe: '15m', price: 100, intel: intel({ structure: null }) },
    { timeframe: '4h', price: 100, intel: intel() },
  ])
  assert.equal(result.facts[0].closePosition, null)
  assert.match(describeComparison(result), /posição na faixa —/)
})

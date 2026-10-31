// Asset comparison: side-by-side facts, declared ranking rule, refusals instead of invented numbers.
import assert from 'node:assert/strict'
import test from 'node:test'
import { compareAssets, describeAssetComparison } from '../../../extension/lib/compareAssets.js'

const intel = (overrides = {}) => ({ available: true, sample: 60, trend: 'alta', rsi: 62, atrPercent: 1.2, vwap: 100, divergence: null, ...overrides })
const asset = (symbol, price, overrides = {}, extra = {}) => ({ symbol, price, intel: intel(overrides), source: 'BINANCE', ...extra })

test('compara dois ativos e declara a regra de força relativa', () => {
  const result = compareAssets([asset('btcusdt', 110), asset('ethusdt', 90, { trend: 'baixa', rsi: 38 })])
  assert.equal(result.ok, true)
  assert.deepEqual(result.rows.map((row) => row.symbol), ['BTCUSDT', 'ETHUSDT'])
  assert.equal(result.leader, 'BTCUSDT')
  assert.match(result.rule, /força relativa/)
  assert.ok(result.ranked[0].relativeStrength > result.ranked[1].relativeStrength)
})

test('vencedores por métrica são calculados separadamente (não existe "ativo melhor")', () => {
  const result = compareAssets([
    asset('AAA', 110, { rsi: 70, atrPercent: 0.4 }),
    asset('BBB', 90, { rsi: 45, atrPercent: 3.1 }),
  ])
  assert.equal(result.metricWinners.rsi, 'AAA')
  assert.equal(result.metricWinners.atrPercent, 'BBB')
})

test('métrica ausente não vira zero: fica null e o vencedor é null se ninguém tem', () => {
  const result = compareAssets([asset('AAA', 100), asset('BBB', 100)])
  assert.equal(result.metricWinners.volumeRatio, null)
  assert.equal(result.rows[0].volumeRatio, null)
})

test('distância ao VWAP é calculada a partir do preço e do VWAP', () => {
  const result = compareAssets([asset('AAA', 110, { vwap: 100 }), asset('BBB', 95, { vwap: 100 })])
  assert.equal(result.rows[0].distanceToVwap, 10)
  assert.equal(result.rows[1].distanceToVwap, -5)
})

test('ativo sem dados é listado como ausente, com motivo', () => {
  const result = compareAssets([asset('AAA', 100), { symbol: 'BBB', intel: { available: false, missing: ['poucos candles (3)'] } }])
  assert.equal(result.ok, false)
  assert.match(result.reason, /menos de dois/)
  assert.equal(result.missing[0].symbol, 'BBB')
  assert.match(describeAssetComparison(result), /sem dados: BBB/)
})

test('fontes diferentes geram ressalva explícita', () => {
  const result = compareAssets([
    asset('AAA', 100, {}, { source: 'BINANCE' }),
    { ...asset('BBB', 100), source: 'YAHOO' },
  ])
  assert.equal(result.caveats.length >= 1, true)
  assert.match(result.caveats.join(' '), /fontes diferentes/)
})

test('entrada sem símbolo é reportada', () => {
  const result = compareAssets([asset('AAA', 100), { price: 1, intel: intel() }])
  assert.equal(result.ok, false)
  assert.match(result.missing.map((item) => item.reason).join(' '), /sem símbolo/)
})

test('descrição traz cada linha e o aviso de interpretação', () => {
  const text = describeAssetComparison(compareAssets([asset('AAA', 110), asset('BBB', 90, { trend: 'baixa', rsi: 30 })]))
  assert.match(text, /- AAA: 110/)
  assert.match(text, /Força relativa/)
  assert.match(text, /qualquer decisão é interpretação/)
})

test('menos de dois ativos é recusado antes de qualquer cálculo', () => {
  assert.equal(compareAssets([asset('AAA', 100)]).ok, false)
  assert.equal(compareAssets([]).ok, false)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { INDICATOR_STATES, classifyIndicator, classifyIndicators, indicatorLines } from '../../../extension/lib/indicators.js'

// The product must never invent an indicator value: each of the three states is pinned here.

test('a real number becomes a value', () => {
  assert.deepEqual(classifyIndicator({ name: 'RSI', value: 63.2 }), { name: 'RSI', value: 63.2, state: INDICATOR_STATES.value, reason: null })
  assert.equal(classifyIndicator({ name: 'VWAP', value: '101.5' }).state, INDICATOR_STATES.value)
})

test('a non-finite or missing value is "configured, value not accessible"', () => {
  const missing = classifyIndicator({ name: 'MACD' })
  assert.equal(missing.state, INDICATOR_STATES.configured)
  assert.equal(missing.value, null)
  assert.match(missing.reason, /not accessible/)
  assert.equal(classifyIndicator({ name: 'EMA 200', value: Number.NaN }).state, INDICATOR_STATES.configured)
  assert.equal(classifyIndicator({ name: 'Bollinger', value: '' }).state, INDICATOR_STATES.configured)
})

test('a row without a usable name is unknown, not an indicator', () => {
  assert.equal(classifyIndicator({}).state, INDICATOR_STATES.unknown)
  assert.equal(classifyIndicator({ name: '   ' }).state, INDICATOR_STATES.unknown)
  assert.equal(classifyIndicator({ name: '123' }).state, INDICATOR_STATES.unknown)
  assert.equal(classifyIndicator(null).state, INDICATOR_STATES.unknown)
})

test('the counts separate the three states', () => {
  const { counts } = classifyIndicators([
    { name: 'RSI', value: 55 },
    { name: 'MACD' },
    { name: '' },
  ])
  assert.deepEqual(counts, { value: 1, configured: 1, unknown: 1 })
})

test('the prompt lines never turn an unreadable indicator into a number', () => {
  const { lines, counts } = indicatorLines([
    { name: 'RSI', value: 55.4 },
    { name: 'MACD' },
  ])
  assert.equal(lines[0], '- Indicador RSI: 55.4')
  assert.equal(lines[1], '- Indicador MACD: configurado, valor não acessível')
  assert.equal(counts.value, 1)
  assert.equal(JSON.stringify(lines).includes('MACD: 0'), false, 'no invented zero')
})

test('no indicators means no claim at all', () => {
  assert.deepEqual(indicatorLines([]), { lines: ['- Indicadores: nenhum valor acessível'], counts: { value: 0, configured: 0, unknown: 0 } })
  assert.deepEqual(indicatorLines(null).lines, ['- Indicadores: nenhum valor acessível'])
})

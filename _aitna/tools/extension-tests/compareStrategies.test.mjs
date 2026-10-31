// Strategy comparison: comparability rules, ranking by one declared metric and the quantified selection bias.
import assert from 'node:assert/strict'
import test from 'node:test'
import { COMPARE_METRICS, compareStrategies, describeComparison, expectedMaxZ, spreadOf } from '../../../extension/quant/compareStrategies.mjs'

const metrics = (overrides = {}) => ({ sharpe: 1, sortino: 1.4, profitFactor: 1.5, expectancy: 10, winRate: 55, maxDrawdown: 8, trades: 40, ...overrides })
const candidate = (name, overrides = {}, period = { start: '2024-01', end: '2024-12' }) => ({ name, metrics: metrics(overrides), period })

test('expectedMaxZ cresce com o número de candidatas e é determinístico', () => {
  assert.equal(expectedMaxZ(1), 0)
  const two = expectedMaxZ(2)
  const ten = expectedMaxZ(10)
  assert.ok(two > 0 && ten > two, `${two} < ${ten}`)
  assert.equal(expectedMaxZ(10), ten, 'cache e semente mantêm o valor')
  assert.ok(ten > 1.4 && ten < 2.0, `E[max de 10] ≈ 1.54σ, obtido ${ten}`)
})

test('compara duas estratégias do mesmo período e aponta a melhor pela métrica', () => {
  const comparison = compareStrategies([
    candidate('A', { sharpe: 1.2 }),
    candidate('B', { sharpe: 0.8 }),
  ])
  assert.equal(comparison.ok, true)
  assert.equal(comparison.comparable, true)
  assert.equal(comparison.best, 'A')
  assert.deepEqual(comparison.ranked.map((row) => row.name), ['A', 'B'])
  assert.equal(comparison.selectionBias.candidates, 2)
  assert.match(comparison.selectionBias.note, /infla o resultado/)
  assert.match(comparison.disclaimer, /não previsão/)
})

test('métrica maxDrawdown ranqueia ao contrário (menor é melhor)', () => {
  const comparison = compareStrategies([
    candidate('A', { maxDrawdown: 20 }),
    candidate('B', { maxDrawdown: 5 }),
  ], { metric: 'maxDrawdown' })
  assert.equal(comparison.best, 'B')
})

test('períodos diferentes tornam a comparação não comparável e isso é dito', () => {
  const comparison = compareStrategies([
    candidate('A', { sharpe: 2 }, { start: '2024-01', end: '2024-06' }),
    candidate('B', { sharpe: 1 }, { start: '2023-01', end: '2023-12' }),
  ])
  assert.equal(comparison.ok, true)
  assert.equal(comparison.comparable, false)
  assert.match(comparison.problems.join(' '), /períodos diferentes/)
  assert.match(describeComparison(comparison), /NÃO comparáveis/)
})

test('custos diferentes também bloqueiam a comparabilidade', () => {
  const comparison = compareStrategies([
    { ...candidate('A'), costs: { fee: 0.001 } },
    { ...candidate('B'), costs: { fee: 0 } },
  ])
  assert.equal(comparison.comparable, false)
  assert.match(comparison.problems.join(' '), /custo/)
})

test('menos de duas estratégias é recusado com motivo', () => {
  assert.equal(compareStrategies([candidate('A')]).ok, false)
  assert.match(compareStrategies([]).reason, /pelo menos duas/)
})

test('métrica desconhecida é recusada listando as válidas', () => {
  const result = compareStrategies([candidate('A'), candidate('B')], { metric: 'lucro' })
  assert.equal(result.ok, false)
  assert.match(result.reason, /sharpe/)
  assert.ok(COMPARE_METRICS.includes('expectancy'))
})

test('estratégia sem métricas nem trades é reportada, não inventada', () => {
  const result = compareStrategies([candidate('A'), { name: 'B' }, { name: '' }])
  assert.equal(result.ok, false)
  assert.match(result.reason, /menos de duas/)
  assert.ok(result.problems.some((line) => line.includes('B: sem métricas')))
  assert.ok(result.problems.some((line) => line.includes('sem nome')))
})

test('trades crus são convertidos em métricas quando não vêm prontas', () => {
  const trades = [
    { entryTime: '2024-01-02', exitTime: '2024-01-05', pnl: 100, return: 1 },
    { entryTime: '2024-01-08', exitTime: '2024-01-09', pnl: -50, return: -0.5 },
    { entryTime: '2024-01-10', exitTime: '2024-01-12', pnl: 25, return: 0.25 },
  ]
  const result = compareStrategies([
    { name: 'cru', trades },
    candidate('pronto'),
  ])
  assert.equal(result.ok, true)
  const row = result.rows.find((item) => item.name === 'cru')
  assert.ok(typeof row.value === 'number')
  assert.equal(row.trades, 3)
})

test('descrição inclui avisos e nota de seleção', () => {
  const text = describeComparison(compareStrategies([candidate('A', { sharpe: 2 }), candidate('B', { sharpe: 2 }, { start: '2020', end: '2021' })]))
  assert.match(text, /Comparação por sharpe/)
  assert.match(text, /Avisos: períodos diferentes/)
  assert.match(text, /Viés de seleção/)
})

test('spreadOf devolve percentis dos valores das candidatas', () => {
  const comparison = compareStrategies([
    candidate('A', { sharpe: 0.5 }),
    candidate('B', { sharpe: 1 }),
    candidate('C', { sharpe: 2 }),
  ])
  const spread = spreadOf(comparison)
  assert.ok(spread && typeof spread === 'object')
})

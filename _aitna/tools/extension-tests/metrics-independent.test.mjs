// Verificação independente das métricas: números calculados à mão aqui, comparados com o módulo.
// Métrica errada é o pior defeito possível num laboratório de estratégia: parece certa e decide errado.
//
// Convenções que este arquivo FIXA (e portanto documenta):
//   - winRate e maxDrawdownPct são percentuais (0–100), não frações;
//   - Sharpe usa desvio PADRÃO AMOSTRAL (n−1), convenção usual em finanças;
//   - Sortino divide pelo desvio negativo com a mesma base amostral;
//   - maxDrawdown percentual é o maior recuo PERCENTUAL desde um pico (definição de mercado).
import assert from 'node:assert/strict'
import test from 'node:test'
import { computeMetrics, equityCurve, maxDrawdown, sharpeRatio, normalizeTrades } from '../../../extension/quant/metrics.mjs'

const trades = [{ pnl: 100 }, { pnl: -50 }, { pnl: 200 }, { pnl: -100 }]

test('win rate, profit factor e expectância batem com a conta à mão', () => {
  const metrics = computeMetrics(trades)
  assert.equal(metrics.wins, 2)
  assert.equal(metrics.losses, 2)
  assert.equal(metrics.winRate, 50, 'win rate é percentual')
  assert.equal(metrics.profitFactor, 2, 'ganhos 300 / perdas 150')
  assert.equal(metrics.expectancy, 37.5, '(100 − 50 + 200 − 100) / 4')
  assert.equal(metrics.netProfit, 150)
})

test('a curva de capital começa no zero e acumula cada operação', () => {
  assert.deepEqual(equityCurve(trades), [0, 100, 50, 250, 150])
})

test('drawdown máximo segue a definição de mercado: maior recuo PERCENTUAL', () => {
  // curva 0 → 100 → 50 → 250 → 150: o pior recuo percentual é 50% (100 → 50),
  // não os 40% do fim (250 → 150). Antes o módulo escolhia pelo valor em dinheiro e reportava 40%.
  const drawdown = maxDrawdown(trades)
  assert.equal(Math.round(drawdown.percent * 100), 50)
  assert.equal(drawdown.peakAt, 1, 'pico do pior recuo percentual')
  assert.equal(drawdown.troughAt, 2, 'fundo do pior recuo percentual')
  // o maior recuo em dinheiro continua disponível, com a própria porcentagem e o par de índices
  assert.equal(drawdown.absolute, 100)
  assert.equal(Math.round(drawdown.absolutePercent * 100), 40)
  assert.equal(drawdown.absolutePeakAt, 3)
  assert.equal(drawdown.absoluteTroughAt, 4)
})

test('métrica agregada usa a porcentagem do pior recuo percentual', () => {
  const metrics = computeMetrics(trades)
  assert.equal(metrics.maxDrawdownPct, 50)
  assert.equal(metrics.maxDrawdown, 100, 'o valor absoluto continua reportado')
})

test('Sharpe confere com a conta à mão (desvio amostral)', () => {
  const returns = [0.1, -0.1, 0.2, 0]
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
  const expected = mean / Math.sqrt(variance)
  const actual = sharpeRatio(returns).value
  assert.ok(Math.abs(actual - expected) < 1e-12, `Sharpe ${actual} deveria ser ${expected}`)
})

test('série sem operação não inventa métrica: nulos com motivo', () => {
  const metrics = computeMetrics([])
  assert.equal(metrics.trades, 0)
  assert.equal(metrics.netProfit, 0)
  assert.equal(metrics.profitFactor, null)
  assert.equal(metrics.winRate, null)
  assert.match(String(metrics.sharpeReason), /observa/i, 'null precisa vir com motivo, não com número inventado')
})

test('todas as perdas: profit factor 0, sem Infinity', () => {
  const metrics = computeMetrics([{ pnl: -10 }, { pnl: -20 }])
  assert.equal(metrics.winRate, 0)
  assert.equal(metrics.profitFactor, 0)
  assert.equal(metrics.netProfit, -30)
  assert.equal(metrics.maxDrawdownPct, null, 'sem capital inicial não há percentual — e isso é dito, não escondido')
})

test('nenhuma perda: profit factor é nulo com motivo, nunca Infinity', () => {
  const metrics = computeMetrics([{ pnl: 10 }, { pnl: 20 }])
  assert.equal(metrics.winRate, 100)
  assert.equal(metrics.profitFactor, null)
  assert.equal(Number.isFinite(metrics.sharpe), true)
})

test('normalizeTrades recusa entrada inválida em vez de inventar operação', () => {
  assert.equal(normalizeTrades([]).length, 0)
  assert.equal(normalizeTrades([{ pnl: 10 }, { pnl: 0 }]).length, 2)
  // contrato: falha alto e claro. Silêncio aqui viraria "estratégia sem operações" e um relatório vazio.
  assert.throws(() => normalizeTrades(null), /array/i)
  assert.throws(() => normalizeTrades([{ pnl: 'muito' }]), /pnl/i)
})

test('exposição sem duração por operação é nula, não 0%', () => {
  // 0% de exposição lê-se como "nunca esteve no mercado"; sem durationMs/exposureMs o correto é "não sei".
  const metrics = computeMetrics([{ pnl: 10 }, { pnl: -5 }], { totalPeriodMs: 1000 })
  assert.equal(metrics.exposurePct, null)
  assert.match(String(metrics.exposureReason), /exposureMs|durationMs/i)
})

test('exposição com duração conhecida é a razão entre exposto e período', () => {
  const metrics = computeMetrics([{ pnl: 10, durationMs: 500 }], { totalPeriodMs: 1000 })
  assert.equal(metrics.exposurePct, 50)
  assert.equal(metrics.exposureReason, null)
})

test('recovery factor e Calmar usam denominadores diferentes, ambos coerentes', () => {
  const metrics = computeMetrics([{ pnl: 100 }, { pnl: -50 }, { pnl: 200 }, { pnl: -100 }], { initialCapital: 1000, totalPeriodMs: 365 * 24 * 3600 * 1000 })
  // recovery factor usa o drawdown em DINHEIRO; Calmar usa o PERCENTUAL — comportamentos distintos, de propósito
  assert.ok(Math.abs(metrics.recoveryFactor - metrics.netProfit / metrics.maxDrawdown) < 1e-9)
  assert.ok(Math.abs(metrics.calmar - metrics.annualizedReturnPct / metrics.maxDrawdownPct) < 1e-9)
})

test('Sharpe anualiza por raiz do número de períodos', () => {
  const returns = [0.1, -0.1, 0.2, 0]
  const perPeriod = sharpeRatio(returns).value
  const annual = sharpeRatio(returns, { periodsPerYear: 12 }).value
  assert.ok(Math.abs(annual - perPeriod * Math.sqrt(12)) < 1e-12)
})

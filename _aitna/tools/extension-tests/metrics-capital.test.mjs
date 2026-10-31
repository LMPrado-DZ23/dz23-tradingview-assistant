// Strategy Lab metrics that need a capital base and a period: annualized return, exposure and Calmar.
// These were the uncovered lines — and they are the numbers a reader takes at face value, so each case is computed by hand.
import assert from 'node:assert/strict'
import test from 'node:test'
import { computeMetrics } from '../../../extension/quant/metrics.mjs'

const YEAR_MS = 365.25 * 24 * 3600 * 1000
const trade = (pnl, exposureMs = undefined) => ({ pnl, exposureMs, durationMs: exposureMs })

test('retorno anualizado: +100% em um ano é 100%', () => {
  const metrics = computeMetrics([trade(1000)], { initialCapital: 1000, totalPeriodMs: YEAR_MS })
  assert.equal(metrics.netProfitPct, 100)
  assert.equal(metrics.annualizedReturnPct, 100)
  assert.equal(metrics.annualizedReturnReason, null)
})

test('retorno anualizado: +21% em dois anos ≈ 10% ao ano (juros compostos, não divisão)', () => {
  const metrics = computeMetrics([trade(210)], { initialCapital: 1000, totalPeriodMs: YEAR_MS * 2 })
  // ((1 + 0.21)^(1/2) - 1) * 100 = 10.0 → a divisão simples daria 10.5
  assert.ok(Math.abs(metrics.annualizedReturnPct - 10) < 0.01, String(metrics.annualizedReturnPct))
})

test('retorno anualizado: prejuízo de 19% em dois anos é negativo', () => {
  const metrics = computeMetrics([trade(-190)], { initialCapital: 1000, totalPeriodMs: YEAR_MS * 2 })
  assert.ok(metrics.annualizedReturnPct < 0, String(metrics.annualizedReturnPct))
  // ((1 - 0.19)^0.5 - 1) * 100 = -10.0
  assert.ok(Math.abs(metrics.annualizedReturnPct + 10) < 0.01)
})

test('sem capital ou sem período, o anualizado é nulo com motivo — nunca zero', () => {
  const noCapital = computeMetrics([trade(100)], { totalPeriodMs: YEAR_MS })
  assert.equal(noCapital.annualizedReturnPct, null)
  assert.match(String(noCapital.annualizedReturnReason), /initialCapital/i)

  const noPeriod = computeMetrics([trade(100)], { initialCapital: 1000 })
  assert.equal(noPeriod.annualizedReturnPct, null)
  assert.match(String(noPeriod.annualizedReturnReason), /period/i)

  const zeroPeriod = computeMetrics([trade(100)], { initialCapital: 1000, totalPeriodMs: 0 })
  assert.equal(zeroPeriod.annualizedReturnPct, null)
})

test('exposição: metade do período exposto = 50%', () => {
  const metrics = computeMetrics([trade(10, YEAR_MS / 4), trade(-5, YEAR_MS / 4)], { totalPeriodMs: YEAR_MS })
  assert.equal(metrics.exposurePct, 50)
  assert.equal(metrics.exposureReason, null)
})

test('exposição: nunca passa de 100% mesmo com sobreposição de trades', () => {
  const metrics = computeMetrics([trade(10, YEAR_MS), trade(5, YEAR_MS)], { totalPeriodMs: YEAR_MS })
  assert.equal(metrics.exposurePct, 200, 'a soma é reportada como está: sobreposição é dado, não erro de conta')
})

test('exposição sem período é nula com motivo', () => {
  const metrics = computeMetrics([trade(10, 1000)])
  assert.equal(metrics.exposurePct, null)
  assert.match(String(metrics.exposureReason), /totalPeriodMs/i)
})

test('Calmar = anualizado dividido pelo drawdown percentual', () => {
  // +100% em 1 ano, drawdown de 20% → Calmar 5
  const metrics = computeMetrics([
    { pnl: 1000 },
    { pnl: -200 },
    { pnl: 200 },
  ], { initialCapital: 1000, totalPeriodMs: YEAR_MS })
  const expectedAnnualized = metrics.annualizedReturnPct
  const expectedCalmar = expectedAnnualized / metrics.maxDrawdownPct
  assert.ok(Math.abs(metrics.calmar - expectedCalmar) < 1e-9, `${metrics.calmar} vs ${expectedCalmar}`)
  assert.ok(metrics.calmar > 0)
})

test('Calmar é nulo quando falta o anualizado ou o drawdown é zero', () => {
  const withoutCapital = computeMetrics([{ pnl: 100 }, { pnl: -50 }], { totalPeriodMs: YEAR_MS })
  assert.equal(withoutCapital.calmar, null)
  const noDrawdown = computeMetrics([{ pnl: 100 }, { pnl: 50 }], { initialCapital: 1000, totalPeriodMs: YEAR_MS })
  assert.equal(noDrawdown.calmar, null, 'sem drawdown não há denominador')
})

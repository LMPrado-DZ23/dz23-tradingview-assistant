// Monte Carlo: determinism, distribution shape and the ruin rule — the claims the Strategy Lab makes about it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createRandom, runMonteCarlo, summarizeRuns } from '../../../extension/quant/montecarlo.mjs'

const trades = (pnls) => pnls.map((pnl, index) => ({ entryTime: `2024-01-${String(index + 1).padStart(2, '0')}`, exitTime: `2024-01-${String(index + 1).padStart(2, '0')}`, pnl, return: pnl / 100 }))

test('o gerador é determinístico: mesma semente, mesma sequência', () => {
  const first = createRandom(42)
  const second = createRandom(42)
  const a = [first(), first(), first()]
  const b = [second(), second(), second()]
  assert.deepEqual(a, b)
  for (const value of a)
    assert.ok(value >= 0 && value < 1, `${value} fora de [0,1)`)
  const other = createRandom(43)
  assert.notEqual(other(), a[0], 'sementes diferentes produzem sequências diferentes')
})

test('mesma semente e mesmos trades geram o mesmo relatório', () => {
  const sample = trades([100, -50, 75, -25, 40, -60, 90, -10])
  const first = runMonteCarlo(sample, { iterations: 200, seed: 7 })
  const second = runMonteCarlo(sample, { iterations: 200, seed: 7 })
  assert.equal(first.meanNetProfit, second.meanNetProfit)
  assert.equal(first.worstNetProfit, second.worstNetProfit)
  assert.equal(first.bestNetProfit, second.bestNetProfit)
  assert.equal(first.probabilityOfRuin, second.probabilityOfRuin)
})

test('sementes diferentes produzem distribuições diferentes', () => {
  const sample = trades([100, -50, 75, -25, 40, -60, 90, -10, 55, -35])
  const one = runMonteCarlo(sample, { iterations: 300, seed: 1 })
  const other = runMonteCarlo(sample, { iterations: 300, seed: 2 })
  assert.notEqual(one.bestNetProfit, other.bestNetProfit)
})

test('o bootstrap tem média igual a n × média da amostra (e não preserva a soma de uma rodada)', () => {
  // Reposição muda a soma de cada rodada de propósito: é isso que produz a distribuição. A propriedade
  // verificável é a esperança: com n sorteios independentes, E[soma] = n × média dos trades.
  const pnls = [100, -50, 75, -25, 40]
  const report = runMonteCarlo(trades(pnls), { iterations: 4000, seed: 3 })
  const mean = pnls.reduce((sum, value) => sum + value, 0) / pnls.length
  const expected = mean * pnls.length
  assert.ok(Math.abs(report.meanNetProfit - expected) < 8, `média ${report.meanNetProfit} longe de ${expected}`)
  const totals = new Set(report.runs.map((run) => run.netProfit))
  assert.ok(totals.size > 1, 'as rodadas precisam variar, senão não há distribuição')
})

test('bloco do tamanho da amostra vira rotação e preserva a soma', () => {
  // Com blockSize >= tamanho, o bloco copia a amostra inteira a partir de um início aleatório: é rotação, não sorteio.
  const pnls = [10, -20, 30, -40, 50]
  const total = pnls.reduce((sum, value) => sum + value, 0)
  const report = runMonteCarlo(trades(pnls), { iterations: 25, seed: 5, blockSize: pnls.length })
  assert.equal(report.blockSize, pnls.length)
  assert.equal(report.iterations, 25)
  for (const run of report.runs)
    assert.equal(run.netProfit, total, 'rotação preserva a soma')
})

test('blockSize intermediário mantém a marcação e produz distribuição', () => {
  const report = runMonteCarlo(trades([10, -20, 30, -40, 50, -15]), { iterations: 60, seed: 6, blockSize: 3 })
  assert.equal(report.blockSize, 3)
  assert.equal(report.runs.length, 60)
  assert.ok(new Set(report.runs.map((run) => run.netProfit)).size > 1)
})

test('capital inicial move a curva e define ruína como fração do capital', () => {
  const sample = trades([-100, -100, 50, 300])
  const withoutCapital = runMonteCarlo(sample, { iterations: 100, seed: 11 })
  const withCapital = runMonteCarlo(sample, { iterations: 100, seed: 11, initialCapital: 1000, ruinThreshold: 0.5 })
  assert.equal(withCapital.meanNetProfit, withoutCapital.meanNetProfit, 'o lucro líquido não depende do capital')
  assert.ok(withCapital.runs.every((run) => run.finalEquity === 1000 + run.netProfit))
  // ruína = cair para metade do capital: só acontece se a rodada somar -500 ou menos, impossível com esta amostra
  assert.equal(withCapital.probabilityOfRuin, 0)
})

test('sequência de perdas consecutivas é medida e limitada pelo tamanho da amostra', () => {
  const sample = trades([-10, -20, -30, 50, -5])
  const report = runMonteCarlo(sample, { iterations: 500, seed: 13 })
  for (const run of report.runs)
    assert.ok(run.longestLossStreak >= 0 && run.longestLossStreak <= sample.length)
  // há 4 perdas em 5 trades: alguma rodada precisa exibir sequência de pelo menos 2
  assert.ok(report.longestLossStreak.p50 >= 1, JSON.stringify(report.longestLossStreak))
  assert.ok(report.longestLossStreak.p95 >= 2, JSON.stringify(report.longestLossStreak))
})

test('percentis do relatório são monotônicos e dentro do observado', () => {
  const report = runMonteCarlo(trades([100, -50, 75, -25, 40]), { iterations: 200, seed: 17 })
  const net = report.netProfit
  assert.ok(net.p5 <= net.p50 && net.p50 <= net.p95)
  assert.ok(report.worstNetProfit <= report.bestNetProfit)
  assert.ok(report.worstNetProfit <= net.p5 && net.p95 <= report.bestNetProfit)
  assert.ok(report.probabilityOfProfit >= 0 && report.probabilityOfProfit <= 1)
  assert.ok(report.probabilityOfRuin >= 0 && report.probabilityOfRuin <= 1)
})

test('amostra vazia e iterações inválidas falham com mensagem clara', () => {
  assert.throws(() => runMonteCarlo([], {}), /no trades/i)
  assert.throws(() => runMonteCarlo(trades([10]), { iterations: 0 }), /iterations/)
  assert.throws(() => runMonteCarlo(trades([10]), { iterations: 1.5 }), /iterations/)
  assert.throws(() => runMonteCarlo(trades([10]), { iterations: 100_001 }), /iterations/)
})

test('summarizeRuns aceita rodadas prontas e declara a versão', () => {
  const summary = summarizeRuns([
    { netProfit: 10, maxDrawdown: 5, longestLossStreak: 1, ruined: false },
    { netProfit: -10, maxDrawdown: 15, longestLossStreak: 3, ruined: true },
  ], { seed: 9, blockSize: 2 })
  assert.equal(summary.monteCarloVersion, '1.0.0')
  assert.equal(summary.iterations, 2)
  assert.equal(summary.seed, 9)
  assert.equal(summary.blockSize, 2)
  assert.equal(summary.probabilityOfRuin, 0.5)
  assert.equal(summary.probabilityOfProfit, 0.5)
  assert.equal(summary.worstNetProfit, -10)
  assert.equal(summary.bestNetProfit, 10)
})

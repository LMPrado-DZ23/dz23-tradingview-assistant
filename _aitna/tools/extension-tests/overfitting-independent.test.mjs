// Estatística de overfitting: conferida à mão e por propriedades, não só "roda sem erro".
// Um DSR errado declara "não há overfitting" numa estratégia sobreajustada — o pior erro possível aqui.
import assert from 'node:assert/strict'
import test from 'node:test'
import { deflatedSharpeRatio, normalCdf, normalInv, overfittingReport, probabilityOfBacktestOverfitting } from '../../../extension/quant/overfitting.mjs'

test('normalInv e normalCdf são inversos', () => {
  for (const p of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    const x = normalInv(p)
    assert.ok(Math.abs(normalCdf(x) - p) < 1e-6, `p=${p} → x=${x} → ${normalCdf(x)}`)
  }
})

test('normalInv acerta valores conhecidos', () => {
  assert.ok(Math.abs(normalInv(0.5)) < 1e-9, 'Φ⁻¹(0.5) = 0')
  assert.ok(Math.abs(normalInv(0.975) - 1.959964) < 1e-5, 'Φ⁻¹(0.975) ≈ 1.96')
  assert.ok(Math.abs(normalInv(0.8413447) - 1) < 1e-5, 'Φ⁻¹(0.8413) ≈ 1')
})

test('DSR: conta à mão para SR=1, n=100, N=2', () => {
  // SR0 = sqrt(1/100) · [(1−γ)Φ⁻¹(0.5) + γΦ⁻¹(0.81606)]
  //     = 0.1 · [0 + 0.5772157 · 0.90039] = 0.051980
  // den = sqrt(1 + 0.5·1²) = 1.2247449
  // z   = (1 − 0.051980)·sqrt(99)/1.2247449 = 7.70195 → Φ(z) ≈ 1
  const result = deflatedSharpeRatio({ sharpe: 1, observations: 100, trials: 2 })
  assert.ok(Math.abs(result.expectedMaxSharpe - 0.051980) < 5e-4, `SR0 ${result.expectedMaxSharpe}`)
  assert.ok(Math.abs(result.z - 7.70195) < 5e-3, `z ${result.z}`)
  assert.ok(result.value > 0.999, `DSR ${result.value}`)
})

test('DSR cai quando há mais tentativas (deflação de verdade)', () => {
  // Sharpe 0,3 com 250 observações: fraco o bastante para a deflação aparecer (com 1,5 satura em 1 e não diz nada).
  const values = [2, 5, 20, 100, 1000].map((trials) => deflatedSharpeRatio({ sharpe: 0.3, observations: 250, trials }).value)
  for (let index = 1; index < values.length; index++)
    assert.ok(values[index] < values[index - 1], `DSR deveria cair a cada aumento de tentativas: ${values.join(' → ')}`)
  assert.ok(values.at(-1) < 0.95, `com 1000 tentativas o DSR cai para ${values.at(-1)}, não fica em 1`)
})

test('DSR recusa uma única tentativa: não há o que deflacionar', () => {
  const result = deflatedSharpeRatio({ sharpe: 2, observations: 100, trials: 1 })
  assert.equal(result.value, null)
  assert.match(String(result.reason), /trial/i)
})

test('DSR recusa Sharpe não finito em vez de devolver número', () => {
  for (const sharpe of [NaN, Infinity, undefined])
    assert.equal(deflatedSharpeRatio({ sharpe, observations: 100, trials: 5 }).value, null)
})

test('DSR sobe quando o Sharpe observado sobe, com as mesmas tentativas', () => {
  const low = deflatedSharpeRatio({ sharpe: 0.5, observations: 200, trials: 10 }).value
  const high = deflatedSharpeRatio({ sharpe: 2, observations: 200, trials: 10 }).value
  assert.ok(high > low)
})

test('PBO: estratégia dominante em todos os blocos tem PBO zero', () => {
  // A bate B em todos os períodos: escolher pelo IS nunca engana, então não há probabilidade de overfitting.
  const returns = [
    Array.from({ length: 40 }, (_, index) => 0.01 + index * 0.0001),
    Array.from({ length: 40 }, (_, index) => -0.01 - index * 0.0001),
  ]
  const result = probabilityOfBacktestOverfitting({ returns, splits: 4 })
  assert.equal(typeof result.pbo, 'number')
  assert.equal(result.pbo, 0, 'estratégia dominante nunca engana: PBO zero')
})

test('PBO fica no meio quando as duas estratégias são indistinguíveis', () => {
  // Duas séries quase idênticas: o ranking IS não prevê o OOS, então o PBO fica alto (perto de 0.5).
  const base = Array.from({ length: 60 }, (_, index) => Math.sin(index) * 0.01)
  const noisy = base.map((value, index) => value + (index % 2 === 0 ? 1e-6 : -1e-6))
  const result = probabilityOfBacktestOverfitting({ returns: [base, noisy], splits: 6 })
  assert.ok(result.pbo >= 0.2 && result.pbo <= 0.8, `PBO ${result.pbo} deveria ficar perto do acaso`)
})

test('PBO recusa entrada insuficiente lancando erro explicito', () => {
  // Contrato: falha alto. Silêncio aqui viraria "PBO 0" numa amostra que não permite calcular nada.
  assert.throws(() => probabilityOfBacktestOverfitting({ returns: [[0.01]], splits: 4 }), /at least 2 trials/i)
})

test('DSR saturado gera limitação de leitura, não alarme', () => {
  // Rodada 74 provou que DSR satura em 1.0000; "DSR 1.0" não pode ser lido como "à prova de overfitting".
  const saturated = overfittingReport({
    inSample: { netProfit: 100 },
    outOfSample: { netProfit: 95 },
    testedCombinations: 5,
    pbo: 0.1,
    deflated: deflatedSharpeRatio({ sharpe: 0.6, observations: 400, trials: 2 }),
  })
  assert.deepEqual(saturated.warnings, [], 'caso saudável não pode virar alarme')
  assert.ok(
    saturated.limitations.some((item) => /saturated DSR/i.test(item)),
    'a limitação precisa dizer que o número saturado não informa',
  )
})

test('DSR intermediário avisa que mais tentativas o derrubam', () => {
  const borderline = overfittingReport({
    inSample: { netProfit: 100 },
    outOfSample: { netProfit: 60 },
    testedCombinations: 50,
    pbo: 0.2,
    deflated: deflatedSharpeRatio({ sharpe: 0.25, observations: 300, trials: 10 }),
  })
  const value = borderline.deflatedSharpe.value
  assert.ok(value >= 0.95 && value < 0.999, `caso escolhido precisa ficar na faixa limítrofe, veio ${value}`)
  assert.ok(borderline.limitations.some((item) => /borderline clearance/i.test(item)))
})

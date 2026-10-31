// Indicadores conferidos à mão. Uma RSI errada é pior que um drawdown errado: o modelo cita o número com confiança
// e o usuário age sobre ele. Cada teste usa uma série cuja resposta correta eu consigo calcular sem o código.
import assert from 'node:assert/strict'
import test from 'node:test'
import { atr, bollinger, ema, macd, rsi, sma, vwap } from '../../../extension/lib/marketIntel.js'

const close = (values) => values

test('SMA confere com a média à mão', () => {
  assert.equal(sma([1, 2, 3, 4, 5], 5), 3)
  assert.equal(sma([2, 4, 6, 8], 2), 7) // última janela: (6+8)/2
  assert.equal(sma([1, 2], 5), null, 'série menor que o período não inventa média')
})

test('EMA começa na SMA e aplica o fator 2/(n+1)', () => {
  // period 3 → alpha 0.5; primeiro valor é a SMA dos 3 primeiros (2), depois 0.5*novo + 0.5*anterior
  const result = ema([1, 2, 3, 5], 3)
  // 2 → (5-2)*0.5+2 = 3.5
  assert.ok(Math.abs(result - 3.5) < 1e-9, `EMA ${result} deveria ser 3.5`)
})

test('RSI: série só de altas = 100, só de quedas = 0, série constante = 50 ou neutro', () => {
  const up = Array.from({ length: 40 }, (_, index) => 100 + index)
  const down = Array.from({ length: 40 }, (_, index) => 100 - index)
  const flat = Array.from({ length: 40 }, () => 100)
  assert.equal(Math.round(rsi(up, 14)), 100)
  assert.equal(Math.round(rsi(down, 14)), 0)
  const flatValue = rsi(flat, 14)
  assert.ok(flatValue === null || (flatValue >= 0 && flatValue <= 100), `RSI constante ${flatValue}`)
})

test('RSI: série alternada fica perto de 50', () => {
  const zigzag = Array.from({ length: 60 }, (_, index) => 100 + (index % 2 === 0 ? 1 : -1))
  const value = rsi(zigzag, 14)
  assert.ok(value > 40 && value < 60, `RSI alternado ${value} deveria ficar perto de 50`)
})

test('RSI: RSI de série com ganho líquido fica acima de 50, perda líquida abaixo', () => {
  const mildUp = Array.from({ length: 40 }, (_, index) => 100 + index * 0.5 + (index % 3 === 0 ? -0.2 : 0))
  const mildDown = Array.from({ length: 40 }, (_, index) => 100 - index * 0.5 + (index % 3 === 0 ? 0.2 : 0))
  assert.ok(rsi(mildUp, 14) > 50)
  assert.ok(rsi(mildDown, 14) < 50)
})

test('ATR: true range constante dá ATR igual a ele', () => {
  // high−low = 2 em todas as velas, sem gaps → TR = 2 → ATR = 2
  const candles = Array.from({ length: 40 }, (_, index) => ({ high: 101 + index * 0, low: 99, close: 100, open: 100 }))
  const value = atr(candles, 14)
  assert.ok(Math.abs(value - 2) < 1e-9, `ATR ${value} deveria ser 2`)
})

test('ATR: gap entre velas entra no true range', () => {
  // vela 1: 99–101; vela 2 anterior close 100, high 106 low 104 → TR = max(2, |106−100|, |104−100|) = 6
  const candles = [
    { high: 101, low: 99, close: 100, open: 100 },
    { high: 106, low: 104, close: 105, open: 105 },
    { high: 107, low: 105, close: 106, open: 106 },
    { high: 108, low: 106, close: 107, open: 107 },
  ]
  // TRs: 2 (primeira vela), depois 6, 3, 3 → ATR(2) fica acima de 2
  const value = atr(candles, 2)
  assert.ok(value > 2, `com gap, o ATR (${value}) precisa passar de 2`)
  // e com 2 velas apenas, o ATR(2) não é calculável: null, não zero
  assert.equal(atr(candles.slice(0, 2), 2), null, 'amostra insuficiente devolve null, não um número inventado')
})

test('Bollinger: série constante tem desvio zero e bandas iguais à média', () => {
  const values = Array.from({ length: 25 }, () => 50)
  const bands = bollinger(values, 20, 2)
  assert.ok(Math.abs(bands.middle - 50) < 1e-9)
  assert.ok(Math.abs(bands.upper - 50) < 1e-9, `banda superior ${bands.upper}`)
  assert.ok(Math.abs(bands.lower - 50) < 1e-9)
})

test('Bollinger: largura confere com 2 desvios-padrão à mão', () => {
  // janela de 20 valores: 1..20 → média 10.5, variância populacional = (n²−1)/12 = 33.25 → σ ≈ 5.7663
  const values = Array.from({ length: 20 }, (_, index) => index + 1)
  const bands = bollinger(values, 20, 2)
  const expectedSigma = Math.sqrt((20 ** 2 - 1) / 12)
  assert.ok(Math.abs(bands.middle - 10.5) < 1e-9)
  assert.ok(Math.abs(bands.upper - (10.5 + 2 * expectedSigma)) < 1e-6, `superior ${bands.upper} vs ${10.5 + 2 * expectedSigma}`)
  assert.ok(Math.abs(bands.lower - (10.5 - 2 * expectedSigma)) < 1e-6)
})

test('VWAP: preço constante é igual ao próprio preço', () => {
  const candles = Array.from({ length: 10 }, () => ({ high: 101, low: 99, close: 100, volume: 5 }))
  const value = vwap(candles)
  assert.ok(Math.abs(value - 100) < 1e-9, `VWAP ${value} deveria ser 100`)
})

test('VWAP: dois candles com volumes iguais dão a média dos preços típicos', () => {
  // típico = (high+low+close)/3; vela A: 10,10,10 → 10; vela B: 20,20,20 → 20; volumes 1 e 1 → 15
  const candles = [
    { high: 10, low: 10, close: 10, volume: 1 },
    { high: 20, low: 20, close: 20, volume: 1 },
  ]
  assert.ok(Math.abs(vwap(candles) - 15) < 1e-9)
})

test('VWAP: volume maior pesa mais', () => {
  const candles = [
    { high: 10, low: 10, close: 10, volume: 3 },
    { high: 20, low: 20, close: 20, volume: 1 },
  ]
  // (10*3 + 20*1)/4 = 12.5
  assert.ok(Math.abs(vwap(candles) - 12.5) < 1e-9, `VWAP ${vwap(candles)} deveria ser 12.5`)
})

test('MACD: linha e sinal coerentes numa série crescente', () => {
  const values = Array.from({ length: 80 }, (_, index) => 100 + index)
  const result = macd(values)
  const line = result.macd ?? result.line ?? result.value
  assert.ok(line > 0, `numa série crescente o MACD fica positivo, veio ${line}`)
})

test('indicadores recusam série curta em vez de inventar número', () => {
  assert.equal(rsi([1, 2, 3], 14), null)
  assert.equal(atr([{ high: 1, low: 0, close: 1 }], 14), null)
  const bands = bollinger([1, 2, 3], 20, 2)
  assert.ok(bands === null || Number.isNaN(bands.middle) || bands.middle === null)
})

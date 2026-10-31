// O bloco que o modelo LÊ. Os números precisam chegar com procedência, e o que falta precisa ser dito — não zerado.
// Um bloco que imprime "EMA50 = null" ou omite a limitação faz o modelo concluir sobre dado que não existe.
import assert from 'node:assert/strict'
import test from 'node:test'
import { marketIntelBlock, summarizeMarket } from '../../../extension/lib/marketIntel.js'

const make = (count) => Array.from({ length: count }, (_, index) => ({
  time: Date.UTC(2024, 0, 1) + index * 3600_000,
  open: 100 + Math.sin(index / 5) * 2,
  high: 101 + Math.sin(index / 5) * 2,
  low: 99 + Math.sin(index / 5) * 2,
  close: 100 + Math.sin((index + 1) / 5) * 2,
  volume: 10 + index,
}))

const context = { symbol: 'BTCUSDT', timeframe: '1h', exchange: 'BINANCE' }
const summarize = (count, extra = {}) => summarizeMarket({ candles: make(count), context, source: 'binance-public', ...extra })

test('o bloco declara procedência: fonte, timeframe, quantidade e último candle', () => {
  const block = marketIntelBlock(summarize(60))
  assert.match(block, /BINANCE-PUBLIC/, 'fonte')
  assert.match(block, /timeframe 1h/, 'timeframe')
  assert.match(block, /60 candles/, 'quantidade')
  assert.match(block, /último em 2024-01-03T11:00:00\.000Z/, 'horário do último candle')
})

test('os números do bloco são os mesmos que o módulo calculou', () => {
  const intel = summarize(60)
  const block = marketIntelBlock(intel)
  const rsiShown = Number(/RSI\(14\) = ([\d.]+)/.exec(block)?.[1])
  assert.ok(Math.abs(rsiShown - intel.rsi) < 0.005 + 1e-9, `RSI no bloco ${rsiShown} vs calculado ${intel.rsi}`)
  const emaShown = Number(/EMA20 = ([\d.]+)/.exec(block)?.[1])
  assert.ok(Math.abs(emaShown - intel.ema20) < 0.005 + 1e-9, `EMA20 no bloco ${emaShown} vs calculado ${intel.ema20}`)
})

test('indicador indisponível é OMITIDO, não impresso como null ou zero', () => {
  const block = marketIntelBlock(summarize(20)) // sem EMA50 e sem MACD
  assert.equal(/EMA50\s*=/.test(block), false, 'não pode imprimir "EMA50 =" se não há EMA50')
  assert.equal(/MACD\s*=/.test(block), false)
  assert.equal(/null/.test(block), false, 'a palavra null não pode vazar para o prompt')
  assert.equal(/NaN/.test(block), false)
})

test('a limitação é declarada em texto, com o mínimo que faltou', () => {
  const block = marketIntelBlock(summarize(20))
  assert.match(block, /Limitações/i)
  assert.match(block, /EMA50/, 'diz qual indicador ficou de fora')
  assert.match(block, /50/, 'diz o mínimo de candles')
})

test('série curta demais diz que está indisponível, com o mínimo', () => {
  const block = marketIntelBlock(summarize(5))
  assert.match(block, /indisponíveis/i)
  assert.match(block, /mínimo 15/)
  assert.equal(/RSI\(14\)/.test(block), false, 'sem amostra, não se imprime RSI')
})

test('sem velas também é dito, não é bloco vazio', () => {
  const block = marketIntelBlock(summarize(0))
  assert.ok(block.length > 20, 'um bloco vazio deixaria o modelo sem saber que faltou dado')
  assert.match(block, /indisponíveis/i)
})

test('o bloco instrui a rotular interpretação, e não a inventar fato', () => {
  const block = marketIntelBlock(summarize(60))
  assert.match(block, /fato calculado/i)
  assert.match(block, /interpreta/i)
})

test('amostra completa não declara limitação falsa', () => {
  const block = marketIntelBlock(summarize(60))
  assert.equal(/indisponíveis/i.test(block), false, 'com 60 velas nada está indisponível')
  assert.equal(/sem EMA50/.test(block), false)
})

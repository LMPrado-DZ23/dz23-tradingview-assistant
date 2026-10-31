// Chart actions: URL building, validation and — the important part — verification against the observed chart.
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildActionUrl, describeAction, normalizeInterval, normalizeSymbol, verifyAction } from '../../../extension/lib/chartActions.js'

const chart = { symbol: 'BTCUSDT', exchange: 'BINANCE', timeframe: '1h', resolution: '60' }
const href = 'https://www.tradingview.com/chart/BINANCE:BTCUSDT/?interval=60'

test('normaliza símbolo com e sem exchange', () => {
  assert.deepEqual(normalizeSymbol('btcusdt'), { ok: true, symbol: 'BTCUSDT' })
  assert.deepEqual(normalizeSymbol(' binance:ethusdt '), { ok: true, symbol: 'BINANCE:ETHUSDT' })
  assert.equal(normalizeSymbol('').ok, false)
  assert.equal(normalizeSymbol('BTC USDT!').ok, false)
})

test('normaliza timeframe por rótulo e por número', () => {
  assert.deepEqual(normalizeInterval('15m'), { ok: true, timeframe: '15m', interval: 15 })
  assert.deepEqual(normalizeInterval('1H'), { ok: true, timeframe: '1h', interval: 60 })
  assert.deepEqual(normalizeInterval('4h'), { ok: true, timeframe: '4h', interval: 240 })
  assert.deepEqual(normalizeInterval('1D'), { ok: true, timeframe: '1D', interval: 'D' })
  assert.deepEqual(normalizeInterval('60'), { ok: true, timeframe: '60', interval: 60 })
  assert.equal(normalizeInterval('próximo').ok, false)
})

test('montar URL de troca de ativo preserva exchange e intervalo', () => {
  const result = buildActionUrl({ href, current: chart, change: { symbol: 'ETHUSDT' } })
  assert.equal(result.ok, true)
  assert.equal(result.url, 'https://www.tradingview.com/chart/BINANCE:ETHUSDT/?interval=60')
  assert.deepEqual(result.expected, { symbol: 'ETHUSDT', exchange: 'BINANCE', timeframe: '1h' })
})

test('trocar timeframe mantém o ativo atual', () => {
  const result = buildActionUrl({ href, current: chart, change: { timeframe: '15m' } })
  assert.equal(result.url, 'https://www.tradingview.com/chart/BINANCE:BTCUSDT/?interval=15')
  assert.equal(result.expected.timeframe, '15m')
})

test('trocar ativo e timeframe juntos', () => {
  const result = buildActionUrl({ href, current: chart, change: { symbol: 'SOLUSDT', timeframe: '4h' } })
  assert.equal(result.url, 'https://www.tradingview.com/chart/BINANCE:SOLUSDT/?interval=240')
})

test('sem mudança e com entrada inválida, recusa com motivo', () => {
  assert.equal(buildActionUrl({ href, current: chart, change: {} }).ok, false)
  const bad = buildActionUrl({ href, current: chart, change: { symbol: '###' } })
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /símbolo inválido/)
})

test('preserva o layout quando a URL atual tem um', () => {
  const result = buildActionUrl({ href: `${href}&layout=abc123`, current: chart, change: { timeframe: '5m' } })
  assert.match(result.url, /layout=abc123/)
})

test('verificação confirma quando o observado bate', () => {
  const expected = { symbol: 'ETHUSDT', exchange: 'BINANCE', timeframe: '15m' }
  const verification = verifyAction(expected, { rawSymbol: 'BINANCE:ETHUSDT', resolution: '15', source: 'page' })
  assert.equal(verification.ok, true)
})

test('verificação falha e diz o que divergiu', () => {
  const verification = verifyAction({ symbol: 'ETHUSDT', exchange: 'BINANCE', timeframe: '15m' }, { rawSymbol: 'BINANCE:BTCUSDT', resolution: '60', source: 'page' })
  assert.equal(verification.ok, false)
  assert.equal(verification.mismatches.length, 2)
  assert.match(verification.mismatches[0], /ativo: esperado ETHUSDT, observado BTCUSDT/)
  assert.match(verification.mismatches[1], /timeframe: esperado 15m, observado 60m/)
})

test('sem gráfico observado não confirma nada', () => {
  const verification = verifyAction({ symbol: 'ETHUSDT' }, { source: 'none', rawSymbol: null })
  assert.equal(verification.ok, false)
  assert.match(verification.mismatches[0], /nenhum gráfico/)
})

test('timeframe diário é comparado como 1D', () => {
  assert.equal(verifyAction({ timeframe: '1D' }, { rawSymbol: 'BINANCE:BTCUSDT', resolution: 'D', source: 'page' }).ok, true)
  assert.equal(verifyAction({ timeframe: '1D' }, { rawSymbol: 'BINANCE:BTCUSDT', resolution: '240', source: 'page' }).ok, false)
})

test('descrição legível distingue confirmado, não confirmado e falha', () => {
  assert.match(describeAction({ verified: true, expected: { symbol: 'ETHUSDT', timeframe: '15m' } }), /confirmado/)
  assert.match(describeAction({ verified: false, expected: { symbol: 'ETHUSDT' }, mismatches: ['timeframe: esperado 15m, observado 60m'] }), /não confirmado/)
  assert.match(describeAction({ verified: false, reason: 'nada para mudar' }), /falhou/)
})

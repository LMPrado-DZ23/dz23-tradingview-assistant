// Watchlists and alerts: CRUD, comparison, ranking and evaluation — no network, no UI.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addSymbol, canAddList, compareLists, createList, describeRanking, normalizeSymbol, rankOpportunities, removeSymbol,
} from '../../../extension/lib/watchlist.js'
import {
  createAlert, editAlert, evaluateAlerts, pauseAlert, removeAlert, resumeAlert, summarizeAlerts,
} from '../../../extension/lib/alerts.js'

const at = (ms) => () => ms

test('watchlist: cria, adiciona, recusa duplicado e remove', () => {
  const created = createList('cripto', ['btcusdt', 'BINANCE:BTCUSDT', 'ETHUSDT'])
  assert.equal(created.ok, true)
  assert.deepEqual(created.list.symbols, ['BTCUSDT', 'BINANCE:BTCUSDT', 'ETHUSDT'])
  let lists = [created.list]
  const added = addSymbol(lists, created.list.id, 'solusdt')
  assert.equal(added.ok, true)
  lists = added.lists
  assert.ok(lists[0].symbols.includes('SOLUSDT'))
  const duplicate = addSymbol(lists, created.list.id, 'solusdt')
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.duplicate, true)
  const removed = removeSymbol(lists, created.list.id, 'SOLUSDT')
  assert.equal(removed.ok, true)
  assert.ok(!removed.lists[0].symbols.includes('SOLUSDT'))
  assert.equal(removeSymbol(removed.lists, created.list.id, 'XRPUSDT').ok, false)
})

test('watchlist: nome obrigatório e símbolo validado', () => {
  assert.equal(createList('').ok, false)
  assert.equal(normalizeSymbol('').ok, false)
  assert.equal(normalizeSymbol('BTC USDT').ok, true, 'espaço é removido antes de validar')
  assert.equal(normalizeSymbol('###').ok, false)
})

test('watchlist: comparação é independente de ordem e de caixa', () => {
  const result = compareLists(['BTCUSDT', 'ETHUSDT'], ['ETHUSDT', 'SOLUSDT'])
  assert.deepEqual(result.onlyLeft, ['BTCUSDT'])
  assert.deepEqual(result.onlyRight, ['SOLUSDT'])
  assert.deepEqual(result.both, ['ETHUSDT'])
})

test('rank: ordena por regra fixa e separa quem não tem dado', () => {
  const result = rankOpportunities([
    { symbol: 'AAA', price: 110, intel: { available: true, sample: 60, trend: 'alta', rsi: 62, vwap: 100 } },
    { symbol: 'BBB', price: 90, intel: { available: true, sample: 60, trend: 'baixa', rsi: 25, vwap: 100 } },
    { symbol: 'CCC', price: 100, intel: { available: false, missing: ['poucos candles (3)'] } },
  ])
  assert.deepEqual(result.ranked.map((entry) => entry.symbol), ['AAA', 'BBB'])
  assert.ok(result.ranked[0].score > result.ranked[1].score)
  assert.equal(result.withoutData[0].symbol, 'CCC')
  assert.match(result.rule, /não é recomendação/)
  assert.match(describeRanking(result), /AAA: score/)
})

test('rank: amostra mínima é respeitada', () => {
  const result = rankOpportunities([{ symbol: 'AAA', price: 1, intel: { available: true, sample: 5, trend: 'alta' } }], { minSample: 20 })
  assert.equal(result.ranked.length, 0)
  assert.equal(result.withoutData[0].symbol, 'AAA')
})

test('alerta: cria e valida tipo, valor e RSI', () => {
  const created = createAlert({ symbol: 'btcusdt', type: 'price_above', value: 100_000 })
  assert.equal(created.ok, true)
  assert.equal(created.alert.symbol, 'BTCUSDT')
  assert.equal(created.alert.state, 'armed')
  assert.equal(createAlert({ symbol: 'BTCUSDT', type: 'voar', value: 1 }).ok, false)
  assert.equal(createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 'muito' }).ok, false)
  assert.equal(createAlert({ symbol: 'BTCUSDT', type: 'rsi_above', value: 120 }).ok, false)
})

test('alerta: dispara uma vez, mantém pendente e respeita cooldown', () => {
  const alert = createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 100, cooldownMs: 60_000, now: at(1000) }).alert
  const first = evaluateAlerts([alert], { BTCUSDT: { price: 101 } }, at(2000))
  assert.equal(first.fired.length, 1)
  assert.equal(first.alerts[0].state, 'fired')
  // já disparado: não dispara de novo
  const second = evaluateAlerts(first.alerts, { BTCUSDT: { price: 105 } }, at(3000))
  assert.equal(second.fired.length, 0)
  assert.equal(second.skipped.length, 1)
  // rearmar volta a monitorar
  const resumed = resumeAlert(second.alerts, alert.id)
  const third = evaluateAlerts(resumed.alerts, { BTCUSDT: { price: 106 } }, at(4000))
  assert.equal(third.fired.length, 0, 'cooldown ainda ativo')
  assert.equal(third.pending[0].cooldown, true)
})

test('alerta: pendente mostra o valor observado e pausa não avalia', () => {
  const alert = createAlert({ symbol: 'BTCUSDT', type: 'price_below', value: 90 }).alert
  const pending = evaluateAlerts([alert], { BTCUSDT: { price: 95 } })
  assert.equal(pending.pending.length, 1)
  assert.equal(pending.pending[0].observed, 95)
  const paused = pauseAlert([alert], alert.id)
  const evaluation = evaluateAlerts(paused.alerts, { BTCUSDT: { price: 80 } })
  assert.equal(evaluation.fired.length, 0)
  assert.match(evaluation.skipped[0].reason, /paused/)
})

test('alerta: sem leitura do símbolo fica sem avaliação, não dispara por engano', () => {
  const alert = createAlert({ symbol: 'ETHUSDT', type: 'pct_move', value: 5 }).alert
  const evaluation = evaluateAlerts([alert], { BTCUSDT: { price: 100 } })
  assert.equal(evaluation.fired.length, 0)
  assert.equal(evaluation.skipped[0].reason, 'sem leitura para o símbolo')
})

test('alerta: remove e resume validam o id', () => {
  const alert = createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 1 }).alert
  assert.equal(removeAlert([alert], 'nada').ok, false)
  assert.equal(removeAlert([alert], alert.id).alerts.length, 0)
  assert.equal(resumeAlert([alert], 'nada').ok, false)
})

test('resumo do alerta declara o escopo e o que disparou', () => {
  const alert = createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 100 }).alert
  const text = summarizeAlerts(evaluateAlerts([alert], { BTCUSDT: { price: 101 } }))
  assert.match(text, /DISPAROU BTCUSDT price_above 100/)
  assert.match(text, /não são alertas do TradingView/)
})

test('editar alerta: muda valor, mantém id e re-arma o disparo', () => {
  const created = createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 100, now: at(1000) }).alert
  const fired = evaluateAlerts([created], { BTCUSDT: { price: 101 } }, at(2000))
  assert.equal(fired.alerts[0].state, 'fired')
  const edited = editAlert(fired.alerts, created.id, { value: 200 }, at(3000))
  assert.equal(edited.ok, true)
  assert.equal(edited.alert.id, created.id, 'editar não cria outro alerta')
  assert.equal(edited.alert.value, 200)
  assert.equal(edited.alert.state, 'armed', 'condição nova volta a monitorar')
  assert.equal(edited.alert.lastFiredAt, null)
  // com o novo limite, 101 não dispara mais
  const after = evaluateAlerts(edited.alerts, { BTCUSDT: { price: 101 } }, at(4000))
  assert.equal(after.fired.length, 0)
  assert.equal(after.pending[0].observed, 101)
})

test('editar alerta: nota não re-arma, e nada mudou é relatado', () => {
  const created = createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 100 }).alert
  const fired = evaluateAlerts([created], { BTCUSDT: { price: 101 } })
  const edited = editAlert(fired.alerts, created.id, { note: 'acompanhar' })
  assert.equal(edited.ok, true)
  assert.equal(edited.alert.state, 'fired', 'nota não muda a condição')
  assert.equal(edited.alert.note, 'acompanhar')
  const same = editAlert(edited.alerts, created.id, { note: 'acompanhar' })
  assert.equal(same.unchanged, true)
})

test('editar alerta: valida tipo, valor e cooldown', () => {
  const created = createAlert({ symbol: 'BTCUSDT', type: 'price_above', value: 100 }).alert
  assert.equal(editAlert([created], created.id, { type: 'voar' }).ok, false)
  assert.equal(editAlert([created], created.id, { value: 'muito' }).ok, false)
  assert.equal(editAlert([created], created.id, { type: 'rsi_above', value: 150 }).ok, false)
  assert.equal(editAlert([created], created.id, { cooldownMs: -1 }).ok, false)
  assert.equal(editAlert([created], 'nada', { value: 1 }).ok, false)
})

test('canAddList respeita MAX_LISTS e informa quantas ainda cabem', () => {
  const empty = canAddList([])
  assert.equal(empty.ok, true)
  const full = Array.from({ length: 20 }, (_, index) => ({ id: `l${index}`, name: `lista ${index}`, symbols: [] }))
  const blocked = canAddList(full)
  assert.equal(blocked.ok, false)
  assert.match(blocked.reason, /limite de 20 listas/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension } from './harness.mjs'

// model.js turns the strategy inputs of TradingView into the parameter space that is searched: a wrong range
// means a wrong test, so each shape it produces is pinned here.

const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

function modelWith (storage = {}) {
  const extension = loadExtension(['content_scripts/page.js', 'content_scripts/storage.js', 'content_scripts/model.js'], { storage })
  const { model } = extension.api('model')
  return { model, extension }
}

test('a numeric input becomes a range from half to double its value', () => {
  const { model } = modelWith()
  const range = model.getStrategyRange({ properties: { length: 20 } })
  assert.deepEqual(plain(range.length), [10, 40, 3, 20, 1])
})

test('a float input keeps halves and a whole-number step', () => {
  const { model } = modelWith()
  const range = plain(model.getStrategyRange({ properties: { factor: 1.5 } }))
  assert.equal(range.factor[0], 0.75)
  assert.equal(range.factor[1], 3)
  // A fractional range uses 1 as the step (not a tenth of the span), so 0.75..3 becomes 0.75, 1.75, 2.75
  assert.equal(range.factor[2], 1)
  assert.equal(range.factor[3], 1.5)
})

test('a checkbox, a list and a zero keep their own shape', () => {
  const { model } = modelWith()
  const range = plain(model.getStrategyRange({
    properties: { useTrend: true, source: 'close;open;high', threshold: 0 },
  }))
  assert.deepEqual(range.useTrend, [true, false, 0, true, 1])
  assert.deepEqual(range.source, ['close;open;high', '', 0, 'close', 2])
  assert.deepEqual(range.threshold, [0, '', 0, 0, 3])
})

test('a range with a step lists every value and always reaches the upper bound', () => {
  const { model } = modelWith()
  const params = plain(model.createParamsFromRange({ p: [0, 10, 5, 5, 1] }))
  assert.deepEqual(params.p, [0, 5, 10])
})

test('a float step does not leave values like 0.79999999999', () => {
  const { model } = modelWith()
  const params = plain(model.createParamsFromRange({ p: [0, 1, 0.1, 0, 1] }))
  assert.equal(params.p.length, 11)
  assert.equal(params.p[1], 0.1)
  assert.equal(params.p[7], 0.7)
  assert.equal(params.p.at(-1), 1)
})

test('a boolean and a list range become their value lists', () => {
  const { model } = modelWith()
  const params = plain(model.createParamsFromRange({
    flag: [true, false, 0, true, 1],
    source: ['close;open', '', 0, 'close', 2],
  }))
  assert.deepEqual(params.flag, [true, false])
  assert.deepEqual(params.source, ['close', 'open'])
})

test('a parameter without a range is skipped, and a malformed one is reported', () => {
  const { model, extension } = modelWith()
  const params = plain(model.createParamsFromRange({
    single: [5, '', 0, 5, 1],
    broken: [1, 2],
  }))
  assert.equal(params.single, undefined)
  assert.equal(params.broken, undefined)
  const reported = extension.logs.filter((entry) => entry.level === 'error')
  assert.ok(reported.some((entry) => entry.args.some((arg) => String(arg).includes('broken'))), JSON.stringify(reported))
})

test('a range whose bounds are reversed still yields a testable value', () => {
  const { model } = modelWith()
  const params = plain(model.createParamsFromRange({ p: [10, 0, 1, 0, 1] }))
  assert.deepEqual(params.p, [0])
})

test('the template is a CSV the extension can load back', () => {
  const { model } = modelWith()
  const csv = model.convertStrategyRangeToTemplate({
    length: [10, 40, 3, 20, 1],
    useTrend: [true, false, 0, true, 2],
  })
  const lines = csv.trim().split('\n')
  assert.equal(lines[0], 'Parameter,From,To,Step,Default,Priority')
  assert.equal(lines[1], '"length",10,40,3,20,1')
  assert.equal(lines[2], '"useTrend",true,false,0,true,2')
})

test('maximising is the default direction', () => {
  const { model } = modelWith()
  assert.equal(model.isMaximizing({}), true)
  assert.equal(model.isMaximizing({ isMaximizing: false }), false)
  assert.equal(model.isMaximizing(undefined), true)
})

test('the best result honours the direction, a zero value and missing metrics', () => {
  const { model } = modelWith()
  const summary = [{ p: 0 }, { p: -1 }, { other: 5 }]
  assert.deepEqual(plain(model.getBestResult({ perfomanceSummary: summary, optParamName: 'p', isMaximizing: true })), { p: 0 })
  assert.deepEqual(plain(model.getBestResult({ perfomanceSummary: summary, optParamName: 'p', isMaximizing: false })), { p: -1 })
  assert.equal(model.getBestResult({ perfomanceSummary: [], optParamName: 'p' }), '')
})

test('the parameter priority list is ordered by the priority column', () => {
  const { model } = modelWith()
  const list = plain(model.getParamPriorityList({
    slow: [10, 40, 3, 20, 2],
    fast: [1, 5, 1, 3, 1],
  }))
  assert.deepEqual(list, ['fast', 'slow'])
})

test('the start values carry the defaults and the values on the chart', async () => {
  const { model } = modelWith()
  const start = plain(await model.getStartParamValues(
    { length: [10, 40, 3, 20, 1], useTrend: [true, false, 0, true, 2] },
    { properties: { length: 30, useTrend: false, unrelated: 7 } },
  ))
  assert.deepEqual(start.default, { length: 20, useTrend: true })
  assert.deepEqual(start.current, { length: 30, useTrend: false })
})

test('the start values reuse the best parameters of the stored results', async () => {
  const { model } = modelWith({
    iondv_strategy_result: {
      perfomanceSummary: [{ 'Total PnL': 10, __length: 25 }],
      paramsNames: ['length'],
      optParamName: 'Total PnL',
      isMaximizing: true,
    },
  })
  const start = plain(await model.getStartParamValues(
    { length: [10, 40, 3, 20, 1] },
    { properties: { length: 30 } },
  ))
  assert.deepEqual(start.best, { length: 25 })
})

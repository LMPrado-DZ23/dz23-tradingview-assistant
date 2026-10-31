import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension } from './harness.mjs'

// backtest.js owns the optimization: which parameter set is tried next and which result becomes "the best".
// Both are pure decisions around a single "run one backtest" call, so they are pinned here with that call stubbed.

const CONTENT_SCRIPTS = [
  'content_scripts/selector.js',
  'content_scripts/page.js',
  'content_scripts/ui.js',
  'content_scripts/tv.js',
  'content_scripts/tvChart.js',
  'content_scripts/file.js',
  'content_scripts/storage.js',
  'content_scripts/signal.js',
  'content_scripts/model.js',
  'content_scripts/backtest.js',
]

const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

function backtestExtension (storage = {}) {
  const extension = loadExtension(CONTENT_SCRIPTS, { storage })
  const api = extension.api(['backtest', 'storage'])
  const call = (name, ...args) => extension.evaluate(name)(...args)
  return { extension, backtest: api.backtest, call }
}

function results (overrides = {}) {
  return {
    optParamName: 'Total PnL',
    isMaximizing: true,
    perfomanceSummary: [],
    filteredSummary: [],
    paramsNames: ['a', 'b'],
    paramPriority: ['a', 'b'],
    cycles: 10,
    ...overrides,
  }
}

test('a better value replaces the best state', async () => {
  const { call } = backtestExtension()
  const testResults = results()
  const res = await call('getResWithBestValue', { error: null, data: { 'Total PnL': 5 } }, testResults, 1, { a: 1, b: 10 }, { a: 2, b: 10 })
  assert.equal(res.bestValue, 5)
  assert.equal(res.isBestChanged, true)
  assert.deepEqual(plain(res.bestPropVal), { a: 2, b: 10 })
  assert.equal(testResults.perfomanceSummary.length, 1)
})

test('a worse value keeps the best state', async () => {
  const { call } = backtestExtension()
  const res = await call('getResWithBestValue', { error: null, data: { 'Total PnL': 3 } }, results(), 5, { a: 1 }, { a: 2 })
  assert.equal(res.bestValue, 5)
  assert.equal(res.isBestChanged, false)
  assert.deepEqual(plain(res.bestPropVal), { a: 1 })
})

test('the minimum direction keeps the smallest value', async () => {
  const { call } = backtestExtension()
  const res = await call('getResWithBestValue', { error: null, data: { 'Total PnL': 3 } }, results({ isMaximizing: false }), 5, { a: 1 }, { a: 2 })
  assert.equal(res.bestValue, 3)
  assert.equal(res.isBestChanged, true)
})

test('a metric of zero is a real value, not a missing one', async () => {
  const { call } = backtestExtension()
  const res = await call('getResWithBestValue', { error: null, data: { 'Total PnL': 0 } }, results(), -5, { a: 1 }, { a: 2 })
  assert.equal(res.bestValue, 0)
  assert.equal(res.isFiltered, undefined)
})

test('a result below the filter is recorded as filtered, not as the best', async () => {
  const { call } = backtestExtension()
  const testResults = results({ filterAscending: true, filterParamName: 'Total trades: All', filterValue: 5 })
  const res = await call('getResWithBestValue', { error: null, data: { 'Total PnL': 100, 'Total trades: All': 2 } }, testResults, 1, { a: 1 }, { a: 2 })
  assert.equal(res.isFiltered, true)
  assert.equal(testResults.filteredSummary.length, 1)
  assert.equal(testResults.perfomanceSummary.length, 0, 'a filtered result never becomes the best')
  assert.match(String(res.currentValue), /filtered/)
})

test('a calculation error is recorded as ignored and does not change the best', async () => {
  const { call } = backtestExtension()
  const testResults = results()
  const res = await call('getResWithBestValue', { error: 2, data: {} }, testResults, 7, { a: 1 }, { a: 2 })
  assert.equal(res.isFiltered, true)
  assert.equal(testResults.perfomanceSummary.length, 0, 'an errored result never becomes the best')
  assert.equal(testResults.filteredSummary.length, 1)
  assert.match(String(res.currentValue), /missed in data/)
})

test('parameters with no trades are filtered without counting as missing data', async () => {
  const { call } = backtestExtension()
  const testResults = results({ missingOptParamStreak: 2 })
  const res = await call('getResWithBestValue', { error: null, isNoTrades: true, data: { comment: 'No trades' } }, testResults, 4, { a: 1 }, { a: 2 })
  assert.equal(res.isFiltered, true)
  assert.equal(testResults.missingOptParamStreak, 0)
  assert.equal(res.currentValue, 'no trades')
})

test('a stale report is filtered and marked as not recomputed', async () => {
  const { call } = backtestExtension()
  const testResults = results({ missingOptParamStreak: 2 })
  const res = await call('getResWithBestValue', { error: null, isStaleUnchanged: true, data: { 'Total PnL': 4 } }, testResults, 4, { a: 1 }, { a: 2 })
  assert.equal(res.isFiltered, true)
  assert.equal(testResults.missingOptParamStreak, 0)
  assert.match(String(res.data.comment), /WARNING: report not updated/)
})

test('a report whose metric name is unknown is reported, not counted as missing data', async () => {
  const { call } = backtestExtension()
  const testResults = results()
  const res = await call('getResWithBestValue', { error: null, data: { 'Profit factor': 1.5 } }, testResults, 4, { a: 1 }, { a: 2 })
  assert.equal(res.isFiltered, true)
  assert.equal(res.forceStop, false)
  assert.equal(testResults.missingOptParamStreak, 0)
  assert.match(String(res.message), /Profit factor/)
})

test('a run of empty reports stops the test instead of looping', async () => {
  const { call } = backtestExtension()
  const testResults = results({ missingOptParamStreak: 2 })
  const res = await call('getResWithBestValue', { error: null, data: { comment: 'report is empty' } }, testResults, 4, { a: 1 }, { a: 2 })
  assert.equal(res.forceStop, true)
  assert.equal(testResults.missingOptParamStreak, 3)
})

test('an empty report is treated as missing data, not as a result', async () => {
  const { call } = backtestExtension()
  const testResults = results()
  const res = await call('getResWithBestValue', { error: null, data: { comment: 'report is empty' } }, testResults, 4, { a: 1 }, { a: 2 })
  assert.equal(testResults.missingOptParamStreak, 1)
  assert.equal(testResults.filteredSummary.length, 1)
  assert.equal(res.forceStop, false)
})

test('the value shown to the user keeps two decimals and a plain zero', () => {
  const { backtest } = backtestExtension()
  assert.equal(backtest.convertValue(12.345), '12.35')
  assert.equal(backtest.convertValue(-0.004), '0.00')
  assert.equal(backtest.convertValue(0), '0')
  assert.equal(backtest.convertValue('text'), undefined)
  assert.equal(backtest.convertValue(true), 'true')
})

test('the random method changes one parameter at a time from the current state', () => {
  const { call } = backtestExtension()
  const allRangeParams = { a: [1, 2, 3], b: [10, 20] }
  const { data } = call('optRandomGetPropertiesValues', allRangeParams, { a: 1, b: 10 })
  assert.deepEqual(Object.keys(data).sort(), ['a', 'b'])
  const changed = ['a', 'b'].filter((key) => data[key] !== ({ a: 1, b: 10 })[key])
  assert.equal(changed.length, 1, 'exactly one parameter is different from the current state')
  assert.ok(allRangeParams[changed[0]].includes(data[changed[0]]))
})

test('a partial parameter set keeps the values it did not name', () => {
  const { backtest, call } = backtestExtension()
  const expanded = call('expandPropVal', { a: 2 }, { a: 1, b: 10 })
  assert.deepEqual(plain(expanded), { a: 2, b: 10 })
  assert.equal(typeof backtest.testStrategy, 'function')
})

test('brute force walks every combination and then reports the end', async () => {
  const { backtest, call } = backtestExtension()
  const seen = []
  backtest.getTestIterationResult = async (testResults, propVal) => {
    seen.push(`${propVal.a}/${propVal.b}`)
    return { error: null, data: { 'Total PnL': propVal.a + propVal.b } }
  }
  const testResults = results()
  const allRangeParams = { a: [1, 2], b: [10, 20] }
  const state = {}
  const combos = []
  for (let i = 0; i < 10; i++) {
    const res = await call('optBruteForce', allRangeParams, testResults, null, null, state)
    if (res === null) break
    combos.push(`${res.bestPropVal.a}/${res.bestPropVal.b}`)
  }
  assert.deepEqual(combos.sort(), ['1/10', '1/20', '2/10', '2/20'])
  assert.equal(seen.length, 4, 'each combination is tested once')
})

test('sequential improvement walks one parameter, skips the value already set and then ends', async () => {
  const { backtest, call } = backtestExtension()
  backtest.getTestIterationResult = async (testResults, propVal) => ({ error: null, data: { 'Total PnL': propVal.a + propVal.b } })
  const testResults = results()
  const allRangeParams = { a: [1, 2], b: [10, 20] }
  const state = {}
  const skipped = []
  let end = false
  for (let i = 0; i < 10; i++) {
    const res = await call('optSequentialIteration', allRangeParams, testResults, 11, { a: 1, b: 10 }, state)
    if (res === null) { end = true; break }
    if (res.data === undefined) skipped.push(res.message)
  }
  assert.equal(end, true)
  // The values equal to the current best are skipped instead of being tested again
  assert.equal(skipped.length, 2)
  assert.match(String(skipped[0]), /is skipped/)
})

test('the random method stays inside the declared ranges', async () => {
  const { backtest, call } = backtestExtension()
  const allRangeParams = { a: [1, 2, 3], b: [10, 20] }
  backtest.getTestIterationResult = async (testResults, propVal) => {
    assert.ok(allRangeParams.a.includes(propVal.a))
    assert.ok(allRangeParams.b.includes(propVal.b))
    return { error: null, data: { 'Total PnL': propVal.a } }
  }
  const testResults = results()
  for (let i = 0; i < 5; i++)
    await call('optAllRandomIteration', allRangeParams, testResults, null, null, {})
  assert.equal(testResults.perfomanceSummary.length, 5)
})

test('annealing cools down as the cycles go on', async () => {
  const { backtest, call } = backtestExtension()
  const allRangeParams = { a: [1, 2, 3], b: [10, 20] }
  backtest.getTestIterationResult = async (testResults, propVal) => ({ error: null, data: { 'Total PnL': propVal.a } })
  const testResults = results({ cycles: 10 })
  const state = {}
  await call('optAnnealingIteration', allRangeParams, testResults, null, null, state)
  const firstTemp = state.currentTemp
  assert.equal(firstTemp, 1)
  assert.equal(state.isInit, true)
  await call('optAnnealingIteration', allRangeParams, testResults, state.bestEnergy, state.bestState, state)
  assert.ok(state.currentTemp < firstTemp, 'the temperature decreases after a cycle')
  assert.equal(state.currentTemp, 0.9)
})

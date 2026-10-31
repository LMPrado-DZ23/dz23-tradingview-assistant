import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension, readCatalog } from './harness.mjs'

// metrics-options.js is the single list of TradingView report metrics the popup offers. A wrong or duplicated
// name means a filter or an optimization target that silently never matches.

function metrics () {
  const extension = loadExtension(['popup/metrics-options.js'])
  const { METRICS } = extension.api('METRICS')
  return { METRICS, extension }
}

const optionValues = (METRICS) => METRICS.GROUPS.flatMap((group) => group.options.map((option) => (Array.isArray(option) ? option[0] : option)))

test('no metric is offered twice', () => {
  const { METRICS } = metrics()
  const values = optionValues(METRICS)
  assert.equal(new Set(values).size, values.length)
  assert.equal(METRICS.ALL_VALUES.size, values.length)
})

test('the defaults are real metrics of the list', () => {
  const { METRICS } = metrics()
  assert.equal(METRICS.isValid(METRICS.DEFAULT_OPT_PARAM), true, METRICS.DEFAULT_OPT_PARAM)
  assert.equal(METRICS.isValid(METRICS.DEFAULT_FILTER_PARAM), true, METRICS.DEFAULT_FILTER_PARAM)
  assert.equal(METRICS.isValid('Not a metric'), false)
})

test('every group caption is a message of both catalogs', () => {
  const { METRICS } = metrics()
  const en = readCatalog('en')
  const pt = readCatalog('pt_BR')
  for (const group of METRICS.GROUPS) {
    assert.ok(en[group.headerKey], `${group.headerKey} is missing in en`)
    assert.ok(pt[group.headerKey], `${group.headerKey} is missing in pt_BR`)
  }
})

test('every group has options and no empty label', () => {
  const { METRICS } = metrics()
  for (const group of METRICS.GROUPS) {
    assert.ok(group.options.length > 0, `${group.headerKey} has no options`)
    for (const option of group.options) {
      const label = Array.isArray(option) ? option[1] : option
      assert.ok(label && label.trim(), `${group.headerKey} has an empty label`)
    }
  }
})

test('the popup select gets one disabled caption per group and one option per metric', () => {
  const { METRICS, extension } = metrics()
  const select = extension.evaluate('document.createElement("select")')
  METRICS.populate(select, METRICS.DEFAULT_OPT_PARAM)

  const expected = METRICS.GROUPS.length + optionValues(METRICS).length
  assert.equal(select.children.length, expected)
  assert.equal(select.value, METRICS.DEFAULT_OPT_PARAM)

  const captions = select.children.filter((child) => child.disabled)
  assert.equal(captions.length, METRICS.GROUPS.length)
  // The popup replaces a caption with its translated text after loading
  for (const caption of captions)
    assert.equal(typeof caption.textContent, 'string')
})

test('a missing select is ignored instead of throwing', () => {
  const { METRICS } = metrics()
  assert.doesNotThrow(() => METRICS.populate(null, METRICS.DEFAULT_OPT_PARAM))
})

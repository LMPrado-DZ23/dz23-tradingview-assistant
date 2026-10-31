import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension } from './harness.mjs'

// The manifest order is the load order of the real extension
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
  'content_scripts/action.js',
]

test('every content script initializes in a clean page world', () => {
  for (const file of CONTENT_SCRIPTS) {
    const extension = loadExtension([file])
    const name = file.split('/').pop()
    assert.ok(extension.context, `${name} must not throw at load`)
  }
})

test('the scripts of one tab share their objects, as the browser does', () => {
  const extension = loadExtension(CONTENT_SCRIPTS)
  const api = extension.api(['SEL', 'page', 'ui', 'tv', 'tvChart', 'file', 'storage', 'signal', 'model', 'backtest', 'action'])

  assert.equal(typeof api.SEL.reportRoot, 'string')
  assert.equal(typeof api.page.waitForSelector, 'function')
  assert.equal(typeof api.ui.showErrorByKind, 'function')
  assert.equal(typeof api.tv.getPerformance, 'function')
  assert.equal(typeof api.tvChart.detectDeepTest, 'function')
  assert.equal(typeof api.file.parseCSV, 'function')
  assert.equal(typeof api.storage.getKey, 'function')
  assert.equal(typeof api.signal.parseTSSignalsAndGetMsg, 'function')
  assert.equal(typeof api.model.getStrategyRange, 'function')
  assert.equal(typeof api.backtest.testStrategy, 'function')
  assert.equal(typeof api.action.testStrategy, 'function')
})

test('controller.js starts only once, and it waits for a strategy dialog without blocking', () => {
  const extension = loadExtension(CONTENT_SCRIPTS)
  // The controller runs an endless `waitForSelector(..., 0)` for the dialog: in a page without one it parks
  extension.evaluate('page.waitForSelector = async () => null')
  extension.runFile('content_scripts/controller.js')
  assert.equal(typeof extension.evaluate('typeof page.waitForSelector'), 'string')
})

test('the message gate of the page-context script is registered on window', () => {
  const extension = loadExtension(['page-context.js'], { defaults: false })
  assert.equal(extension.windowListeners.length, 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension } from './harness.mjs'

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

const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

test('a chart page loads only the page-context script, not the 3.6 MB chart library', () => {
  const extension = loadExtension(CONTENT_SCRIPTS)
  const sources = extension.injectedScripts.map((element) => element.src)
  assert.equal(sources.length, 1, 'only page-context.js is injected at load')
  assert.match(sources[0], /page-context\.js$/)
})

test('the 3D chart loads Plotly once, on first use', async () => {
  const extension = loadExtension(CONTENT_SCRIPTS)
  const { tv } = extension.api('tv')

  const loading = tv.ensurePlotly(50)
  const injected = extension.injectedScripts.at(-1)
  assert.match(injected.src, /plotly\.min\.js$/)
  injected.onload()
  assert.equal(await loading, true)

  // A second call reuses the loaded script instead of injecting a second copy
  assert.equal(await tv.ensurePlotly(50), true)
  assert.equal(extension.injectedScripts.length, 2)
})

test('a failed Plotly load is reported, and the 3D chart is not opened', async () => {
  const extension = loadExtension(CONTENT_SCRIPTS, {
    storage: {
      iondv_strategy_result: {
        perfomanceSummary: [{ 'Total PnL': 10 }],
        paramsNames: ['length'],
        optParamName: 'Total PnL',
      },
    },
  })
  const { tv, action } = extension.api(['tv', 'action'])
  let popup = null
  const { ui } = extension.api('ui')
  ui.showIssuePopup = async (text) => { popup = text }

  const loading = tv.ensurePlotly(10)
  extension.injectedScripts.at(-1).onerror()
  assert.equal(await loading, false)
  await action.show3DChart()
  assert.ok(popup, 'the user is told that the 3D chart is unavailable')
  assert.equal(extension.pageMessages.length, 0, 'no chart request is sent to the page')
})

test('clearing all stored data asks first and does nothing when cancelled', async () => {
  const extension = loadExtension(CONTENT_SCRIPTS, {
    storage: { iondv_strategy_result: { perfomanceSummary: [] }, iondv_strategy_param: { a: 1 } },
  })
  const { action } = extension.api('action')
  const { ui } = extension.api('ui')
  const prompts = []
  ui.alertPopup = async (text, isError, isConfirm) => { prompts.push({ isError, isConfirm }); return false }
  ui.showPopup = async () => { throw new Error('no confirmation popup after a cancel') }

  await action.clearAll()
  assert.deepEqual(prompts, [{ isError: false, isConfirm: true }])
  assert.deepEqual(plain(Object.keys(extension.storageArea.data)).sort(), ['iondv_strategy_param', 'iondv_strategy_result'])
})

test('clearing all stored data removes it after the user confirms', async () => {
  const extension = loadExtension(CONTENT_SCRIPTS, {
    storage: { iondv_strategy_result: { perfomanceSummary: [] }, iondv_keep_other: 1, unrelated: 2 },
  })
  const { action } = extension.api('action')
  const { ui } = extension.api('ui')
  let shown = null
  ui.alertPopup = async () => true
  ui.showPopup = async (text) => { shown = text }

  await action.clearAll()
  assert.deepEqual(plain(Object.keys(extension.storageArea.data)), ['unrelated'])
  assert.match(shown, /iondv_strategy_result/)
})

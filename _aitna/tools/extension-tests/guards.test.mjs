import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension, PAGE_ORIGIN } from './harness.mjs'

// The message gate is the boundary between the TradingView page and the extension: a forged event must not
// reach a handler, and a message the script does not know must not crash it.

function pageContext () {
  const extension = loadExtension(['page-context.js'], { defaults: false })
  return {
    extension,
    window: extension.evaluate('window'),
    send (event) { return extension.dispatchWindowMessage(event) },
    responses: () => extension.pageMessages,
  }
}

test('a message from another origin is ignored, including a look-alike domain', async () => {
  const page = pageContext()
  for (const origin of ['https://evil.example', 'https://www.tradingview.com.evil.example', 'null']) {
    await page.send({
      origin,
      source: page.window,
      data: { name: 'iondvScript', action: 'getPerformance' },
    })
    assert.deepEqual(page.responses(), [], `origin "${origin}" must not be answered`)
  }
})

test('a message from another window is ignored', async () => {
  const page = pageContext()
  await page.send({
    origin: PAGE_ORIGIN,
    source: {},
    data: { name: 'iondvScript', action: 'getPerformance' },
  })
  assert.deepEqual(page.responses(), [])
})

test('a message from this page is answered', async () => {
  const page = pageContext()
  await page.send({
    origin: PAGE_ORIGIN,
    source: page.window,
    data: { name: 'iondvScript', action: 'getPerformance' },
  })
  assert.equal(page.responses().length, 1)
  assert.equal(page.responses()[0].name, 'iondvPage')
  assert.equal(page.responses()[0].action, 'getPerformance')
  // The page has no TradingView objects in this test, so the handler fails: the answer carries a stable code
  assert.equal(page.responses()[0].code, 'handler_failed')
})

test('an unknown action is answered with an error instead of throwing', async () => {
  const page = pageContext()
  const settled = await page.send({
    origin: PAGE_ORIGIN,
    source: page.window,
    data: { name: 'iondvScript', action: 'noSuchAction' },
  })
  assert.deepEqual(settled.map((result) => result.status), ['fulfilled'])
  assert.equal(page.responses().length, 1)
  assert.equal(page.responses()[0].code, 'unknown_action')
  assert.match(String(page.responses()[0].message), /noSuchAction/)
})

test('a message that is not from this extension is ignored', async () => {
  const page = pageContext()
  await page.send({ origin: PAGE_ORIGIN, source: page.window, data: { name: 'other', action: 'getPerformance' } })
  await page.send({ origin: PAGE_ORIGIN, source: page.window, data: null })
  assert.deepEqual(page.responses(), [])
})

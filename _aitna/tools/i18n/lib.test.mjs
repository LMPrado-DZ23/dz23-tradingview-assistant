import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkCatalogEntries,
  checkTranslationParity,
  checkUsage,
  extractKeys,
  formatCatalog,
  placeholdersOf,
  summarize,
  toCatalogMap,
} from './lib.mjs'

const catalog = (entries) => new Map(Object.entries(entries))

test('extractKeys finds every reference form', () => {
  const source = [
    "await ui.showPopup(i18n.t('action_saved'))",
    'const text = i18n.t(\n  "tv_no_panel"\n)',
    '<p data-i18n="popup_run_desc">x</p>',
    '<p data-i18n-html="popup_tv_english_html">x</p>',
    '<button data-i18n-title="popup_whats_new_title">x</button>',
    '"name": "__MSG_ext_name__"',
  ].join('\n')
  assert.deepEqual(extractKeys(source),
    ['action_saved', 'tv_no_panel', 'popup_run_desc', 'popup_tv_english_html', 'popup_whats_new_title', 'ext_name'])
})

test('extractKeys reports a key once', () => {
  assert.deepEqual(extractKeys("i18n.t('dup'); i18n.t('dup')"), ['dup'])
})

test('placeholdersOf returns sorted unique positional indexes', () => {
  assert.deepEqual(placeholdersOf('a {1} b {0} c {1}'), [0, 1])
  assert.deepEqual(placeholdersOf('plain text'), [])
})

test('toCatalogMap reads the chrome.i18n value shape', () => {
  const map = toCatalogMap({ a: { message: 'A' }, b: { message: 'B', description: 'note' } })
  assert.equal(map.get('a'), 'A')
  assert.equal(map.get('b'), 'B')
})

test('checkCatalogEntries rejects unusable entries', () => {
  const problems = checkCatalogEntries(catalog({
    'bad.key': 'x',
    'empty_one': '   ',
    'dollar_one': 'costs $5',
    'good_key': 'ok',
  }), 'en')
  assert.deepEqual(problems.map((problem) => problem.code), ['key_charset', 'empty_message', 'reserved_character'])
})

test('checkTranslationParity is silent for a matching translation', () => {
  const problems = checkTranslationParity(new Map([
    ['en', catalog({ a: 'Hello {0}', b: 'No placeholder' })],
    ['pt_BR', catalog({ a: 'Olá {0}', b: 'Sem marcador' })],
  ]))
  assert.deepEqual(problems, [])
})

test('checkTranslationParity reports missing, unknown and mismatched keys', () => {
  const problems = checkTranslationParity(new Map([
    ['en', catalog({ shared: 'Hello {0}', only_en: 'X', reordered: '{0} of {1}' })],
    ['pt_BR', catalog({ shared: 'Olá', only_pt: 'Y', reordered: '{1} de {0}' })],
  ]))
  const codes = problems.map((problem) => problem.code)
  assert.ok(codes.includes('missing_translation'), 'a key absent from pt_BR is reported')
  assert.ok(codes.includes('unknown_key'), 'a key absent from en is reported')
  assert.ok(codes.includes('placeholder_mismatch'))
  // Only "only_en" is absent from pt_BR; "shared" and "reordered" exist on both sides
  assert.equal(problems.filter((problem) => problem.code === 'missing_translation').length, 1)
  assert.ok(problems.every((problem) => problem.level === 'error'))
})

test('checkTranslationParity requires the reference catalog', () => {
  const problems = checkTranslationParity(new Map([['pt_BR', catalog({ a: 'x' })]]))
  assert.deepEqual(problems.map((problem) => problem.code), ['reference_missing'])
})

test('checkUsage reports unknown references as errors and unused keys as warnings', () => {
  const problems = checkUsage(
    [{ key: 'used', file: 'popup/assistant.js' }, { key: 'ghost', file: 'content_scripts/tv.js' }],
    catalog({ used: 'Used', orphan: 'Nobody' }))
  assert.deepEqual(problems.map((problem) => [problem.level, problem.code]), [
    ['error', 'missing_key'],
    ['warning', 'orphan_key'],
  ])
  assert.match(problems[0].message, /tv\.js/)
})

test('formatCatalog round-trips through JSON and keeps one message per line', () => {
  const text = formatCatalog(catalog({ one: 'Line\nbreak', two: 'Quote "x"' }))
  // "{", one line per message, "}" and the empty tail after the final newline
  assert.equal(text.split('\n').length, 5)
  const parsed = JSON.parse(text)
  assert.equal(parsed.one.message, 'Line\nbreak')
  assert.equal(parsed.two.message, 'Quote "x"')
})

test('summarize counts by level', () => {
  assert.deepEqual(summarize([
    { level: 'error', message: 'a' },
    { level: 'warning', message: 'b' },
    { level: 'error', message: 'c' },
  ]), { errors: 2, warnings: 1 })
})

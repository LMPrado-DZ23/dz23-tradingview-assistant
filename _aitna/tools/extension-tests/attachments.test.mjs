import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ALLOWED_TYPES,
  ATTACHMENT_LIMITS,
  attachmentSummary,
  attachmentText,
  normaliseType,
  renderForMessage,
  validateFile,
} from '../../../extension/copilot/attachments.js'

// The attachment boundary keeps binaries and oversized files out of the chat; each limit has a test.

test('a CSV of a few KB is accepted', () => {
  const result = validateFile({ name: 'resultados.csv', type: 'text/csv', size: 2048 })
  assert.equal(result.ok, true)
  assert.equal(result.type, 'text/csv')
})

test('a binary or an executable is refused by type', () => {
  for (const type of ['image/png', 'application/pdf', 'application/x-msdownload', 'application/zip']) {
    const result = validateFile({ name: 'x.bin', type, size: 100 })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'type')
  }
})

test('a text file sent with an empty MIME type is accepted by its extension', () => {
  assert.equal(validateFile({ name: 'notas.txt', type: '', size: 10 }).ok, true)
  assert.equal(validateFile({ name: 'dados.JSON', type: '', size: 10 }).type, 'application/json')
  assert.equal(validateFile({ name: 'LEIAME.MD', type: '', size: 10 }).type, 'text/markdown')
})

test('an extensionless binary without a useful MIME type is refused', () => {
  const result = validateFile({ name: 'programa', type: 'application/octet-stream', size: 10 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'type')
})

test('the size limit is enforced and named in the message', () => {
  const result = validateFile({ name: 'grande.csv', type: 'text/csv', size: ATTACHMENT_LIMITS.maxBytes + 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'size')
  assert.match(result.message, /limite/)
})

test('an empty file and an impossible size are refused', () => {
  assert.equal(validateFile({ name: 'a.txt', type: 'text/plain', size: 0 }).code, 'empty')
  assert.equal(validateFile({ name: 'a.txt', type: 'text/plain', size: Number.NaN }).code, 'empty')
})

test('the number of attachments is capped', () => {
  const result = validateFile({ name: 'a.txt', type: 'text/plain', size: 10 }, { count: ATTACHMENT_LIMITS.maxCount })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'count')
})

test('a long attachment is truncated with an explicit marker', () => {
  const result = attachmentText('notas.txt', 'x'.repeat(50), { maxChars: 10 })
  assert.equal(result.truncated, true)
  assert.equal(result.chars, 50)
  assert.match(result.text, /truncado em 10 caracteres de 50/)
})

test('a short attachment is passed through unchanged', () => {
  const result = attachmentText('a.txt', 'linha 1\nlinha 2')
  assert.equal(result.truncated, false)
  assert.equal(result.text, 'linha 1\nlinha 2')
})

test('the message block names the file and fences the content', () => {
  const text = renderForMessage({ name: 'x.csv', text: 'a,b\n1,2' })
  assert.match(text, /^\[anexo: x\.csv\]\n```\na,b\n1,2\n```$/)
})

test('the chip summarises name, size and truncation', () => {
  assert.equal(attachmentSummary({ name: 'a.csv', chars: 2048, truncated: false }), 'a.csv · 2 KB')
  assert.match(attachmentSummary({ name: 'a.csv', chars: 30_000, truncated: true }), /truncado/)
})

test('the allowed list is exactly the text formats the product claims', () => {
  assert.deepEqual(ALLOWED_TYPES, ['text/plain', 'text/csv', 'text/markdown', 'application/json'])
  assert.equal(normaliseType('a.csv', 'TEXT/CSV; charset=utf-8'), 'text/csv')
})

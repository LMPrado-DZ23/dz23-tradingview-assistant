import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATE_VERSION,
  emptyState,
  findConversation,
  mostRecent,
  readState,
  writeState,
} from '../../../extension/copilot/conversations.js'

// A chat that loses its history on one bad write is unusable: each recovery rule has a test.

const conversation = (overrides = {}) => ({
  id: 'c1',
  title: 'Sobre BTC',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-02T00:00:00.000Z',
  context: { asset: 'BTCUSDT', timeframe: '1h', strategy: 'smc', notes: '' },
  messages: [{ role: 'user', content: 'oi', at: '2025-01-01T00:00:00.000Z' }],
  ...overrides,
})

test('a clean state round-trips', () => {
  const state = { ...emptyState(), conversations: [conversation()], activeId: 'c1' }
  const { json } = writeState(state)
  const read = readState(json)
  assert.equal(read.repaired, false)
  assert.equal(read.state.conversations.length, 1)
  assert.equal(read.state.activeId, 'c1')
  assert.equal(read.state.version, STATE_VERSION)
})

test('a corrupt entry does not throw and does not erase storage', () => {
  const read = readState('{not json')
  assert.equal(read.repaired, true)
  assert.equal(read.reason, 'corrupt json')
  assert.deepEqual(read.state.conversations, [])
  assert.equal(read.state.version, STATE_VERSION)
})

test('an older schema is migrated and marked as repaired', () => {
  const old = JSON.stringify({ version: 1, conversations: [conversation()], activeId: 'c1', settings: { gatewayUrl: 'http://x' } })
  const read = readState(old)
  assert.equal(read.state.version, STATE_VERSION)
  assert.equal(read.state.conversations.length, 1, 'the conversations survive the migration')
  assert.equal(read.state.settings.user, 'local', 'a new setting gets its default')
  assert.match(read.reason, /migrado/)
})

test('a malformed conversation is dropped, the others stay', () => {
  const raw = JSON.stringify({
    version: STATE_VERSION,
    conversations: [conversation(), { id: '', messages: [] }, { noId: true }, conversation({ id: 'c2' })],
    activeId: 'c2',
  })
  const read = readState(raw)
  assert.deepEqual(read.state.conversations.map((item) => item.id), ['c1', 'c2'])
  assert.match(read.reason, /2 conversa/)
})

test('a duplicated id keeps only the first conversation', () => {
  const raw = JSON.stringify({ version: STATE_VERSION, conversations: [conversation(), conversation({ title: 'duplicada' })] })
  const read = readState(raw)
  assert.equal(read.state.conversations.length, 1)
  assert.equal(read.state.conversations[0].title, 'Sobre BTC')
})

test('invalid messages are dropped and a huge one is clamped', () => {
  const raw = JSON.stringify({
    version: STATE_VERSION,
    conversations: [conversation({
      messages: [
        { role: 'user', content: 'ok' },
        { role: 'tool', content: 'papel inválido' },
        { role: 'assistant', content: 42 },
        { role: 'assistant', content: 'x'.repeat(300_000) },
      ],
    })],
  })
  const read = readState(raw)
  const messages = read.state.conversations[0].messages
  assert.equal(messages.length, 2)
  assert.equal(messages[1].content.length, 200_000)
  assert.equal(messages[1].streaming, false, 'a reload never resumes a stream that is gone')
})

test('an activeId pointing to a missing conversation falls back to the first', () => {
  const raw = JSON.stringify({ version: STATE_VERSION, conversations: [conversation()], activeId: 'fantasma' })
  const read = readState(raw)
  assert.equal(read.state.activeId, 'c1')
  assert.equal(read.repaired, true)
})

test('empty or non-JSON input yields the defaults without repair noise', () => {
  assert.equal(readState('').reason, 'empty')
  assert.equal(readState(null).reason, 'empty')
  assert.equal(readState('[]').repaired, true)
})

test('lookups work by id and by recency', () => {
  const state = {
    ...emptyState(),
    conversations: [
      conversation({ id: 'velha', updatedAt: '2025-01-01T00:00:00.000Z' }),
      conversation({ id: 'nova', updatedAt: '2025-02-01T00:00:00.000Z' }),
    ],
  }
  assert.equal(findConversation(state, 'nova').id, 'nova')
  assert.equal(findConversation(state, 'x'), null)
  assert.equal(mostRecent(state).id, 'nova')
  assert.equal(mostRecent({ conversations: [] }), null)
})

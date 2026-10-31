import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMemory, memoryBlock, memoryKey } from '../../../extension/copilot/memory.js'

// Memory is only useful if it cannot leak across users or strategies: that isolation is what these tests pin.

function fakeStorage (initial = {}) {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: (key) => { data.delete(key) },
    key: (index) => [...data.keys()][index] ?? null,
    get length () { return data.size },
    dump: () => Object.fromEntries(data),
  }
}

test('the namespace contains both the user and the strategy', () => {
  assert.equal(memoryKey('Leandro', 'smc-breakout'), 'dz23.memory.v1:leandro:smc-breakout')
  assert.notEqual(memoryKey('leandro', 'smc'), memoryKey('leandro', 'smc-v2'))
  assert.equal(memoryKey('', ''), 'dz23.memory.v1:default:default')
})

test('a note is stored and read back for the same user and strategy', () => {
  const memory = createMemory(fakeStorage())
  const added = memory.add('leandro', 'smc', 'não operar em notícia de CPI')
  assert.equal(added.ok, true)
  assert.deepEqual(memory.list('leandro', 'smc'), ['não operar em notícia de CPI'])
})

test('a strategy never sees the memory of another strategy', () => {
  const memory = createMemory(fakeStorage())
  memory.add('leandro', 'smc', 'regra do SMC')
  memory.add('leandro', 'vwap', 'regra do VWAP')
  assert.deepEqual(memory.list('leandro', 'smc'), ['regra do SMC'])
  assert.deepEqual(memory.list('leandro', 'vwap'), ['regra do VWAP'])
  assert.deepEqual(memory.list('leandro', 'outra'), [])
})

test('a user never sees the memory of another user', () => {
  const memory = createMemory(fakeStorage())
  memory.add('leandro', 'smc', 'nota do leandro')
  memory.add('convidado', 'smc', 'nota do convidado')
  assert.deepEqual(memory.list('leandro', 'smc'), ['nota do leandro'])
  assert.deepEqual(memory.list('convidado', 'smc'), ['nota do convidado'])
  assert.deepEqual(memory.list('outro', 'smc'), [])
})

test('the strategies of one user are listed without the others', () => {
  const memory = createMemory(fakeStorage())
  memory.add('leandro', 'smc', 'a')
  memory.add('leandro', 'vwap', 'b')
  memory.add('convidado', 'orb', 'c')
  assert.deepEqual(memory.strategies('leandro'), ['smc', 'vwap'])
  assert.deepEqual(memory.strategies('convidado'), ['orb'])
})

test('a duplicate note is not stored twice', () => {
  const memory = createMemory(fakeStorage())
  memory.add('u', 's', 'sempre conferir o spread')
  const again = memory.add('u', 's', '  sempre conferir o spread  ')
  assert.equal(again.duplicated, true)
  assert.equal(memory.list('u', 's').length, 1)
})

test('replace and clear work only on the named namespace', () => {
  const memory = createMemory(fakeStorage())
  memory.add('u', 'a', 'x')
  memory.add('u', 'b', 'y')
  memory.replace('u', 'a', ['um', 'dois'])
  assert.deepEqual(memory.list('u', 'a'), ['um', 'dois'])
  assert.deepEqual(memory.list('u', 'b'), ['y'])
  memory.clear('u', 'a')
  assert.deepEqual(memory.list('u', 'a'), [])
  assert.deepEqual(memory.list('u', 'b'), ['y'])
})

test('an empty note is refused, and a long note is clamped', () => {
  const memory = createMemory(fakeStorage(), { maxNoteLength: 10 })
  assert.equal(memory.add('u', 's', '   ').ok, false)
  memory.add('u', 's', 'x'.repeat(50))
  assert.equal(memory.list('u', 's')[0].length, 10)
})

test('a corrupt or older entry is dropped instead of breaking the chat', () => {
  const storage = fakeStorage({ 'dz23.memory.v1:u:s': '{not json', 'dz23.memory.v0:u:s': '{"version":0,"notes":["velho"]}' })
  const memory = createMemory(storage)
  assert.deepEqual(memory.list('u', 's'), [])
  const wrongVersion = fakeStorage({ 'dz23.memory.v1:u:s2': JSON.stringify({ version: 99, notes: ['x'] }) })
  assert.deepEqual(createMemory(wrongVersion).list('u', 's2'), [])
})

test('without storage the memory degrades to empty instead of throwing', () => {
  const memory = createMemory(null)
  assert.equal(memory.available, false)
  assert.deepEqual(memory.list('u', 's'), [])
  assert.equal(memory.add('u', 's', 'x').ok, false)
  assert.deepEqual(memory.strategies('u'), [])
})

test('the prompt block only appears when there is memory', () => {
  assert.equal(memoryBlock([]), '')
  assert.equal(memoryBlock(null), '')
  assert.match(memoryBlock(['a', 'b']), /Memória desta estratégia[\s\S]*^- a$/m)
})

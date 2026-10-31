import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadExtension } from './harness.mjs'

// storage.js is the persistence layer of every result: a wrong key means silently lost or orphaned data.

// Values created inside the extension context belong to another realm: compare their data, not their prototypes
const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

function storageExtension (initial = {}) {
  const extension = loadExtension(['content_scripts/storage.js'], { storage: initial })
  const { storage } = extension.api('storage')
  return { storage, area: extension.storageArea }
}

test('a single key is written and read with the iondv prefix', async () => {
  const { storage, area } = storageExtension()
  await storage.setKeys('strategy_param', { a: 1 })
  assert.deepEqual(plain(area.data), { iondv_strategy_param: { a: 1 } })
  assert.deepEqual(plain(await storage.getKey('strategy_param')), { a: 1 })
})

test('a missing key resolves to null', async () => {
  const { storage } = storageExtension()
  assert.equal(await storage.getKey('unknown'), null)
})

test('an array of keys resolves each existing value under its full key', async () => {
  const { storage } = storageExtension({ iondv_one: 1, iondv_two: 2, other: 3 })
  assert.deepEqual(plain(await storage.getKey(['one', 'two', 'three'])), { iondv_one: 1, iondv_two: 2 })
})

test('reading everything returns only the keys of this extension', async () => {
  const { storage } = storageExtension({ iondv_one: 1, other: 3 })
  assert.deepEqual(plain(await storage.getKey(null)), { iondv_one: 1 })
})

test('removing a key removes its prefixed entry, not a bare one', async () => {
  const { storage, area } = storageExtension({ iondv_strategy_param: { a: 1 }, iondv_keep: true })
  await storage.removeKey('strategy_param')
  assert.deepEqual(plain(area.data), { iondv_keep: true })
})

test('clearAll removes only the keys of this extension and reports them', async () => {
  const { storage, area } = storageExtension({ iondv_one: 1, iondv_two: 2, other: 3 })
  const removed = await storage.clearAll()
  assert.deepEqual(plain(removed).sort(), ['iondv_one', 'iondv_two'])
  assert.deepEqual(plain(area.data), { other: 3 })
})

test('clearAll on an empty storage returns no keys and does not fail', async () => {
  const { storage, area } = storageExtension({ other: 3 })
  assert.deepEqual(plain(await storage.clearAll()), [])
  assert.deepEqual(plain(area.data), { other: 3 })
})

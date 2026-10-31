// Memory under failure and isolation: the paths that were uncovered, plus the guarantee the module claims in its header
// ("memory never mixes strategies or users"). A storage that refuses to write must not break the chat, and a namespace
// that is not named must not be visible.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemory, memoryKey, MEMORY_VERSION } from '../../../extension/copilot/memory.js'

function mapStorage () {
  const data = new Map()
  return {
    data,
    get length () { return data.size },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: (key) => { data.delete(key) },
  }
}

test('a chave de memória separa usuário e estratégia, e normaliza caixa/espaços', () => {
  assert.equal(memoryKey(' Ana ', 'Breakout 20'), memoryKey('ana', 'breakout-20'))
  assert.notEqual(memoryKey('ana', 'a'), memoryKey('ana', 'b'), 'estratégia faz parte da chave')
  assert.notEqual(memoryKey('ana', 'a'), memoryKey('bruno', 'a'), 'usuário faz parte da chave')
  assert.match(memoryKey('', ''), new RegExp(`^dz23\\.memory\\.v${MEMORY_VERSION}:default:default$`))
})

test('memória de um usuário não é visível para outro (isolamento real, não filtro)', () => {
  const storage = mapStorage()
  const ana = createMemory(storage)
  ana.add('ana', 'breakout', 'rompeu a máxima de 20 dias')
  const bruno = createMemory(storage)
  assert.deepEqual(bruno.list('bruno', 'breakout'), [])
  assert.equal(bruno.strategies('bruno').length, 0)
  assert.deepEqual(ana.list('ana', 'breakout'), ['rompeu a máxima de 20 dias'])
})

test('storage que recusa gravar devolve falha sem lançar (chat continua)', () => {
  const broken = {
    length: 0,
    key: () => null,
    getItem: () => null,
    setItem () { throw new Error('quota exceeded') },
    removeItem () { throw new Error('read-only') },
  }
  const memory = createMemory(broken)
  const saved = memory.add('ana', 'breakout', 'nota')
  assert.equal(saved.ok, false, 'gravação recusada é reportada')
  assert.ok(saved.reason, 'com motivo')
  const removed = memory.clear('ana', 'breakout')
  if (removed)
    assert.equal(removed.ok, false, 'remoção recusada também é reportada')
})

test('storage ausente (null) mantém a sessão funcional: guarda em memória, não persiste', () => {
  const memory = createMemory(null)
  const saved = memory.add('ana', 'breakout', 'sem storage')
  assert.equal(saved.ok, false)
  assert.match(String(saved.reason), /unavailable/i, 'sem storage a gravação é recusada com motivo, sem lançar')
  assert.deepEqual(memory.list('ana', 'breakout'), [], 'nada é inventado sem storage')
})

test('entrada corrompida no storage é descartada, não propaga erro', () => {
  const storage = mapStorage()
  storage.setItem(memoryKey('ana', 'breakout'), '{isso não é json')
  const memory = createMemory(storage)
  assert.deepEqual(memory.list('ana', 'breakout'), [])
})

test('limite de notas e de tamanho é aplicado', () => {
  const memory = createMemory(mapStorage(), { maxNotes: 3, maxNoteLength: 20 })
  for (let index = 0; index < 6; index += 1)
    memory.add('ana', 'breakout', `nota ${index}`)
  const recalled = memory.list('ana', 'breakout')
  assert.ok(recalled.length <= 3, `guardou ${recalled.length}; o limite é 3`)
  const longNote = memory.add('ana', 'breakout', 'x'.repeat(500))
  assert.equal(longNote.ok, true)
  const stored = memory.list('ana', 'breakout')
  assert.ok(stored.every((note) => note.length <= 20), 'texto é truncado ao limite')
})

test('listar estratégias não vaza namespace de outro usuário', () => {
  const storage = mapStorage()
  const memory = createMemory(storage)
  memory.add('ana', 'breakout', 'a')
  memory.add('ana', 'pullback', 'b')
  memory.add('bruno', 'breakout', 'c')
  const anaStrategies = memory.strategies('ana')
  assert.ok(anaStrategies.includes('breakout'))
  assert.ok(anaStrategies.includes('pullback'))
  assert.equal(memory.strategies('bruno').includes('pullback'), false, 'pullback é só da ana')
})

test('sem storage explícito usa o localStorage do navegador (caminho real do painel)', () => {
  const fake = mapStorage()
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: fake })
  try {
    const memory = createMemory()
    assert.equal(memory.available, true, 'localStorage presente é usado por padrão')
    const saved = memory.add('ana', 'breakout', 'do navegador')
    assert.equal(saved.ok, true)
    assert.deepEqual(memory.list('ana', 'breakout'), ['do navegador'])
    assert.ok(fake.data.has(memoryKey('ana', 'breakout')), 'gravou na chave do namespace')
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else
      delete globalThis.localStorage
  }
})

test('localStorage que lança no acesso não impede criar a memória (modo privado/quota)', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get () { throw new Error('access denied') },
  })
  try {
    const memory = createMemory()
    assert.equal(memory.available, false, 'sem acesso ao storage a memória fica efêmera')
    assert.deepEqual(memory.list('ana', 'breakout'), [])
    assert.equal(memory.add('ana', 'breakout', 'x').ok, false)
  } finally {
    if (descriptor)
      Object.defineProperty(globalThis, 'localStorage', descriptor)
    else
      delete globalThis.localStorage
  }
})

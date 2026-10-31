// DZ23 Copilot — memory per user and per strategy.
//
// The rule of the product is that memory never mixes strategies or users: everything is stored under a namespace
// that contains both, and a lookup that does not name them cannot see another namespace. The storage is injected
// (localStorage in the browser, a plain map in tests) and the schema is versioned, so a corrupt or older entry is
// dropped instead of breaking the chat.

export const MEMORY_VERSION = 1
const KEY_PREFIX = `dz23.memory.v${MEMORY_VERSION}`

function defaultStorage () {
  try {
    if (typeof localStorage !== 'undefined' && localStorage)
      return localStorage
  } catch {
    /* a browser context without storage: memory simply does not persist */
  }
  return null
}

const cleanPart = (value) => String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').slice(0, 60) || 'default'

// The namespace is the isolation guarantee: user and strategy are part of the key, not a filter on a shared list.
export function memoryKey (user, strategy) {
  return `${KEY_PREFIX}:${cleanPart(user)}:${cleanPart(strategy)}`
}

function read (storage, key) {
  try {
    const raw = storage.getItem(key)
    if (!raw)
      return { version: MEMORY_VERSION, notes: [] }
    const parsed = JSON.parse(raw)
    if (parsed?.version !== MEMORY_VERSION || !Array.isArray(parsed.notes))
      return { version: MEMORY_VERSION, notes: [] }
    return { version: MEMORY_VERSION, notes: parsed.notes.filter((note) => typeof note === 'string' && note.trim()) }
  } catch {
    return { version: MEMORY_VERSION, notes: [] }
  }
}

function write (storage, key, state) {
  try {
    storage.setItem(key, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}

export function createMemory (storage = defaultStorage(), { maxNotes = 50, maxNoteLength = 2000 } = {}) {
  const available = Boolean(storage)
  return {
    available,
    list (user, strategy) {
      if (!available) return []
      return read(storage, memoryKey(user, strategy)).notes
    },
    add (user, strategy, note) {
      const text = String(note ?? '').trim().slice(0, maxNoteLength)
      if (!available || !text)
        return { ok: false, reason: available ? 'empty note' : 'storage unavailable' }
      const key = memoryKey(user, strategy)
      const state = read(storage, key)
      if (state.notes.includes(text))
        return { ok: true, notes: state.notes, duplicated: true }
      state.notes = [...state.notes, text].slice(-maxNotes)
      return write(storage, key, state) ? { ok: true, notes: state.notes } : { ok: false, reason: 'storage write failed' }
    },
    replace (user, strategy, notes) {
      if (!available)
        return { ok: false, reason: 'storage unavailable' }
      const cleaned = [].concat(notes).map((note) => String(note ?? '').trim().slice(0, maxNoteLength)).filter(Boolean).slice(-maxNotes)
      return write(storage, memoryKey(user, strategy), { version: MEMORY_VERSION, notes: cleaned })
        ? { ok: true, notes: cleaned }
        : { ok: false, reason: 'storage write failed' }
    },
    clear (user, strategy) {
      if (!available)
        return { ok: false, reason: 'storage unavailable' }
      try {
        storage.removeItem(memoryKey(user, strategy))
        return { ok: true }
      } catch {
        return { ok: false, reason: 'storage remove failed' }
      }
    },
    // Every namespace this user owns, so a UI can list strategies without reading another user's memory
    strategies (user) {
      if (!available || typeof storage.length !== 'number' || typeof storage.key !== 'function')
        return []
      const prefix = `${KEY_PREFIX}:${cleanPart(user)}:`
      const found = []
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index)
        if (typeof key === 'string' && key.startsWith(prefix))
          found.push(key.slice(prefix.length))
      }
      return found.sort()
    },
  }
}

// The block that goes into the system prompt, so the user sees exactly what the model is told.
export function memoryBlock (notes) {
  if (!Array.isArray(notes) || !notes.length)
    return ''
  return ['Memória desta estratégia (fornecida pelo usuário):', ...notes.map((note) => `- ${note}`)].join('\n')
}

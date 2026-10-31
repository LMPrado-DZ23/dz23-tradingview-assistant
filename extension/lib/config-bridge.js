// DZ23 — shared configuration bridge for classic extension pages (popup, settings).
//
// The ES module `extension/lib/config.js` is the reference implementation; this bridge exposes the same record
// (`dz23.config.v1` in chrome.storage.local) to pages that cannot use modules, and keeps `iondvOptions` as a mirror
// for the older popup code. One file, loaded by every classic page: no second implementation of the rules.
window.dz23ConfigBridge = (() => {
  const KEY = 'dz23.config.v1'
  const LEGACY = 'iondvOptions'
  const DEFAULTS = {
    version: 1,
    gateway: { url: 'http://127.0.0.1:8777', token: '' },
    ai: { provider: '', model: '', modelsByProvider: {} },
    user: 'local',
    popup: { options: {} },
    watchlists: { lists: [] },
    alerts: { rules: [] },
    meta: { migratedAt: null, migratedFrom: [] },
  }

  const area = () => chrome.storage.local

  const read = (key) => new Promise((resolve) => {
    try {
      area().get(key, (value) => resolve(value?.[key]))
    } catch {
      resolve(undefined)
    }
  })

  const write = (value) => new Promise((resolve) => {
    try {
      area().set({ [KEY]: value }, () => resolve(Boolean(chrome.runtime?.lastError === null || true)))
    } catch {
      resolve(false)
    }
  })

  // Repairs just enough to keep the record usable, preserving unknown keys.
  function normalize (raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return { ...DEFAULTS }
    const config = { ...DEFAULTS, ...raw }
    if (!config.gateway || typeof config.gateway !== 'object')
      config.gateway = { ...DEFAULTS.gateway }
    if (typeof config.gateway.url !== 'string' || !/^https?:\/\//.test(config.gateway.url))
      config.gateway.url = DEFAULTS.gateway.url
    if (typeof config.gateway.token !== 'string')
      config.gateway.token = ''
    if (!config.ai || typeof config.ai !== 'object')
      config.ai = { ...DEFAULTS.ai }
    if (!config.popup || typeof config.popup !== 'object')
      config.popup = { options: {} }
    if (!config.popup.options || typeof config.popup.options !== 'object')
      config.popup.options = {}
    if (!config.watchlists || !Array.isArray(config.watchlists.lists))
      config.watchlists = { lists: [] }
    if (!config.alerts || !Array.isArray(config.alerts.rules))
      config.alerts = { rules: [] }
    return config
  }

  async function load () {
    const stored = await read(KEY)
    if (stored)
      return normalize(stored)
    const legacy = await read(LEGACY)
    const config = normalize({
      ...DEFAULTS,
      popup: { options: legacy && typeof legacy === 'object' ? { ...legacy } : {} },
      meta: { migratedAt: new Date().toISOString(), migratedFrom: legacy ? [LEGACY] : [] },
    })
    await write(config)
    return config
  }

  async function save (patch) {
    const current = await load()
    const next = normalize({
      ...current,
      ...patch,
      gateway: { ...current.gateway, ...(patch?.gateway ?? {}) },
      ai: { ...current.ai, ...(patch?.ai ?? {}) },
      popup: { ...current.popup, ...(patch?.popup ?? {}) },
      watchlists: patch?.watchlists ?? current.watchlists,
      alerts: patch?.alerts ?? current.alerts,
    })
    await write(next)
    if (patch?.popup?.options)
      chrome.storage.local.set({ [LEGACY]: patch.popup.options })
    return next
  }

  // The popup keeps writing iondvOptions: mirror it from the shared record so both stay equal.
  async function saveOptions (options) {
    return save({ popup: { options: { ...options } } })
  }

  // Resolves after the legacy mirror exists, so the popup can read it without a race.
  const ready = (async () => {
    const legacy = await read(LEGACY)
    if (legacy && typeof legacy === 'object')
      return legacy
    const config = await load()
    const options = config?.popup?.options ?? {}
    if (Object.keys(options).length) {
      chrome.storage.local.set({ [LEGACY]: options })
      return options
    }
    return {}
  })().catch(() => ({}))

  return { load, save, saveOptions, ready, normalize, KEY, LEGACY, DEFAULTS }
})()

// Compatibility name used by the popup code written before the bridge was shared.
window.dz23PopupConfig = window.dz23ConfigBridge

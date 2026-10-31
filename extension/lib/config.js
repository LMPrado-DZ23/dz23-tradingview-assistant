// DZ23 — one configuration service for every surface of the extension.
//
// Before this module the copilot kept its settings in localStorage (`dz23.copilot.v2`) and the popup kept its own in
// chrome.storage.local (`iondvOptions`), so the two could disagree. Now `dz23.config.v1` in chrome.storage.local is the
// single source of truth; both legacy shapes are migrated once, idempotently, and are never deleted by this code.
//
// Contract:
//   load()   -> { config, migrated, issues, recovered }   never throws, always returns a valid config
//   save(p)  -> { config, issues }                        deep-merges a patch over the current config
//   toSettings(config) / fromSettings(settings, base)     the copilot's flat view of the same data
//
// Everything here is pure except the storage adapter, injected so tests can use a fake.

export const CONFIG_KEY = 'dz23.config.v1'
export const CONFIG_VERSION = 1
export const LEGACY_COPILOT_KEY = 'dz23.copilot.v2'
export const LEGACY_POPUP_KEY = 'iondvOptions'
export const DEFAULT_GATEWAY = 'http://127.0.0.1:8777'

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const asString = (value, fallback = '') => (typeof value === 'string' ? value : fallback)
const asObject = (value) => (isPlainObject(value) ? value : {})

export function defaultConfig () {
  return {
    version: CONFIG_VERSION,
    gateway: { url: DEFAULT_GATEWAY, token: '' },
    ai: { provider: '', model: '', modelsByProvider: {} },
    user: 'local',
    popup: { options: {} },
    watchlists: { lists: [] },
    alerts: { rules: [] },
    meta: { migratedAt: null, migratedFrom: [] },
  }
}

// Merge that keeps unknown keys: a newer build writing extra fields must not lose them to an older one.
function deepMerge (base, patch) {
  if (!isPlainObject(patch))
    return base
  const result = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    result[key] = isPlainObject(value) && isPlainObject(base?.[key])
      ? deepMerge(base[key], value)
      : value
  }
  return result
}

// A config that fails validation is repaired field by field, never thrown away: losing the token because one field
// had the wrong type would be worse than the wrong field.
export function validateConfig (raw) {
  const issues = []
  const base = defaultConfig()
  if (!isPlainObject(raw)) {
    if (raw !== undefined && raw !== null)
      issues.push('config não é um objeto')
    return { config: base, issues }
  }

  const config = deepMerge(base, raw)

  if (config.version !== CONFIG_VERSION) {
    issues.push(`versão ${config.version} lida como ${CONFIG_VERSION}`)
    config.version = CONFIG_VERSION
  }
  if (!isPlainObject(config.gateway)) {
    issues.push('gateway inválido')
    config.gateway = { ...base.gateway }
  }
  if (typeof config.gateway.url !== 'string' || !/^https?:\/\//.test(config.gateway.url)) {
    issues.push('gateway.url inválida')
    config.gateway.url = base.gateway.url
  }
  if (typeof config.gateway.token !== 'string') {
    issues.push('gateway.token não é texto')
    config.gateway.token = ''
  }
  if (!isPlainObject(config.ai)) {
    issues.push('ai inválido')
    config.ai = { ...base.ai }
  }
  if (typeof config.ai.provider !== 'string' || !/^[a-z0-9-]*$/i.test(config.ai.provider)) {
    issues.push('ai.provider inválido')
    config.ai.provider = ''
  }
  if (typeof config.ai.model !== 'string') {
    issues.push('ai.model não é texto')
    config.ai.model = ''
  }
  if (!isPlainObject(config.ai.modelsByProvider))
    config.ai.modelsByProvider = {}
  if (typeof config.user !== 'string' || !config.user.trim()) {
    if (config.user !== undefined)
      issues.push('user inválido')
    config.user = 'local'
  }
  if (!isPlainObject(config.popup))
    config.popup = { options: {} }
  if (!isPlainObject(config.watchlists) || !Array.isArray(config.watchlists.lists)) {
    issues.push('watchlists.lists inválidas')
    config.watchlists = { lists: [] }
  }
  if (!isPlainObject(config.alerts) || !Array.isArray(config.alerts.rules)) {
    issues.push('alerts.rules inválidas')
    config.alerts = { rules: [] }
  }
  if (!isPlainObject(config.popup.options))
    config.popup.options = {}
  if (!isPlainObject(config.meta))
    config.meta = { ...base.meta }
  return { config, issues }
}

function parseJson (text) {
  if (typeof text !== 'string' || !text.trim())
    return { value: null, issue: null }
  try {
    return { value: JSON.parse(text), issue: null }
  } catch {
    return { value: null, issue: 'JSON legado ilegível' }
  }
}

// Reads both legacy shapes and produces the initial config. Order is explicit: the copilot was the surface that
// carried gateway and provider, the popup carried its own options.
export function migrateLegacy ({ copilot = null, popup = null } = {}) {
  const config = defaultConfig()
  const issues = []
  const sources = []

  const copilotSettings = asObject(copilot?.settings)
  if (copilotSettings.gatewayUrl || copilotSettings.token) {
    config.gateway.url = typeof copilotSettings.gatewayUrl === 'string' && copilotSettings.gatewayUrl ? copilotSettings.gatewayUrl : config.gateway.url
    config.gateway.token = asString(copilotSettings.token)
    sources.push(LEGACY_COPILOT_KEY)
  }
  if (copilotSettings.provider)
    config.ai.provider = asString(copilotSettings.provider)
  if (copilotSettings.model)
    config.ai.model = asString(copilotSettings.model)
  if (isPlainObject(copilotSettings.modelsByProvider))
    config.ai.modelsByProvider = { ...copilotSettings.modelsByProvider }
  if (copilotSettings.user)
    config.user = asString(copilotSettings.user, 'local')
  else if (copilotSettings.user === '')
    config.user = 'local'

  if (isPlainObject(popup)) {
    const { tabId, ...rest } = popup
    void tabId
    if (Object.keys(rest).length) {
      config.popup.options = { ...rest }
      sources.push(LEGACY_POPUP_KEY)
    }
  }

  config.meta = { migratedAt: new Date().toISOString(), migratedFrom: sources }
  const { config: valid, issues: validationIssues } = validateConfig(config)
  return { config: valid, issues: [...issues, ...validationIssues] }
}

// The storage adapter is the only side effect. `read`/`write` are async and may fail (quota, permission):
// the store degrades to memory instead of breaking the panel.
export function createConfigStore ({ storage = null, now = () => Date.now() } = {}) {
  let cache = null

  const area = () => storage ?? globalThis.chrome?.storage?.local ?? null

  // Prazo: um storage que nunca responde (extensão despejada, porta morta) não pode segurar a inicialização.
  const STORAGE_TIMEOUT_MS = 800
  let storageTimedOut = false
  let storageFailed = false

  function withTimeout (work, fallback) {
    return new Promise((resolve) => {
      let settled = false
      function settle (value) {
        if (settled)
          return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        storageTimedOut = true
        settle(fallback)
      }, STORAGE_TIMEOUT_MS)
      try {
        work(settle)
      } catch {
        storageFailed = true
        settle(fallback)
      }
    })
  }

  async function readKey (key) {
    const api = area()
    if (!api)
      return undefined
    return withTimeout((done) => {
      const result = api.get(key, (value) => done(value?.[key]))
      if (result?.then)
        result.then((value) => done(value?.[key])).catch(() => {
          storageFailed = true
          done(undefined)
        })
    }, undefined)
  }

  async function writeKey (key, value) {
    const api = area()
    if (!api)
      return false
    return withTimeout((done) => {
      const result = api.set({ [key]: value }, () => done(true))
      if (result?.then)
        result.then(() => done(true)).catch(() => done(false))
    }, false)
  }

  async function load () {
    const issues = []
    let migrated = false
    let recovered = false

    const rawStored = await readKey(CONFIG_KEY)
    let stored = rawStored
    if (typeof rawStored === 'string') {
      try {
        stored = JSON.parse(rawStored)
        issues.push('configuração estava gravada como texto JSON; foi interpretada e regravada como objeto')
      } catch {
        issues.push('configuração gravada como texto inválido; recuperada para os padrões')
        stored = null
      }
    }
    if (storageFailed && !stored) {
      issues.push('não foi possível ler a configuração (o storage falhou); usando os padrões nesta sessão')
      recovered = true
    }
    if (stored && typeof stored === 'object') {
      const { config, issues: validationIssues } = validateConfig(stored)
      issues.push(...validationIssues)
      cache = config
      if (validationIssues.length) {
        // repair in place so the next load is clean, but never block the caller on the write
        recovered = true
        void writeKey(CONFIG_KEY, config)
      }
      return { config, migrated, issues, recovered, savedAt: now() }
    }

    // No config yet: build it from whatever the legacy surfaces left behind. The copilot wrote to
    // localStorage, the popup to chrome.storage.local — both are read, the storage one winning.
    const readLocal = (key) => {
      try {
        return globalThis.localStorage?.getItem(key) ?? undefined
      } catch {
        return undefined
      }
    }
    const [storedCopilot, storedPopup] = await Promise.all([
      readKey(LEGACY_COPILOT_KEY),
      readKey(LEGACY_POPUP_KEY),
    ])
    const copilot = parseJson(storedCopilot ?? readLocal(LEGACY_COPILOT_KEY))
    if (copilot.issue)
      issues.push(copilot.issue)
    const popup = storedPopup
    const legacy = migrateLegacy({ copilot: copilot.value, popup })
    issues.push(...legacy.issues)
    cache = legacy.config
    migrated = Boolean(legacy.config.meta.migratedFrom.length)
    // Se a leitura estourou o prazo, o storage está morto: gravar seria outra espera inútil.
    if (storageTimedOut) {
      issues.push('storage não respondeu dentro do prazo; configuração mantida em memória nesta sessão')
      return { config: cache, migrated, issues, recovered, savedAt: now() }
    }
    const written = await writeKey(CONFIG_KEY, cache)
    if (!written)
      issues.push('configuração migrada não pôde ser gravada (agora só em memória)')
    return { config: cache, migrated, issues, recovered, savedAt: now() }
  }

  async function save (patch) {
    const current = cache ?? (await load()).config
    const { config, issues } = validateConfig(deepMerge(current, patch))
    cache = config
    await writeKey(CONFIG_KEY, config)
    return { config, issues }
  }

  return {
    load,
    save,
    peek: () => cache,
    reset: () => { cache = null },
  }
}

/* ---------------------------------------------------------------- copilot view */

export function toSettings (config) {
  const valid = validateConfig(config).config
  return {
    gatewayUrl: valid.gateway.url,
    token: valid.gateway.token,
    provider: valid.ai.provider,
    model: valid.ai.model,
    modelsByProvider: { ...valid.ai.modelsByProvider },
    user: valid.user,
  }
}

export function fromSettings (settings = {}, base = defaultConfig()) {
  return {
    ...base,
    gateway: {
      ...base.gateway,
      url: typeof settings.gatewayUrl === 'string' && settings.gatewayUrl ? settings.gatewayUrl : base.gateway.url,
      token: asString(settings.token, base.gateway.token),
    },
    ai: {
      ...base.ai,
      provider: asString(settings.provider, base.ai.provider),
      model: asString(settings.model, base.ai.model),
      modelsByProvider: isPlainObject(settings.modelsByProvider) ? settings.modelsByProvider : base.ai.modelsByProvider,
    },
    user: asString(settings.user, base.user) || 'local',
  }
}

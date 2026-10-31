// Tests for the single configuration service: migration of both legacy shapes, idempotency, repair of invalid data
// and the round trip between the config and the copilot's flat settings view.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONFIG_KEY,
  CONFIG_VERSION,
  LEGACY_COPILOT_KEY,
  LEGACY_POPUP_KEY,
  createConfigStore,
  defaultConfig,
  fromSettings,
  migrateLegacy,
  toSettings,
  validateConfig,
} from '../../../extension/lib/config.js'

// Chrome's storage.local callback API, in memory
function fakeStorage (initial = {}) {
  const data = { ...initial }
  return {
    data,
    get (key, callback) { callback?.({ [key]: data[key] }) },
    set (items, callback) { Object.assign(data, items); callback?.() },
  }
}

const legacyCopilot = {
  settings: { gatewayUrl: 'http://127.0.0.1:8777', token: 'abc', provider: 'deepseek', model: 'deepseek-chat', modelsByProvider: { deepseek: ['deepseek-chat'] }, user: 'lmpra' },
  conversations: [{ id: 'c1' }],
}

test('sem nada gravado, entrega os padrões', async () => {
  const store = createConfigStore({ storage: fakeStorage() })
  const { config, migrated, issues } = await store.load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.equal(config.gateway.url, 'http://127.0.0.1:8777')
  assert.equal(config.gateway.token, '')
  assert.equal(migrated, false)
  assert.deepEqual(issues, [])
})

test('migra o copiloto legado (localStorage) sem perder nada', async () => {
  const storage = fakeStorage({ [LEGACY_COPILOT_KEY]: JSON.stringify(legacyCopilot) })
  const store = createConfigStore({ storage })
  const { config, migrated } = await store.load()
  assert.equal(migrated, true)
  assert.equal(config.gateway.token, 'abc')
  assert.equal(config.ai.provider, 'deepseek')
  assert.equal(config.user, 'lmpra')
  assert.deepEqual(config.meta.migratedFrom, [LEGACY_COPILOT_KEY])
  // o legado continua intacto: outra versão pode precisar dele
  assert.ok(storage.data[LEGACY_COPILOT_KEY].includes('deepseek'))
  assert.ok(storage.data[CONFIG_KEY].gateway)
})

test('migra as opções do popup para popup.options e descarta só o tabId transitório', async () => {
  const storage = fakeStorage({ [LEGACY_POPUP_KEY]: { tabId: 1, optParamName: 'Total PnL', isMaximizing: true } })
  const store = createConfigStore({ storage })
  const { config } = await store.load()
  assert.deepEqual(config.popup.options, { optParamName: 'Total PnL', isMaximizing: true })
  assert.deepEqual(config.meta.migratedFrom, [LEGACY_POPUP_KEY])
})

test('os dois legados juntos: copiloto manda em gateway/IA, popup mantém suas opções', async () => {
  const storage = fakeStorage({
    [LEGACY_COPILOT_KEY]: JSON.stringify(legacyCopilot),
    [LEGACY_POPUP_KEY]: { optParamName: 'Total PnL' },
  })
  const { config } = await createConfigStore({ storage }).load()
  assert.equal(config.gateway.token, 'abc')
  assert.equal(config.ai.model, 'deepseek-chat')
  assert.equal(config.popup.options.optParamName, 'Total PnL')
})

test('a migração é idempotente: carregar duas vezes não duplica nem reescreve', async () => {
  const storage = fakeStorage({ [LEGACY_COPILOT_KEY]: JSON.stringify(legacyCopilot) })
  const store = createConfigStore({ storage })
  const first = await store.load()
  const snapshot = JSON.stringify(storage.data[CONFIG_KEY])
  const second = await store.load()
  assert.deepEqual(first.config, second.config)
  assert.equal(second.migrated, false, 'a segunda leitura não migra de novo')
  assert.equal(JSON.stringify(storage.data[CONFIG_KEY]), snapshot, 'o conteúdo gravado não muda')
})

test('JSON legado quebrado não derruba o painel e é reportado', async () => {
  const storage = fakeStorage({ [LEGACY_COPILOT_KEY]: '{isto não é json' })
  const { config, issues } = await createConfigStore({ storage }).load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.ok(issues.some((issue) => issue.includes('JSON legado')))
})

test('configuração inválida é reparada campo a campo, sem perder o resto', async () => {
  const storage = fakeStorage({
    [CONFIG_KEY]: {
      version: 99,
      gateway: { url: 'não é url', token: 42 },
      ai: { provider: 'DEEP SEEK!', model: 7, modelsByProvider: 'x' },
      user: '',
      popup: { options: 'nada' },
      extrator: { keep: true },
    },
  })
  const { config, issues, recovered } = await createConfigStore({ storage }).load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.equal(config.gateway.url, 'http://127.0.0.1:8777')
  assert.equal(config.gateway.token, '')
  assert.equal(config.ai.provider, '')
  assert.equal(config.ai.model, '')
  assert.deepEqual(config.ai.modelsByProvider, {})
  assert.equal(config.user, 'local')
  assert.deepEqual(config.popup.options, {})
  assert.deepEqual(config.extrator, { keep: true }, 'chaves desconhecidas sobrevivem')
  assert.equal(recovered, true)
  assert.ok(issues.length >= 4)
})

test('save faz merge do patch, valida e persiste', async () => {
  const storage = fakeStorage()
  const store = createConfigStore({ storage })
  await store.load()
  const { config } = await store.save({ gateway: { token: 'novo' }, ai: { provider: 'openai' } })
  assert.equal(config.gateway.token, 'novo')
  assert.equal(config.gateway.url, 'http://127.0.0.1:8777', 'o resto do gateway permanece')
  assert.equal(config.ai.provider, 'openai')
  assert.equal(storage.data[CONFIG_KEY].gateway.token, 'novo')
})

test('sem storage disponível, funciona em memória e avisa', async () => {
  const store = createConfigStore({ storage: null })
  globalThis.chrome = undefined
  const { config, issues } = await store.load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.ok(issues.some((issue) => issue.includes('em memória')))
  const saved = await store.save({ user: 'offline' })
  assert.equal(saved.config.user, 'offline')
})

test('toSettings/fromSettings fazem o vaivém do copiloto', () => {
  const config = fromSettings({ gatewayUrl: 'http://127.0.0.1:9000', token: 't', provider: 'p', model: 'm', user: 'ana' })
  const settings = toSettings(config)
  assert.deepEqual(settings, { gatewayUrl: 'http://127.0.0.1:9000', token: 't', provider: 'p', model: 'm', modelsByProvider: {}, user: 'ana' })
  assert.equal(validateConfig(config).issues.length, 0)
  assert.deepEqual(defaultConfig().ai.modelsByProvider, {})
})

test('migrateLegacy sem nada devolve configuração válida e nenhuma origem', () => {
  const { config, issues } = migrateLegacy({})
  assert.deepEqual(issues, [])
  assert.deepEqual(config.meta.migratedFrom, [])
})

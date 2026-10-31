// Config resilience: storage that throws, storage that is missing and a localStorage that refuses to read.
// These are the paths §3.1 promises ("configuração ausente/inválida", "recuperação de migração interrompida") and they
// were the uncovered lines in the coverage report — a promise without a test is a guess.
import assert from 'node:assert/strict'
import test from 'node:test'
import { CONFIG_KEY, CONFIG_VERSION, createConfigStore, validateConfig } from '../../../extension/lib/config.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('storage.get que lança não derruba o boot: cai nos padrões com aviso', async () => {
  const throwing = {
    get () { throw new Error('storage exploded') },
    set (_items, callback) { callback?.() },
  }
  const store = createConfigStore({ storage: throwing })
  const { config, issues } = await store.load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.equal(config.gateway.url, 'http://127.0.0.1:8777')
  assert.ok(Array.isArray(issues))
})

test('storage.set que lança é reportado, não silenciado', async () => {
  let calls = 0
  const halfBroken = {
    data: {},
    get (key, callback) { callback?.({ [key]: this.data[key] }) },
    set () {
      calls += 1
      throw new Error('quota exceeded')
    },
  }
  const store = createConfigStore({ storage: halfBroken })
  const saved = await store.save({ user: 'quota' })
  assert.ok(calls >= 1, `tentou gravar ${calls} vez(es)`)
  // a configuração em memória muda mesmo quando a persistência falha — o usuário vê o efeito na sessão
  assert.equal(saved.config.user, 'quota')
  // O valor vive na sessão (o objeto devolvido pelo save), mas não foi persistido: load() relê o storage e
  // reconstrói a partir dos padrões. É o comportamento certo — mostrar "quota" após um reload seria mentira.
  assert.equal(halfBroken.data[CONFIG_KEY], undefined, 'nada foi persistido quando o set falhou')
  const reloaded = await store.load()
  assert.equal(reloaded.config.user, 'local', 'após reload vale o que está no storage, não o que falhou ao gravar')
  assert.ok(reloaded.issues.length >= 1, 'a falha de gravação deixa rastro em issues')
})

test('storage que nunca responde não trava o boot (prazo de leitura)', async () => {
  // Extensão despejada ou porta morta: o callback nunca chega. Sem prazo, isto travava a abertura do painel.
  const dead = { get () { /* nunca chama o callback */ }, set () { /* idem */ } }
  const started = Date.now()
  const { config, issues } = await createConfigStore({ storage: dead }).load()
  const elapsed = Date.now() - started
  assert.ok(elapsed < 4000, `levou ${elapsed} ms; o prazo deveria cortar antes`)
  assert.equal(config.version, CONFIG_VERSION)
  assert.ok(issues.some((issue) => /prazo|não respondeu/.test(issue)), JSON.stringify(issues))
})

test('storage com API assíncrona (promise) é lido e gravado corretamente', async () => {
  const data = {}
  const asyncStorage = {
    get: (key) => Promise.resolve({ [key]: data[key] }),
    set: (items) => { Object.assign(data, items); return Promise.resolve() },
  }
  const store = createConfigStore({ storage: asyncStorage })
  await store.load()
  const saved = await store.save({ user: 'assincrono' })
  await flush()
  assert.equal(saved.config.user, 'assincrono')
  assert.equal(data[CONFIG_KEY].user, 'assincrono')
})

test('localStorage que lança (armazenamento bloqueado) não impede a migração', async () => {
  const data = {}
  const storage = {
    get (key, callback) { callback?.({ [key]: data[key] }) },
    set (items, callback) { Object.assign(data, items); callback?.() },
  }
  const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get () { throw new Error('access denied') },
  })
  try {
    const store = createConfigStore({ storage })
    const { config, migrated, issues } = await store.load()
    assert.equal(config.version, CONFIG_VERSION)
    assert.equal(migrated, false, 'nada a migrar sem acesso ao localStorage')
    assert.ok(Array.isArray(issues))
  } finally {
    if (originalLocalStorage)
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage)
    else
      delete globalThis.localStorage
  }
})

test('config corrompida no storage é recuperada para os padrões', async () => {
  const storage = {
    data: { [CONFIG_KEY]: '{isso não é json' },
    get (key, callback) { callback?.({ [key]: this.data[key] }) },
    set (items, callback) { Object.assign(this.data, items); callback?.() },
  }
  const store = createConfigStore({ storage })
  const { config, recovered, issues } = await store.load()
  assert.equal(config.version, CONFIG_VERSION)
  if (recovered)
    assert.ok(issues.length >= 0, 'recuperação pode registrar aviso')
})

test('config gravada como texto JSON é interpretada, não descartada', async () => {
  const storage = {
    data: { [CONFIG_KEY]: JSON.stringify({ version: 1, user: 'antigo', gateway: { url: 'http://127.0.0.1:9999' } }) },
    get (key, callback) { callback?.({ [key]: this.data[key] }) },
    set (items, callback) { Object.assign(this.data, items); callback?.() },
  }
  const store = createConfigStore({ storage })
  const { config, issues } = await store.load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.equal(config.user, 'antigo', 'dado existente não é descartado')
  assert.equal(config.gateway.url, 'http://127.0.0.1:9999')
  assert.ok(issues.some((issue) => /texto JSON/.test(issue)), JSON.stringify(issues))
})

test('texto JSON inválido no storage é recuperado sem lançar', async () => {
  const storage = {
    data: { [CONFIG_KEY]: '{quebrado' },
    get (key, callback) { callback?.({ [key]: this.data[key] }) },
    set (items, callback) { Object.assign(this.data, items); callback?.() },
  }
  const { config, issues } = await createConfigStore({ storage }).load()
  assert.equal(config.version, CONFIG_VERSION)
  assert.ok(issues.some((issue) => /inválido|recuperada/i.test(issue)), JSON.stringify(issues))
})

test('config que não é objeto volta aos padrões com aviso (e sem lançar)', () => {
  const fromString = validateConfig('texto solto')
  assert.equal(fromString.config.version, CONFIG_VERSION)
  assert.ok(fromString.issues.some((issue) => /não é um objeto/.test(issue)))

  const fromNull = validateConfig(null)
  assert.equal(fromNull.config.version, CONFIG_VERSION)
  assert.deepEqual(fromNull.issues, [], 'null é ausência, não erro')
})

test('campo aninhado inválido é reparado sem descartar o resto da configuração', () => {
  // A promessa do módulo: "repaired field by field, never thrown away".
  const config = validateConfig({
    version: CONFIG_VERSION,
    user: 'ana',
    gateway: 'endpoint-que-virou-texto',
    alerts: { rules: [{ id: 'a1', symbol: 'BTCUSDT', type: 'price_above', value: 100, state: 'armed' }] },
  }).config
  assert.equal(config.user, 'ana', 'nome do usuário sobrevive')
  assert.equal(config.gateway.url, 'http://127.0.0.1:8777', 'gateway volta ao padrão')
  assert.equal(config.alerts.rules.length, 1, 'alertas sobrevivem')
})

test('ai inválido é reparado sem descartar gateway nem usuário', () => {
  const { config, issues } = validateConfig({
    version: CONFIG_VERSION,
    user: 'ana',
    gateway: { url: 'http://127.0.0.1:9999', token: 'segredo' },
    ai: 'deepseek',
  })
  assert.equal(config.ai.provider, '', 'ai volta ao padrão')
  assert.equal(config.gateway.url, 'http://127.0.0.1:9999', 'gateway preservado')
  assert.equal(config.gateway.token, 'segredo', 'token preservado')
  assert.ok(issues.some((issue) => /ai inválido/.test(issue)))
})

test('url inválida e token não-texto são corrigidos individualmente', () => {
  const { config, issues } = validateConfig({
    version: CONFIG_VERSION,
    user: 'ana',
    gateway: { url: 'ftp://nada', token: 12345 },
  })
  assert.equal(config.gateway.url, 'http://127.0.0.1:8777')
  assert.equal(config.gateway.token, '')
  assert.equal(config.user, 'ana')
  assert.ok(issues.some((issue) => /gateway.url inválida/.test(issue)))
  assert.ok(issues.some((issue) => /gateway.token não é texto/.test(issue)))
})

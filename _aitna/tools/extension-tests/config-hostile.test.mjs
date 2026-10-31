// Hostile storage: a corrupt, half-migrated or future-version record must never brick the panel.
// The spec asks for "tratamento de configurações ausentes e inválidas" and "recuperação em caso de migração
// interrompida" — exactly the input a real machine produces after a crash, a downgrade or a hand-edited record.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createConfigStore, defaultConfig, validateConfig } from '../../../extension/lib/config.js'

const seedStore = (seed) => createConfigStore({
  storage: { async get () { return seed }, async set () {} },
  now: () => 1_700_000_000_000,
})

test('registro que não é objeto cai para o padrão, sem lançar', async () => {
  const shape = (config) => JSON.stringify({ ...config, meta: { ...config.meta, migratedAt: null } })
  for (const garbage of [null, 42, 'texto', [1, 2, 3], true]) {
    const { config } = await seedStore({ 'dz23.config.v1': garbage }).load()
    // meta.migratedAt é carimbo de hora da carga; o resto precisa ser exatamente o padrão
    assert.equal(shape(config), shape(defaultConfig()), `registro <<${JSON.stringify(garbage)}>> deveria cair no padrão`)
  }
})

test('versão do futuro não é servida como se fosse entendida', async () => {
  const { config } = await seedStore({ 'dz23.config.v1': { ...defaultConfig(), version: 999 } }).load()
  assert.equal(config.version, 1)
})

test('campos conhecidos com tipo errado são corrigidos e reportados', async () => {
  const broken = { ...defaultConfig(), gateway: { url: 42, token: 7 }, ai: { provider: 123 }, user: { a: 1 } }
  const { config, issues } = await seedStore({ 'dz23.config.v1': broken }).load()
  assert.equal(typeof config.gateway.url, 'string')
  assert.equal(typeof config.gateway.token, 'string')
  assert.equal(typeof config.ai.provider, 'string')
  assert.equal(typeof config.user, 'string')
  assert.ok(issues.length >= 3, `cada correção precisa de uma issue, vieram ${issues.length}`)
})

test('listas inválidas são corrigidas E reportadas (nada de correção silenciosa)', async () => {
  for (const [field, broken] of [
    ['watchlists', { ...defaultConfig(), watchlists: { lists: 'x' } }],
    ['alerts', { ...defaultConfig(), alerts: { rules: null } }],
  ]) {
    const { config, issues } = await seedStore({ 'dz23.config.v1': broken }).load()
    assert.equal(Array.isArray(config[field].lists ?? config[field].rules), true)
    assert.ok(issues.some((issue) => issue.includes(field)), `${field} corrigido precisa aparecer em issues`)
  }
})

test('registro parcial sobrevive: o presente é mantido, o ausente vem do padrão', async () => {
  const { config } = await seedStore({ 'dz23.config.v1': { version: 1, user: 'ana' } }).load()
  assert.equal(config.user, 'ana')
  assert.deepEqual(config.gateway, defaultConfig().gateway)
})

test('registro gigante não derruba o carregamento', async () => {
  const { config } = await seedStore({ 'dz23.config.v1': { ...defaultConfig(), notes: 'x'.repeat(2_000_000) } }).load()
  assert.equal(config.version, 1)
})

test('storage que lança não derruba o painel, e a falha aparece em issues', async () => {
  const throwing = { async get () { throw new Error('storage quebrado') }, async set () { throw new Error('storage quebrado') } }
  const result = await createConfigStore({ storage: throwing, now: () => 0 }).load()
  assert.equal(typeof result.config, 'object')
  assert.equal(result.recovered, true, 'a recuperação precisa ser visível, não silenciosa')
  assert.ok(
    result.issues.some((issue) => issue.includes('storage falhou')),
    'o usuário precisa saber que a configuração não pôde ser lida — antes disso o painel caía nos padrões em silêncio',
  )
})

test('validateConfig nunca lança, para qualquer entrada', () => {
  for (const input of [undefined, null, 0, '', 'x', [], {}, { version: 'um' }, { providers: null }, { gateway: 7 }])
    assert.doesNotThrow(() => validateConfig(input), `lançou para ${JSON.stringify(input)}`)
})

// Integration between the two surfaces: the popup bridge (a classic script) and the copilot's config service must
// read and write the same record, and the bridge must seed its legacy mirror from it.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { CONFIG_KEY, LEGACY_POPUP_KEY, createConfigStore, toSettings } from '../../../extension/lib/config.js'

const here = dirname(fileURLToPath(import.meta.url))
const bridgeSource = readFileSync(join(here, '../../../extension/lib/config-bridge.js'), 'utf8')

function fakeArea (data = {}) {
  return {
    data,
    get (key, callback) { callback?.({ [key]: data[key] }) },
    set (items, callback) { Object.assign(data, items); callback?.() },
  }
}

// Runs the real config-bridge.js in a sandbox with a window and chrome.storage.local
function runBridge (area) {
  const sandbox = {
    window: {},
    chrome: { storage: { local: area } },
    console: { debug () {}, warn () {}, error () {} },
  }
  vm.createContext(sandbox)
  vm.runInContext(bridgeSource, sandbox)
  return sandbox.window.dz23PopupConfig
}

test('o bridge do popup grava opções que o copiloto enxerga no mesmo registro', async () => {
  const area = fakeArea()
  const store = createConfigStore({ storage: area })
  await store.load()

  const bridge = runBridge(area)
  await bridge.saveOptions({ optParamName: 'Total PnL', isMaximizing: true })
  await bridge.ready

  // a mesma chave, lida pelo serviço do copiloto
  const { config } = await store.load()
  assert.equal(config.popup.options.optParamName, 'Total PnL')
  assert.equal(config.popup.options.isMaximizing, true)
  assert.ok(area.data[CONFIG_KEY], 'o registro compartilhado existe')
  assert.equal(toSettings(config).token, config.gateway.token, 'as settings do copiloto vêm do mesmo lugar')
})

test('sem o espelho legado, o bridge semeia iondvOptions a partir da configuração', async () => {
  const area = fakeArea({ [CONFIG_KEY]: { version: 1, gateway: { url: 'http://127.0.0.1:8777', token: 't' }, popup: { options: { optParamName: 'Sharpe' } } } })
  const bridge = runBridge(area)
  const mirrored = await bridge.ready
  assert.equal(mirrored.optParamName, 'Sharpe')
  assert.equal(area.data[LEGACY_POPUP_KEY].optParamName, 'Sharpe', 'o espelho é escrito para o build antigo')
})

test('com espelho legado presente, o bridge não sobrescreve com a configuração', async () => {
  const area = fakeArea({
    [LEGACY_POPUP_KEY]: { optParamName: 'Legado' },
    [CONFIG_KEY]: { version: 1, popup: { options: { optParamName: 'Novo' } } },
  })
  const bridge = runBridge(area)
  const mirrored = await bridge.ready
  assert.equal(mirrored.optParamName, 'Legado', 'o espelho existente vence: é o estado que o usuário vê')
  assert.equal(area.data[LEGACY_POPUP_KEY].optParamName, 'Legado')
})

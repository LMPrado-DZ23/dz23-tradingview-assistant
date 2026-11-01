import assert from 'node:assert/strict'
import test from 'node:test'
import { loadExtension } from './harness.mjs'

// O diálogo "sem estratégia no gráfico" oferece abrir o DZ23 Research. Quem recebe o pedido é o background — sem este
// teste, o botão existiria e não faria nada, que é o defeito que este projeto vem removendo em toda parte.
test('a mensagem dz23:research:open abre a página de pesquisa', async () => {
  const extension = loadExtension([])
  // instrumenta o chrome ANTES de carregar o service worker: o listener é registrado no carregamento
  extension.evaluate(`
    globalThis.__criada = null
    globalThis.__listener = null
    chrome.tabs.create = (options, callback) => { globalThis.__criada = options; if (callback) callback({ id: 7 }) }
    chrome.runtime.onMessage.addListener = (fn) => { globalThis.__listener = fn }
  `)
  extension.runFile('background.js')

  assert.equal(extension.evaluate('typeof globalThis.__listener'), 'function', 'o background registra um listener')

  const resposta = await extension.evaluate(`
    new Promise((resolve) => { globalThis.__listener({ type: 'dz23:research:open' }, {}, resolve) })
  `)

  assert.equal(resposta?.ok, true)
  assert.match(extension.evaluate('globalThis.__criada.url'), /research\/index\.html$/)
})

test('a pesquisa não abre aba em mensagem de outro tipo', async () => {
  const extension = loadExtension([])
  extension.evaluate(`
    globalThis.__criada = null
    globalThis.__listener = null
    chrome.tabs.create = (options) => { globalThis.__criada = options }
    chrome.runtime.onMessage.addListener = (fn) => { globalThis.__listener = fn }
  `)
  extension.runFile('background.js')
  extension.evaluate(`globalThis.__listener({ type: 'dz23:outra:coisa' }, {}, () => {})`)
  assert.equal(extension.evaluate('globalThis.__criada'), null, 'nenhuma aba pode abrir por engano')
})

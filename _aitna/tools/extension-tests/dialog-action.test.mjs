// O diálogo legado "sem estratégia no gráfico" deixou de ser beco sem saída: ele oferece um botão que abre o laboratório
// local do DZ23. Explicar o erro e não oferecer saída é o que fazia essa tela parecer defeito do produto.
//
// Estes testes entram no contexto da extensão e mexem no DOM de verdade (falso, mas real para o código): o botão precisa
// EXISTIR quando há ação, NÃO existir quando não há, e o clique precisa chamar a ação e fechar o diálogo.
import assert from 'node:assert/strict'
import test from 'node:test'
import { loadExtension } from './harness.mjs'

const FILES = ['content_scripts/selector.js', 'content_scripts/page.js', 'content_scripts/ui.js']

function instrumentar (extension) {
  // ui.alertPopup monta o diálogo em document.getElementsByTagName('body')[0], e se recusa a abrir quando já existe
  // #iondvAlertPopup. O stub precisa refletir isso — senão o teste mede o nada e passa por acidente.
  extension.evaluate(`
    globalThis.__captured = null
    globalThis.__stubs = new Map()
    const body = {
      appendChild (element) { globalThis.__captured = element; return element },
      removeChild (element) { return element },
    }
    document.getElementsByTagName = (name) => (name === 'body' ? [body] : [])
    document.getElementById = (id) => {
      if (id === 'iondvAlertPopup')
        return null
      if (!globalThis.__stubs.has(id))
        globalThis.__stubs.set(id, { id, focus () {}, onclick: null, click () { if (this.onclick) this.onclick() } })
      return globalThis.__stubs.get(id)
    }
  `)
}

test('sem ação, o diálogo não mostra botão extra', async () => {
  const extension = loadExtension(FILES)
  instrumentar(extension)
  const { ui } = extension.api('ui')
  void ui.showIssuePopup('texto do erro')
  const html = extension.evaluate('globalThis.__captured.innerHTML')
  assert.match(html, /texto do erro/)
  assert.equal(/iondvPopupActionBtn/.test(html), false, 'sem ação não pode aparecer botão de ação')
})

test('com ação, o botão aparece com o rótulo recebido', async () => {
  const extension = loadExtension(FILES)
  instrumentar(extension)
  const { ui } = extension.api('ui')
  void ui.showIssuePopup('texto do erro', { label: 'Abrir DZ23 Research', run: () => {} })
  const html = extension.evaluate('globalThis.__captured.innerHTML')
  assert.match(html, /id="iondvPopupActionBtn"/)
  assert.match(html, /Abrir DZ23 Research/)
})

test('clicar no botão executa a ação e fecha o diálogo', async () => {
  const extension = loadExtension(FILES)
  instrumentar(extension)
  const { ui } = extension.api('ui')
  let executou = 0
  const fechado = ui.showIssuePopup('texto', { label: 'Abrir', run: () => { executou += 1 } })
  extension.evaluate(`globalThis.__stubs.get('iondvPopupActionBtn').click()`)
  assert.equal(executou, 1, 'o clique precisa chamar a ação')
  assert.equal(await fechado, true, 'e o diálogo fecha depois')
})

test('ação que lança não deixa o diálogo travado', async () => {
  const extension = loadExtension(FILES)
  instrumentar(extension)
  const { ui } = extension.api('ui')
  const fechado = ui.showIssuePopup('texto', { label: 'Abrir', run: () => { throw new Error('falhou') } })
  assert.doesNotThrow(() => extension.evaluate(`globalThis.__stubs.get('iondvPopupActionBtn').click()`))
  assert.equal(await fechado, true)
  const erros = extension.logs.filter((entry) => entry.level === 'error')
  assert.equal(erros.length >= 1, true, 'a falha da ação precisa ser registrada, não engolida')
})

// A ação vive num só lugar (ui.researchAction): rótulo + mensagem. Se ela quebrar, todo diálogo que a usa quebra junto —
// por isso o teste dela é direto, e não através de cada um dos três chamadores.
test('researchAction devolve rótulo traduzido e pede a abertura do Research', () => {
  const extension = loadExtension(FILES)
  const { ui } = extension.api('ui')
  const action = ui.researchAction()
  assert.equal(typeof action.label, 'string')
  assert.ok(action.label.length > 0, 'o botão precisa de rótulo')
  action.run()
  const pedido = extension.pageMessages.find((message) => message.toBackground)
  assert.equal(pedido?.toBackground.type, 'dz23:research:open', 'a ação precisa pedir a abertura ao background')
})

test('showErrorPopup também aceita ação, não só o popup de issue', async () => {
  const extension = loadExtension(FILES)
  instrumentar(extension)
  const { ui } = extension.api('ui')
  void ui.showErrorPopup('falhou ao abrir parâmetros', ui.researchAction())
  const html = extension.evaluate('globalThis.__captured.innerHTML')
  assert.match(html, /id="iondvPopupActionBtn"/, 'erro com saída precisa mostrar o botão')
})

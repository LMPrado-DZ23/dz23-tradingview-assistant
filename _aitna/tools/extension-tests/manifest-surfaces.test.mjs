// Manifest as the product's entry points: every surface must be reachable and declared exactly once.
// A screen nobody can open is a screen that does not exist — this file locks the doors open.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXTENSION = join(ROOT, 'extension')
const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'))
const exists = (relativePath) => existsSync(join(EXTENSION, relativePath))

test('as três telas têm entrada declarada: painel, popup e configurações', () => {
  assert.equal(manifest.manifest_version, 3)
  assert.equal(manifest.side_panel?.default_path, 'copilot/index.html', 'painel lateral')
  assert.equal(manifest.action?.default_popup, 'popup/assistant.html', 'popup')
  assert.equal(manifest.options_ui?.page, 'settings/index.html', 'configurações precisam de entrada padrão do Chrome')
  assert.equal(manifest.options_ui?.open_in_tab, true, 'a tela é grande: abre em aba, não em diálogo')
})

test('todo arquivo declarado no manifest existe no pacote', () => {
  const referenced = []
  const backgroundScript = manifest.background?.service_worker ?? (Array.isArray(manifest.background?.scripts) ? manifest.background.scripts[0] : null)
  if (backgroundScript)
    referenced.push(backgroundScript)
  for (const entry of manifest.content_scripts ?? [])
    for (const file of entry.js ?? [])
      referenced.push(file)
  for (const path of [manifest.side_panel?.default_path, manifest.action?.default_popup, manifest.options_ui?.page])
    if (path)
      referenced.push(path)
  for (const resource of manifest.web_accessible_resources ?? [])
    for (const file of resource.resources ?? [])
      referenced.push(file)
  for (const icon of Object.values(manifest.icons ?? {}))
    referenced.push(icon.replace(/^\//, ''))

  const missing = [...new Set(referenced)].filter((file) => !exists(file))
  assert.deepEqual(missing, [], `declarados e inexistentes: ${missing.join(', ')}`)
})

test('content scripts cobrem só o TradingView, e o bridge roda em todas as páginas do site', () => {
  const matches = (manifest.content_scripts ?? []).flatMap((entry) => entry.matches ?? [])
  assert.ok(matches.length > 0)
  for (const pattern of matches)
    assert.match(pattern, /^https:\/\/(\*\.|www\.)tradingview\.com\//, `padrão fora do domínio: ${pattern}`)
  const bridge = (manifest.content_scripts ?? []).find((entry) => (entry.js ?? []).includes('content_scripts/chartBridge.js'))
  assert.ok(bridge, 'chartBridge precisa estar declarado')
  assert.ok(bridge.matches.includes('https://www.tradingview.com/*'), 'o bridge roda em qualquer página do site, não só no /chart/')
})

test('a tela de configurações é uma só: nenhuma outra página de opções concorrente', () => {
  const declared = [manifest.options_ui?.page, manifest.options_page].filter(Boolean)
  assert.deepEqual([...new Set(declared)], ['settings/index.html'])
  // o popup e o painel abrem a MESMA página; se alguém criar uma segunda, este teste não pega sozinho —
  // por isso ele também fixa o caminho usado pelos dois.
  const popup = readFileSync(join(EXTENSION, 'popup/assistant.js'), 'utf8')
  const copilot = readFileSync(join(EXTENSION, 'copilot/app.js'), 'utf8')
  assert.match(popup, /getURL\('settings\/index\.html'\)/)
  assert.match(copilot, /getURL\?\.\('settings\/index\.html'\)|\?\.getURL\?\./)
})

test('o painel e o popup usam a mesma chave de configuração, não cópias', () => {
  const copilot = readFileSync(join(EXTENSION, 'copilot/app.js'), 'utf8')
  const popup = readFileSync(join(EXTENSION, 'popup/assistant.js'), 'utf8')
  for (const source of [copilot, popup]) {
    assert.doesNotMatch(source, /localStorage\.setItem\('dz23\.copilot\.v2'/, 'ninguém escreve a chave legada diretamente')
  }
  assert.match(copilot, /createConfigStore|dz23ConfigBridge/)
})

test('o popup não grava a chave legada por fora da ponte (uma fonte de verdade)', () => {
  const popup = readFileSync(join(EXTENSION, 'popup/assistant.js'), 'utf8')
  // O registro único é dz23.config.v1; iondvOptions é espelho mantido pela ponte. Uma escrita direta fora do
  // fallback deixa o registro velho — e a ponte podia escrever por cima da escolha nova do usuário.
  assert.match(popup, /function persistOptions/, 'as opções passam por um único caminho de persistência')
  // A proibição é de escrita FORA do caminho único — dentro dele, o fallback é o comportamento correto.
  const helperStart = popup.indexOf('function persistOptions')
  const helperEnd = popup.indexOf('function saveOptions(signal)')
  const outside = popup.slice(0, helperStart) + popup.slice(helperEnd)
  assert.doesNotMatch(outside, /chrome\.storage\.local\.set\(\{'iondvOptions'/, 'nenhuma escrita da chave legada fora de persistOptions')
  const persist = popup.slice(popup.indexOf('function persistOptions'), popup.indexOf('function saveOptions'))
  assert.match(persist, /dz23PopupConfig/, 'usa a ponte quando ela existe')
  assert.match(persist, /saveOptions/, 'a ponte grava o registro e o espelho')
  const save = popup.slice(popup.indexOf('function saveOptions(signal)'), popup.indexOf('function sendSignalToActiveTab'))
  assert.match(save, /persistOptions\(iondvOptions\)/, 'saveOptions delega ao caminho único')
})

test('a ponte grava registro e espelho, nunca só um dos dois', () => {
  const bridge = readFileSync(join(EXTENSION, 'lib/config-bridge.js'), 'utf8')
  const saveOptionsBody = bridge.slice(bridge.indexOf('async function saveOptions'), bridge.indexOf('const ready'))
  assert.match(saveOptionsBody, /return save\(/, 'saveOptions passa por save()')
  const saveBody = bridge.slice(bridge.indexOf('async function save'), bridge.indexOf('async function saveOptions'))
  assert.match(saveBody, /await write\(next\)/, 'grava o registro único')
  assert.match(saveBody, /\[LEGACY\]: patch\.popup\.options/, 'e espelha em iondvOptions')
})

test('o id da extensão é o mesmo em todo lugar (chave fixa, host e gateway)', () => {
  // Sem `key`, o id da extensão vem da pasta onde ela foi carregada — e o host nativo, que só aceita um id,
  // recusaria a conexão em outra pasta. A chave fixa torna o id determinístico.
  assert.ok(manifest.key, 'o manifest precisa da chave pública para id estável')
  const digest = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest()
  const derived = [...digest.subarray(0, 16).toString('hex')].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')
  assert.match(derived, /^[a-p]{32}$/)

  const hostManifest = JSON.parse(readFileSync(join(ROOT, 'native-host/manifest.json'), 'utf8'))
  assert.deepEqual(hostManifest.allowed_origins, [`chrome-extension://${derived}/`], 'o host aceita exatamente esta extensão')

  const server = readFileSync(join(ROOT, 'gateway/server.mjs'), 'utf8')
  assert.match(server, new RegExp(`DEFAULT_EXTENSION_ID = '${derived}'`), 'o gateway usa o mesmo id na allowlist')

  const installer = readFileSync(join(ROOT, 'native-host/install.mjs'), 'utf8')
  assert.match(installer, /idFromExtensionKey/, 'o instalador deriva o id da chave em vez de pedir à mão')
})

test('nenhum arquivo ainda aponta o id antigo', () => {
  const stale = 'pfbdfjaonemppanfnlmliafffahlohfg'
  for (const file of ['README.md', 'docs/NATIVE-HOST.md', 'docs/ENTREGA.md', 'native-host/README.md']) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    assert.equal(text.includes(stale), false, `${file} ainda cita o id antigo`)
  }
})

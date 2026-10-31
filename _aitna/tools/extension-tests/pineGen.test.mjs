// Pine generation contract: prompt shape and code extraction, without any network.
import assert from 'node:assert/strict'
import test from 'node:test'
import { PINE_GEN_CONTRACT, buildPinePrompt, describeGeneration, extractPineCode } from '../../../extension/quant/pineGen.mjs'
import { validatePine } from '../../../extension/quant/pine.mjs'

const BT = String.fromCharCode(96)
const FENCE = BT.repeat(3)

test('prompt exige versão, custos e proíbe look-ahead', () => {
  const prompt = buildPinePrompt('RSI com divergência', { kind: 'strategy' })
  assert.match(prompt, /estratégia/)
  assert.match(prompt, /RSI com divergência/)
  assert.match(prompt, /\/\/@version=5/)
  assert.match(prompt, /commission\/slippage/)
  assert.match(prompt, /lookahead_on/)
  assert.match(PINE_GEN_CONTRACT.slice(0, 20), /Responda SOMENTE/)
})

test('prompt sem descrição falha com mensagem clara', () => {
  assert.throws(() => buildPinePrompt('   '), /descreva/)
})

test('extrai bloco com linguagem pine', () => {
  const code = `//@version=5\nindicator("x")\nplot(close)`
  const result = extractPineCode(`aqui está:\n${FENCE}pine\n${code}\n${FENCE}\nfim`)
  assert.equal(result.code, code)
  assert.match(result.discarded, /aqui está/)
})

test('extrai bloco sem linguagem e descarta o texto em volta', () => {
  const code = `//@version=5\nstrategy("s")\nstrategy.entry("l", strategy.long)`
  const result = extractPineCode(`${FENCE}\n${code}\n${FENCE}\nexplicação depois`)
  assert.equal(result.code, code)
  assert.match(result.discarded, /explicação depois/)
})

test('aceita script sem cerca quando parece Pine', () => {
  const code = '//@version=5\nindicator("y")\nplot(close)'
  assert.equal(extractPineCode(code).code, code)
})

test('recusa resposta que não é Pine', () => {
  const result = extractPineCode('Desculpe, não posso ajudar com isso.')
  assert.equal(result.code, '')
  assert.match(result.reason, /não contém bloco Pine/)
})

test('descrição aprova script válido e reprova script inválido', () => {
  const good = validatePine('//@version=5\nindicator("ok")\nplot(ta.ema(close, 9))')
  const okText = describeGeneration({ code: 'x', report: good, discarded: '' })
  assert.match(okText, /aprovado pelo validador/)

  const bad = validatePine('//@version=9\nplot(close)')
  const badText = describeGeneration({ code: 'y', report: bad, discarded: '' })
  assert.match(badText, /NÃO usar antes de corrigir/)
  assert.match(badText, /pine\.version_unsupported/)
})

test('geração sem código informa o descarte', () => {
  const text = describeGeneration({ code: '', report: validatePine(''), discarded: 'texto qualquer' })
  assert.match(text, /sem código Pine reconhecível/)
  assert.match(text, /texto qualquer/)
})

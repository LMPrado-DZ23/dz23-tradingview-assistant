// Pine explanation contract: the prompt carries the facts, the formatter keeps authorities apart.
import assert from 'node:assert/strict'
import test from 'node:test'
import { EXPLAIN_CONTRACT, buildExplainPrompt, formatExplanation } from '../../../extension/quant/pineExplain.mjs'
import { validatePine } from '../../../extension/quant/pine.mjs'

const good = '//@version=5\nindicator("ok")\nplot(ta.ema(close, 9))'

test('prompt inclui os achados do validador como fatos', () => {
  const report = validatePine('//@version=5\nindicator("x")\nplot(close)\nif barstate.islast\n    var int y = 1')
  const prompt = buildExplainPrompt('//@version=5\nindicator("x")', report)
  assert.match(prompt, /Achados do validador \(fatos verificados/)
  assert.match(prompt, /Resumo do validador: \d+ erro\(s\)/)
  assert.match(prompt, /Não afirme rentabilidade/)
})

test('prompt sem achados diz "nenhum achado" em vez de inventar', () => {
  const prompt = buildExplainPrompt(good, validatePine(good))
  assert.match(prompt, /- nenhum achado/)
})

test('prompt trunca código longo e avisa', () => {
  const long = `${good}\n${Array.from({ length: 400 }, (_, index) => `// linha ${index}`).join('\n')}`
  const prompt = buildExplainPrompt(long, validatePine(long), { maxCodeChars: 200 })
  assert.match(prompt, /\.\.\. truncado/)
})

test('prompt sem código falha', () => {
  assert.throws(() => buildExplainPrompt('   ', validatePine('')), /sem código/)
})

test('formatador separa validador (fatos) de modelo (interpretação)', () => {
  const report = validatePine('//@version=9\nplot(close)')
  const text = formatExplanation({ report, answer: 'Este script desenha o fechamento.' })
  const [facts, ...rest] = text.split('Explicação do modelo')
  assert.match(facts, /Validador \(fatos\)/)
  assert.match(facts, /pine\.version_unsupported/)
  assert.match(rest.join(''), /\(interpretação, não verificação\)/)
  assert.match(rest.join(''), /desenha o fechamento/)
})

test('sem resposta do modelo, o formatador diz isso', () => {
  const text = formatExplanation({ report: validatePine(good), answer: '' })
  assert.match(text, /\(sem resposta do modelo\)/)
})

test('contrato proíbe afirmar rentabilidade', () => {
  assert.match(EXPLAIN_CONTRACT, /Não afirme rentabilidade/)
  assert.match(EXPLAIN_CONTRACT, /repainting/)
})

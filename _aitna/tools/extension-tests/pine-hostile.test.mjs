// @ts-check
// Scripts hostis no validador de Pine: ele roda no caminho da análise, então não pode lançar nem travar.
// A pergunta é o que ele DIZ diante de lixo — não só se sobrevive.
import assert from 'node:assert/strict'
import test from 'node:test'
import { SUPPORTED_VERSIONS, validatePine } from '../../../extension/quant/pine.mjs'

const hostile = {
  'vazio': '',
  'só espaços': '   \n\n\t  ',
  'sem versão': 'plot(close)',
  'versão do futuro': '//@version=999\nplot(close)',
  'versão negativa': '//@version=-1\nplot(close)',
  'aspas sem fechar': '//@version=6\nx = "sem fim\nplot(close)',
  'parêntese sem fechar': '//@version=6\nplot(close',
  'linha gigante': `//@version=6\nplot(${'close+'.repeat(20_000)}close)`,
  'unicode e emoji': '//@version=6\n// 📈 análise — ação\nplot(close)',
  'byte nulo': `//@version=6\nplot(close)${String.fromCharCode(0)}`,
  'injeção em comentário': '//@version=6\n// </script><script>alert(1)</script>\nplot(close)',
  'request.security com lookahead': '//@version=6\nx = request.security(syminfo.tickerid, "1D", close, lookahead=barmerge.lookahead_on)\nplot(x)',
  'varip (repinta)': '//@version=6\nvarip int n = 0\nn := n + 1\nplot(n)',
  'script de 1 MB': `//@version=6\n${'plot(close)\n'.repeat(80_000)}`,
}

for (const [label, source] of Object.entries(hostile)) {
  test(`validador sobrevive: ${label}`, () => {
    let result
    assert.doesNotThrow(() => { result = validatePine(source) }, `lançou para "${label}"`)
    assert.equal(typeof result, 'object')
    assert.ok(Array.isArray(result.errors) || Array.isArray(result.findings), 'precisa devolver uma lista de achados')
  })
}

test('versões suportadas são reportadas como tal', () => {
  assert.ok(Array.isArray(SUPPORTED_VERSIONS) && SUPPORTED_VERSIONS.length > 0)
})

test('versão não suportada é diagnosticada, não ignorada', () => {
  const result = validatePine('//@version=999\nplot(close)')
  const text = JSON.stringify(result)
  assert.match(text, /999/, 'a versão estranha precisa aparecer no diagnóstico')
})

test('varip e calc_on_every_tick são diagnosticados como repintura', () => {
  // §7 pede "detectar repainting": estes dois modos passavam sem nenhum aviso.
  const varip = validatePine('//@version=6\nindicator("x")\nvarip int n = 0\nn := n + 1\nplot(n)')
  assert.ok(varip.findings.some((finding) => finding.code === 'pine.repainting_varip'))

  const tick = validatePine('//@version=6\nstrategy("x", calc_on_every_tick=true)\nplot(close)')
  assert.ok(tick.findings.some((finding) => finding.code === 'pine.repainting_calc_on_tick'))
})

test('a palavra em comentário não gera falso positivo de repintura', () => {
  const commented = validatePine('//@version=6\nindicator("x")\n// cuidado com varip aqui\nplot(close)')
  assert.equal(commented.findings.some((finding) => finding.code.startsWith('pine.repainting')), false)
})

test('look-ahead continua sendo detectado', () => {
  const result = validatePine('//@version=6\nindicator("x")\nplot(request.security(syminfo.tickerid, "1D", close, lookahead=barmerge.lookahead_on))')
  assert.ok(result.findings.some((finding) => finding.code === 'pine.lookahead'))
})

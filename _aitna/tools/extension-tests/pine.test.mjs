// Tests for the Pine linter: each case is a real shape of script that either compiles or fails in the TradingView
// editor. The point is to catch the misleading ones (look-ahead, costs, no exit), not to pretend it is a compiler.
import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPineReport, validatePine } from '../../../extension/quant/pine.mjs'

const goodIndicator = `//@version=5
indicator("EMA rápida", overlay = true)
fast = ta.ema(close, 9)
plot(fast, color = color.new(color.teal, 0))
`

const goodStrategy = `//@version=5
strategy("Rompimento com custos", overlay = true, commission_type = strategy.commission.percent, commission_value = 0.05, slippage = 2)
atr = ta.atr(14)
longCondition = ta.crossover(close, ta.sma(close, 20))
if longCondition
    strategy.entry("long", strategy.long)
    strategy.exit("saida", "long", stop = close - atr * 2, limit = close + atr * 4)
`

test('indicador v5 bem formado passa sem erros', () => {
  const result = validatePine(goodIndicator)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'indicator')
  assert.equal(result.version, 5)
  assert.equal(result.summary.errors, 0)
  assert.equal(result.summary.warnings, 0)
})

test('estratégia com custos e saída explícita passa', () => {
  const result = validatePine(goodStrategy)
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'strategy')
  assert.equal(result.stats.entries, 1)
  assert.equal(result.summary.warnings, 0)
})

test('script vazio é erro, não relatório vazio', () => {
  const result = validatePine('   ')
  assert.equal(result.ok, false)
  assert.equal(result.findings[0].code, 'pine.empty')
})

test('sem @version avisa que o TradingView assume v1', () => {
  const result = validatePine('indicator("x")\nplot(close)\n')
  assert.equal(result.version, null)
  assert.ok(result.findings.some((finding) => finding.code === 'pine.version_missing'))
})

test('versão inexistente é erro', () => {
  const result = validatePine('//@version=9\nindicator("x")\n')
  assert.equal(result.ok, false)
  assert.ok(result.findings.some((finding) => finding.code === 'pine.version_unsupported'))
})

test('sem declaração indicator/strategy é erro', () => {
  const result = validatePine('//@version=5\nplot(close)\n')
  assert.equal(result.ok, false)
  assert.ok(result.findings.some((finding) => finding.code === 'pine.declaration_missing'))
})

test('parênteses desbalanceados e string aberta são erros com linha', () => {
  const result = validatePine('//@version=5\nindicator("x"\nplot(close)\nlabel.new(bar_index, close, "abc)\n')
  const codes = result.findings.map((finding) => finding.code)
  assert.ok(codes.includes('pine.unbalanced'))
  assert.ok(codes.includes('pine.string_unterminated'))
  const stringFinding = result.findings.find((finding) => finding.code === 'pine.string_unterminated')
  assert.equal(stringFinding.line, 4, 'a linha do label.new, onde a string abre e não fecha')
})

test('lookahead_on é avisado: usa dado do futuro', () => {
  const result = validatePine(`//@version=5
indicator("x")
h = request.security(syminfo.tickerid, "D", high, lookahead = barmerge.lookahead_on)
plot(h)
`)
  assert.ok(result.findings.some((finding) => finding.code === 'pine.lookahead'))
  assert.equal(result.ok, true, 'é aviso, compila')
})

test('referência a barra futura é erro', () => {
  const result = validatePine('//@version=5\nindicator("x")\nc = close[-1]\n')
  assert.equal(result.ok, false)
  assert.ok(result.findings.some((finding) => finding.code === 'pine.future_reference'))
})

test('security() e study() antigos são avisados', () => {
  const result = validatePine('//@version=4\nstudy("velho")\ns = security(syminfo.tickerid, "60", close)\nplot(s)\n')
  const codes = result.findings.map((finding) => finding.code)
  assert.ok(codes.includes('pine.deprecated_security'))
  assert.ok(codes.includes('pine.deprecated_study'))
})

test('namespace ta. em versão antiga é erro', () => {
  const result = validatePine('//@version=3\nindicator("x")\nplot(ta.ema(close, 9))\n')
  assert.equal(result.ok, false)
  assert.ok(result.findings.some((finding) => finding.code === 'pine.namespace_version'))
})

test('estratégia sem custos, sem entrada e sem saída recebe os três avisos', () => {
  const semCustos = validatePine('//@version=5\nstrategy("x")\n')
  const codes = semCustos.findings.map((finding) => finding.code)
  assert.ok(codes.includes('pine.strategy_no_costs'))
  assert.ok(codes.includes('pine.strategy_no_entry'))
  const semSaida = validatePine('//@version=5\nstrategy("x", commission_value = 0.1)\nif close > open\n    strategy.entry("l", strategy.long)\n')
  assert.ok(semSaida.findings.some((finding) => finding.code === 'pine.strategy_no_exit'))
  assert.equal(semSaida.summary.warnings, 1)
})

test('o relatório é legível para humano', () => {
  const text = formatPineReport(validatePine('//@version=9\nplot(close)\n'))
  assert.match(text, /ERROS/)
  assert.match(text, /pine\.declaration_missing/)
})

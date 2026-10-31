#!/usr/bin/env node
// Dead exports: a module can be reachable and still carry functions nobody calls.
//
// The PBO/DSR case was exactly this one level up — the file was imported by a test and by nothing else, so the feature was
// announced but never computed. Here every exported name is counted across three populations: the product (extension,
// gateway, native-host, dz23, mcp), the tools (CLIs under _aitna/tools that are not tests), and the tests. An export seen
// only by tests, or by nobody, is reported.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PRODUCT_DIRS = ['extension', 'gateway', 'native-host', 'dz23', 'mcp']

function walk (directory, out = []) {
  let entries = []
  try {
    entries = readdirSync(directory)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'data')
        continue
      walk(path, out)
    } else if (/\.(mjs|js)$/.test(entry) && !/\.min\.js$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

const productFiles = PRODUCT_DIRS.flatMap((name) => walk(join(ROOT, name)))
const toolFiles = walk(join(ROOT, '_aitna')).filter((path) => !/\.test\.mjs$/.test(path))
const testFiles = walk(join(ROOT, '_aitna')).filter((path) => /\.test\.mjs$/.test(path))
  .concat(walk(join(ROOT, 'gateway')).filter((path) => /\.test\.mjs$/.test(path)))
  .concat(walk(join(ROOT, 'dz23')).filter((path) => /\.test\.mjs$/.test(path)))
  .concat(walk(join(ROOT, 'mcp')).filter((path) => /\.test\.mjs$/.test(path)))

const rel = (path) => relative(ROOT, path).replace(/\\/g, '/')

// API pública de biblioteca que não tem consumidor interno por decisão, não por esquecimento. Cada linha precisa do
// motivo: "é usado em outro projeto" não vale, "é a referência declarada para X" vale.
const JUSTIFIED = new Map([
  ['gateway/core.mjs:catalogEntry', 'consulta do catálogo de provedores: API do módulo, usada por inspeção e por quem embarca o catálogo'],
  ['mcp/tradingview-oauth.mjs:DEFAULT_AUTHORIZATION_SERVER', 'servidor de autorização documentado; a descoberta OAuth é dinâmica e não deve fixá-lo'],
  ['extension/quant/fromBacktest.mjs:attachTrades', 'exige lista de operações: o CSV de otimização do TradingView traz só o resumo por combinação, então a página não tem o que anexar'],
  ['extension/lib/candles.js:candlesUnavailable', 'forma canônica de "sem candles" para quem consome o módulo; o painel carrega o motivo junto do estado da aba'],
  ['extension/lib/chartContext.js:sameChart', 'compara aba + símbolo + timeframe; o painel invalida candles pela chave símbolo|timeframe de propósito, para não recarregar ao trocar de aba com o mesmo gráfico'],
  ['extension/lib/chartContext.js:createDebouncer', 'utilitário do módulo de contexto, usado internamente quando o chamador precisa agrupar atualizações'],
  ['mcp/tradingview-oauth.mjs:normalizeTokensForTest', 'o nome diz o propósito: exposto para o teste de contrato da normalização'],
])
const SELF = fileURLToPath(import.meta.url)
const readAll = (files) => files
  .filter((path) => path !== SELF)
  .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
const productText = readAll(productFiles)
const toolText = readAll(toolFiles.filter((path) => !productFiles.includes(path)))
const testText = readAll(testFiles)

// Nomes exportados por arquivo de produto.
const exports = []
for (const { path, text } of productText) {
  for (const match of text.matchAll(/export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/g)) {
    const name = match[1]
    exports.push({ file: rel(path), name })
  }
}

const occurrences = (name, population, { includeDeclaration = true } = {}) => {
  const pattern = new RegExp(`(?<![\\w$.])${name.replace(/[$]/g, '\\$')}(?![\\w$])`, 'g')
  let count = 0
  for (const { text } of population) {
    for (const match of text.matchAll(pattern)) {
      if (!includeDeclaration && /export\s+(?:async\s+)?(?:function|const|class|let)\s*$/.test(text.slice(Math.max(0, match.index - 40), match.index)))
        continue
      count += 1
    }
  }
  return count
}

const onlyInTests = []
const nowhere = []
const justified = []
for (const entry of exports) {
  const ownFile = productText.filter((item) => rel(item.path) === entry.file)
  const otherProduct = productText.filter((item) => rel(item.path) !== entry.file)
  // A própria declaração conta uma vez; o que importa é uso fora dela.
  const usesInOwnFile = occurrences(entry.name, ownFile) - 1
  const usesInProduct = occurrences(entry.name, otherProduct)
  const usesInTools = occurrences(entry.name, toolText)
  const usesInTests = occurrences(entry.name, testText)

  if (usesInOwnFile + usesInProduct + usesInTools === 0) {
    if (JUSTIFIED.has(`${entry.file}:${entry.name}`))
      justified.push({ ...entry, tests: usesInTests, why: JUSTIFIED.get(`${entry.file}:${entry.name}`) })
    else if (usesInTests > 0)
      onlyInTests.push({ ...entry, tests: usesInTests })
    else
      nowhere.push({ ...entry })
  }
}

for (const entry of onlyInTests)
  console.log(`SÓ EM TESTE   ${entry.file.padEnd(34)} ${entry.name} (${entry.tests} uso[s] em teste)`)
for (const entry of nowhere)
  console.log(`SEM USO       ${entry.file.padEnd(34)} ${entry.name}`)
for (const entry of justified)
  console.log(`API PÚBLICA   ${entry.file.padEnd(34)} ${entry.name} — ${entry.why}`)

const problems = onlyInTests.length + nowhere.length
console.log(JSON.stringify({
  passed: true,
  exports: exports.length,
  onlyInTests: onlyInTests.map((entry) => `${entry.file}:${entry.name}`),
  nowhere: nowhere.map((entry) => `${entry.file}:${entry.name}`),
  justified: justified.map((entry) => `${entry.file}:${entry.name}`),
  note: 'informativo: export usado só por teste ou por ninguém no produto',
  problems: nowhere.length,
}))
process.exit(0)

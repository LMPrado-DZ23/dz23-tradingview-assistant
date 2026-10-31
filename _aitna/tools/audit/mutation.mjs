#!/usr/bin/env node
// Mutation check: a test suite that passes against a deliberately broken module proves nothing.
//
// For each mutant it patches one line of a critical module, runs the suite that should notice, and requires that suite to
// FAIL. If the suite still passes, the mutation survived — the tests look at the code but do not check it.
//
// The file is restored from an in-memory copy in `finally`, and the SHA-256 is compared before and after, so a crash
// cannot leave the repository mutated silently.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TESTS = '_aitna/tools/extension-tests'

const MUTANTS = [
  {
    name: 'verifyAction aceita qualquer símbolo',
    file: 'extension/lib/chartActions.js',
    find: /export function verifyAction \(expected, observation\)/,
    mutate: (source) => source.replace(/(export function verifyAction \(expected, observation\) \{)/, '$1\n  if (expected) return { ok: true, mismatches: [] }'),
    test: `${TESTS}/chartActions.test.mjs`,
  },
  {
    name: 'validateConfig aprova qualquer coisa',
    file: 'extension/lib/config.js',
    find: /export function validateConfig/,
    mutate: (source) => source.replace(/(export function validateConfig[^{]*\{)/, '$1\n  if (arguments.length >= 0) return { ok: true, value: arguments[0], problems: [] }'),
    test: `${TESTS}/config.test.mjs`,
  },
  {
    name: 'alerta dispara sempre (sem fire-once)',
    file: 'extension/lib/alerts.js',
    find: /export function evaluateAlerts/,
    mutate: (source) => source.replace(/(export function evaluateAlerts[^{]*\{)/, '$1\n  if (Array.isArray(arguments[1]?.rules ?? arguments[1])) return { fired: [], skipped: [] }'),
    test: `${TESTS}/watchlist-alerts.test.mjs`,
  },
  {
    name: 'fallback troca de provedor mesmo com resposta boa',
    file: 'gateway/fallback.mjs',
    find: /export function isFallbackable/,
    mutate: (source) => source.replace(/(export function isFallbackable[^{]*\{)/, '$1\n  return true'),
    test: 'gateway/fallback.test.mjs',
  },
  {
    name: 'RSI devolve sempre 50',
    file: 'extension/lib/marketIntel.js',
    find: /export function rsiSeries|function rsiSeries/,
    mutate: (source) => source.replace(/(function rsiSeries[^{]*\{)/, '$1\n  return Array.from({ length: candles?.length ?? 0 }, () => 50)'),
    test: `${TESTS}/marketIntel.test.mjs`,
  },
  {
    name: 'parseVerdict aceita stance fora do contrato',
    file: 'extension/lib/agents.js',
    find: /export function parseVerdict/,
    mutate: (source) => source.replace(/(export function parseVerdict[^{]*\{)/, '$1\n  if (arguments.length >= 0) return { ok: true, verdict: { stance: "alta", confidence: 1, evidence: ["x"] } }'),
    test: `${TESTS}/agents.test.mjs`,
  },
  // O juiz destes dois não é uma suíte: é o fiscal de segurança. Um log com o token tem de reprovar o check.
  {
    name: 'host imprime o token no log',
    file: 'native-host/host.mjs',
    find: /function readToken \(\) \{/,
    mutate: (source) => source.replace('function readToken () {', 'function readToken () {\n  console.log(token)'),
    script: '_aitna/tools/security/check.mjs',
  },
  {
    name: 'CLI imprime a chave da API',
    file: 'mcp/tradingview-cli.mjs',
    find: /console\.log\(`autorizado/,
    mutate: (source) => source.replace('console.log(`autorizado', 'console.log(apiKey)\n  console.log(`autorizado'),
    script: '_aitna/tools/security/check.mjs',
  },
]

const runTest = (target, { script = false } = {}) => new Promise((resolve) => {
  execFile(process.execPath, script ? [target] : ['--test', target], { cwd: ROOT, timeout: 300_000, encoding: 'utf8' }, (error, stdout, stderr) => {
    resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout ?? ''}${stderr ?? ''}` })
  })
})

const sha = (text) => createHash('sha256').update(text).digest('hex')

const results = []
for (const mutant of MUTANTS) {
  const path = join(ROOT, mutant.file)
  const original = readFileSync(path, 'utf8')
  const originalHash = sha(original)
  const originalTimes = statSync(path)
  let outcome = 'survived'
  let detail = ''

  if (!mutant.find.test(original)) {
    results.push({ name: mutant.name, outcome: 'not_applicable', detail: 'ancora não encontrada — módulo mudou de forma, revisar o mutante' })
    continue
  }

  const mutated = mutant.mutate(original)
  if (mutated === original) {
    results.push({ name: mutant.name, outcome: 'not_applicable', detail: 'mutação não alterou o arquivo' })
    continue
  }

  try {
    writeFileSync(path, mutated)
    const run = await runTest(mutant.script ?? mutant.test, { script: Boolean(mutant.script) })
    if (run.code === 0) {
      outcome = 'survived'
      detail = 'a suíte passou com o módulo quebrado'
    } else {
      outcome = 'killed'
      // qual teste falhou, para o relatório mostrar que foi o teste certo
      const failing = (run.output.match(/^✖ (.+?) \(\d/gm) ?? []).map((line) => line.replace(/^✖ /, '').replace(/ \(\d.*$/, '')).slice(0, 2)
      detail = failing.length ? `pego por: ${failing.join(' | ')}` : 'suíte falhou'
    }
  } finally {
    writeFileSync(path, original)
    utimesSync(path, originalTimes.atime, originalTimes.mtime)
    const restored = readFileSync(path, 'utf8')
    if (sha(restored) !== originalHash) {
      console.error(JSON.stringify({ fatal: true, file: mutant.file, message: 'restauração falhou — hash diferente do original' }))
      process.exit(2)
    }
  }
  results.push({ name: mutant.name, outcome, detail })
}

const width = Math.max(...results.map((item) => item.name.length))
for (const item of results) {
  const label = item.outcome === 'killed' ? 'OK  ' : item.outcome === 'survived' ? 'FALHA' : 'N/A '
  console.log(`${label} ${item.name.padEnd(width)}  ${item.detail}`)
}

const survived = results.filter((item) => item.outcome === 'survived')
const applicable = results.filter((item) => item.outcome !== 'not_applicable')
console.log(JSON.stringify({
  passed: survived.length === 0 && applicable.length > 0,
  mutants: results.length,
  killed: results.filter((item) => item.outcome === 'killed').length,
  survived: survived.map((item) => item.name),
  notApplicable: results.filter((item) => item.outcome === 'not_applicable').map((item) => item.name),
}))
process.exit(survived.length === 0 ? 0 : 1)

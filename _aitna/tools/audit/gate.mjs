#!/usr/bin/env node
// Gate runner with evidence: every command must exit 0 **and** show that it actually did work.
//
// This exists because of a real defect: after the quant tests moved, `node --test "extension/quant/*.test.mjs"` matched
// zero files and exited 0 — a green check that had stopped checking. Each entry therefore declares a minimum of tests (for
// suites) or an output marker (for scripts), and a command that passes while producing nothing is reported as FAIL.
import { execFileSync, execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TOOLS = '_aitna/tools'

// minTests: o comando é um run de testes e precisa reportar ao menos isto. marker: texto obrigatório na saída.
const GATES = [
  { name: 'lint', shell: 'npx --yes eslint@10.13.0 .', markers: ['0 error'] },
  { name: 'i18n', argv: ['node', `${TOOLS}/i18n/cli.mjs`, 'check'], markers: ['0 error'] },
  { name: 'docs', argv: ['node', `${TOOLS}/docs/check.mjs`], markers: ['"passed":true'] },
  { name: 'security', argv: ['node', `${TOOLS}/security/check.mjs`], markers: ['"passed":true'] },
  { name: 'orphans', argv: ['node', `${TOOLS}/audit/orphans.mjs`], markers: ['"passed":true'] },
  { name: 'mutation', argv: ['node', `${TOOLS}/audit/mutation.mjs`], markers: ['"passed":true'], timeoutMs: 600_000 },
  { name: 'exports', argv: ['node', `${TOOLS}/audit/exports.mjs`], markers: ['"passed":true'] },
  { name: 'controls', argv: ['node', `${TOOLS}/audit/controls.mjs`], markers: ['"passed":true'] },
  { name: 'backup', argv: ['node', `${TOOLS}/backup/check.mjs`], markers: ['"passed":true'] },
  { name: 'perf-static', argv: ['node', `${TOOLS}/perf/check.mjs`], markers: ['"passed":true'] },
  { name: 'perf-pages', argv: ['node', `${TOOLS}/perf/pages.mjs`], markers: ['"passed":true'] },
  { name: 'tools', argv: ['node', '--test', `${TOOLS}/**/*.test.mjs`], minTests: 380, minPass: 380 },
  { name: 'quant', argv: ['node', '--test', `${TOOLS}/extension-tests/quant.test.mjs`, `${TOOLS}/extension-tests/fromBacktest.test.mjs`, `${TOOLS}/extension-tests/overfitting-contract.test.mjs`], minTests: 40, minPass: 40 },
  { name: 'strategy', argv: ['node', '--test', `${TOOLS}/extension-tests/compareStrategies.test.mjs`], minTests: 10, minPass: 10 },
  { name: 'gateway', argv: ['node', '--test', 'gateway/*.test.mjs'], minTests: 63, minPass: 63 },
  { name: 'dz23', argv: ['node', '--test', 'dz23/*.test.mjs', `${TOOLS}/extension-tests/dz23-send.test.mjs`], minTests: 14, minPass: 14 },
  { name: 'mcp', argv: ['node', '--test', 'mcp/*.test.mjs', `${TOOLS}/extension-tests/mcp-tradingview.test.mjs`], minTests: 15, minPass: 15 },
  { name: 'api-probe', argv: ['node', `${TOOLS}/e2e/api-probe.mjs`], markers: ['"passed":true'] },
  { name: 'bridge', argv: ['node', `${TOOLS}/e2e/bridge-e2e.mjs`], markers: ['"passed":true'] },
  { name: 'contrast', argv: ['node', `${TOOLS}/e2e/contrast-audit.mjs`], markers: ['TOTAL: 0 problema(s)'] },
  { name: 'a11y', argv: ['node', `${TOOLS}/e2e/a11y.mjs`], markers: ['"passed":true'] },
  { name: 'pine-ui', argv: ['node', `${TOOLS}/e2e/research-pine.mjs`], markers: ['"passed":true'] },
  { name: 'settings-ui', argv: ['node', `${TOOLS}/e2e/settings-page.mjs`], markers: ['"passed":true'] },
  { name: 'e2e', argv: ['node', `${TOOLS}/e2e/copilot-e2e.mjs`], markers: ['"passed": true'] },
  { name: 'audit', shell: 'npm audit --audit-level=high', markers: ['vulnerabilities'] },
  { name: 'icons', argv: ['node', `${TOOLS}/audit/icons.mjs`], markers: ['"passed":true'] },
  { name: 'identity', argv: ['node', `${TOOLS}/audit/identity.mjs`], markers: ['"passed":true'] },
  { name: 'readme', argv: ['node', `${TOOLS}/audit/readme.mjs`], markers: ['"passed":true'] },
  { name: 'numbers', argv: ['node', `${TOOLS}/audit/numbers.mjs`], markers: ['"passed":true'] },
  { name: 'test-files', argv: ['node', `${TOOLS}/audit/test-coverage.mjs`], markers: ['"passed":true'] },
  { name: 'permissions', argv: ['node', `${TOOLS}/audit/permissions.mjs`], markers: ['"passed":true'] },
  { name: 'secrets', argv: ['node', `${TOOLS}/audit/secrets.mjs`], markers: ['"passed":true'] },
  { name: 'package', argv: ['node', `${TOOLS}/audit/package.mjs`], markers: ['"passed":true'] },
  { name: 'release', argv: ['node', `${TOOLS}/release/cli.mjs`, 'check', '--offline', '--dev'], markers: ['"ok":true', '"ok": true'] },
]

function run (gate) {
  const started = Date.now()
  if (gate.shell) {
    try {
      const output = execSync(gate.shell, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000, shell: true })
      return { exit: 0, output, ms: Date.now() - started }
    } catch (error) {
      return { exit: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}`, ms: Date.now() - started }
    }
  }
  const [bin, ...args] = gate.argv
  try {
    const output = execFileSync(bin, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 })
    return { exit: 0, output, ms: Date.now() - started }
  } catch (error) {
    return { exit: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}`, ms: Date.now() - started }
  }
}

const number = (text, label) => {
  const match = new RegExp(`ℹ ${label} (\\d+)`).exec(text)
  return match ? Number(match[1]) : null
}

const results = []
for (const gate of GATES) {
  const { exit, output, ms } = run(gate)
  const problems = []
  if (exit !== 0)
    problems.push(`exit ${exit}`)
  if (gate.minTests !== undefined) {
    const tests = number(output, 'tests')
    const pass = number(output, 'pass')
    if (tests === null)
      problems.push('não reportou contagem de testes (o comando não rodou nenhuma suíte?)')
    else if (tests < gate.minTests)
      problems.push(`rodou ${tests} testes, mínimo ${gate.minTests} — glob vazio ou suíte sumindo`)
    if (pass !== null && gate.minPass !== undefined && pass < gate.minPass)
      problems.push(`passou ${pass}, mínimo ${gate.minPass}`)
  }
  if (gate.markers && !gate.markers.some((marker) => output.includes(marker)))
    problems.push(`saída sem o marcador esperado (${gate.markers.join(' | ')})`)
  results.push({ name: gate.name, exit, ms, tests: number(output, 'tests'), pass: number(output, 'pass'), problems })
}

const width = Math.max(...results.map((item) => item.name.length))
for (const item of results) {
  const detail = item.tests === null ? `${item.ms} ms` : `${item.tests} testes · ${item.pass} ok · ${item.ms} ms`
  console.log(`${item.problems.length ? 'FAIL' : 'PASS'}  ${item.name.padEnd(width)}  ${detail}${item.problems.length ? `  ← ${item.problems.join('; ')}` : ''}`)
}

const failures = results.filter((item) => item.problems.length)
console.log(JSON.stringify({ passed: failures.length === 0, gates: results.length, failures: failures.map((item) => item.name), totalTests: results.reduce((total, item) => total + (item.tests ?? 0), 0) }))
process.exit(failures.length === 0 ? 0 : 1)

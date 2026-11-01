#!/usr/bin/env node
// Acceptance report for §17 — delegating to the single gate runner instead of keeping a second list of commands.
//
// Before this, `accept` had its own copy of the commands and drifted from the real sweep twice (a suite moved, a wrong
// path). There is one authority: `_aitna/tools/audit/gate.mjs`. This file maps its verdicts to the §17 criteria, declares
// what cannot be proved here (EXTERNAL) and what is not implemented (ABSENT), and writes docs/ACEITACAO.json.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

// Hash do código da extensão: a evidência vale para ESTE código, não para um instante no relógio.
function sourceHash () {
  const hash = createHash('sha256')
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) {
        walk(path)
      } else if (/\.(js|mjs|html|css|json)$/.test(entry) && !/CHANGELOG/i.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(join(ROOT, 'extension'))
  for (const file of files.sort())
    hash.update(file.slice(ROOT.length)).update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))
  return { hash: hash.digest('hex'), files: files.length }
}

const source = sourceHash()

function runGate () {
  const started = Date.now()
  let output = ''
  try {
    output = execFileSync(process.execPath, [join(ROOT, '_aitna/tools/audit/gate.mjs')], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 1_800_000 })
  } catch (error) {
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }
  const summaryLine = output.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? '{}'
  let summary = {}
  try {
    summary = JSON.parse(summaryLine)
  } catch {
    summary = { passed: false, parseError: true }
  }
  const gates = {}
  for (const line of output.split('\n')) {
    const match = /^(PASS|FAIL)\s+(\S+)\s+(.*)$/.exec(line.trim())
    if (match)
      gates[match[2]] = { verdict: match[1], detail: match[3] }
  }
  return { summary, gates, ms: Date.now() - started }
}

const gate = runGate()

// §17: cada critério aponta para os gates que o provam.
const CRITERIA = [
  { id: 'config', criterion: 'Configuração centralizada e compartilhada por popup e copiloto', gates: ['tools'] },
  { id: 'gateway', criterion: 'Gateway inicia pelo mecanismo suportado e sobrevive ao host', gates: ['gateway'] },
  { id: 'cors', criterion: 'CORS e tokens protegidos (inclui origens desconhecidas)', gates: ['security'] },
  { id: 'security', criterion: 'Invariantes de segurança (§10) verificados em código', gates: ['security'] },
  { id: 'e2e', criterion: 'Pareamento, streaming, candles, contexto e ações verificáveis', gates: ['e2e'] },
  { id: 'bridge', criterion: 'Contexto do gráfico lido do DOM real do TradingView', gates: ['bridge'] },
  { id: 'pine', criterion: 'Pine Script: validação, geração e explicação', gates: ['tools'] },
  { id: 'quant', criterion: 'Strategy Lab: métricas reproduzíveis e comparação com viés', gates: ['quant', 'strategy'] },
  { id: 'perf', criterion: 'Orçamento de desempenho (estático e páginas reais)', gates: ['perf-static', 'perf-pages'] },
  { id: 'a11y', criterion: 'Acessibilidade medida (WCAG) nas telas', gates: ['a11y'] },
  { id: 'ui', criterion: 'Telas: configurações, watchlists, alertas, pesquisa, contraste', gates: ['settings-ui', 'pine-ui', 'contrast'] },
  { id: 'docs', criterion: 'Documentação coerente (comando e arquivo citados existem)', gates: ['docs'] },
  { id: 'orphans', criterion: 'Nenhum arquivo órfão ou referência quebrada no pacote', gates: ['orphans'] },
  { id: 'backup', criterion: 'Backup íntegro e rollback ensaiado', gates: ['backup'] },
  { id: 'package', criterion: 'Pacote de distribuição íntegro', gates: ['release'] },
  { id: 'audit', criterion: 'Dependências sem vulnerabilidade alta e código sem erro de lint', gates: ['audit', 'lint'] },
]

const checks = CRITERIA.map((entry) => {
  const results = entry.gates.map((name) => ({ name, ...(gate.gates[name] ?? { verdict: 'MISSING', detail: 'gate não executou' }) }))
  const verdict = results.every((item) => item.verdict === 'PASS') ? 'PASS' : 'FAIL'
  return { id: entry.id, criterion: entry.criterion, gates: results, verdict }
})

const external = [
  { id: 'mcp', criterion: 'MCP oficial: tools/list com token real', verdict: 'EXTERNAL', why: 'o servidor responde "É necessário um plano pago" para esta conta (tradingview.com/mcp/oauth/authorize)' },
  { id: 'chrome', criterion: 'Extensão carregada no Chrome do usuário após as mudanças', verdict: 'EXTERNAL', why: 'exige chrome://extensions → ↻ pelo dono; o Chrome 155 não aceita --load-extension' },
]
const absent = [
  { id: 'draw', criterion: 'Desenhar linhas/zonas/Fibonacci, layouts e aplicar Pine no gráfico', verdict: 'ABSENT', why: 'sem API pública; exigiria automação do DOM do chart, não verificável aqui' },
  { id: 'news', criterion: 'Notícias, fundamentos, calendário econômico, eventos corporativos', verdict: 'ABSENT', why: 'sem fonte licenciada integrada; não foi simulado' },
]

const failed = checks.filter((item) => item.verdict !== 'PASS')
const report = {
  generatedAt: new Date().toISOString(),
  platform: process.platform,
  node: process.version,
  source: { hash: source.hash, files: source.files },
  gate: {
    passed: Boolean(gate.summary.passed),
    gates: gate.summary.gates ?? null,
    totalTests: gate.summary.totalTests ?? null,
    failures: gate.summary.failures ?? [],
    ms: gate.ms,
  },
  summary: {
    criteria: checks.length,
    pass: checks.filter((item) => item.verdict === 'PASS').length,
    fail: failed.length,
    external: external.length,
    absent: absent.length,
  },
  checks: [...checks, ...external, ...absent],
}

writeFileSync(join(ROOT, 'docs', 'ACEITACAO.json'), `${JSON.stringify(report, null, 2)}\n`)

for (const item of report.checks) {
  if (item.gates)
    console.log(`${item.verdict.padEnd(8)} ${item.id.padEnd(9)} ${item.criterion} ← ${item.gates.map((entry) => `${entry.name}:${entry.verdict}`).join(', ')}`)
  else
    console.log(`${item.verdict.padEnd(8)} ${item.id.padEnd(9)} ${item.criterion}${item.why ? ` — ${item.why}` : ''}`)
}
console.log(JSON.stringify({ ok: failed.length === 0 && Boolean(gate.summary.passed), gateGates: gate.summary.gates ?? null, totalTests: gate.summary.totalTests ?? null, ...report.summary }))
process.exit(failed.length === 0 && gate.summary.passed ? 0 : 1)

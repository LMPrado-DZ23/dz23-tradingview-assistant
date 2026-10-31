#!/usr/bin/env node
// Nenhum segredo versionado. O primeiro commit passou por uma varredura manual; varredura manual não se repete sozinha,
// então ela vira gate. Um token que entra no histórico fica lá para sempre — mesmo depois de apagado do arquivo.
//
// Regras:
//   1. caminhos proibidos nunca podem estar rastreados (config do gateway, .env, chaves, artefatos de build);
//   2. conteúdo de arquivo rastreado não pode casar com padrões de credencial;
//   3. strings de teste óbvias (probe, exemplo, 0123456789) são permitidas — e a lista é curta de propósito.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const FORBIDDEN_PATHS = [
  { test: (path) => /(^|\/)gateway\/config(\.local)?\.json$/.test(path), why: 'config do gateway guarda o token de acesso' },
  { test: (path) => /(^|\/)\.env($|\.)/.test(path), why: 'variáveis de ambiente podem conter chaves' },
  { test: (path) => /\.(pem|key|p12|pfx)$/.test(path), why: 'material de chave privada' },
  { test: (path) => /(^|\/)node_modules\//.test(path), why: 'dependências não são versionadas' },
  { test: (path) => /\.zip$/.test(path), why: 'artefato de build é reconstruído por npm run release:pack' },
  { test: (path) => /(^|\/)_aitna\/\.browser\//.test(path), why: 'perfil de navegador pode conter sessão de login' },
  { test: (path) => /(^|\/)\.dz23\//.test(path), why: 'estado local do gateway' },
]

// Padrões de credencial, curtos e específicos para não gerar ruído.
const SECRET_PATTERNS = [
  { regex: /sk-[A-Za-z0-9]{20,}/, why: 'chave no formato OpenAI/DeepSeek' },
  { regex: /AIza[A-Za-z0-9_-]{30,}/, why: 'chave do Google' },
  { regex: /ghp_[A-Za-z0-9]{30,}/, why: 'token do GitHub' },
  { regex: /xox[baprs]-[A-Za-z0-9-]{10,}/, why: 'token do Slack' },
  { regex: /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, why: 'chave privada' },
]

// Fixtures de teste citam credenciais de mentira de propósito; a marca precisa ser explícita na própria linha.
const FIXTURE_MARKERS = /probe|fixture|exemplo|example|dummy|placeholder|0123456789|fake|redact|token-errado/i

const TEXT_EXTENSIONS = /\.(js|mjs|cjs|json|md|html|css|txt|yml|yaml|cmd|ps1|sh|toml)$/i

function trackedFiles () {
  const output = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  return output.split('\0').filter(Boolean)
}

const problems = []
const notes = []

let files
try {
  files = trackedFiles()
} catch (error) {
  console.log(JSON.stringify({ passed: false, error: `git ls-files falhou: ${String(error.message).slice(0, 120)}` }))
  process.exit(1)
}

if (!files.length) {
  console.log(JSON.stringify({ passed: false, error: 'nenhum arquivo rastreado: o repositório está vazio' }))
  process.exit(1)
}

// 1. caminhos proibidos
for (const file of files) {
  for (const rule of FORBIDDEN_PATHS) {
    if (rule.test(file)) {
      problems.push({ kind: 'forbidden_path', file, why: rule.why })
      break
    }
  }
}

// 2. conteúdo
let scanned = 0
for (const file of files) {
  if (!TEXT_EXTENSIONS.test(file))
    continue
  let source
  try {
    source = readFileSync(join(ROOT, file), 'utf8')
  } catch {
    continue
  }
  scanned += 1
  const lines = source.split('\n')
  for (const [index, line] of lines.entries()) {
    if (FIXTURE_MARKERS.test(line))
      continue
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(line)) {
        problems.push({ kind: 'secret_in_content', file, line: index + 1, why: pattern.why })
        break
      }
    }
  }
}

const ignored = (() => {
  try {
    return execFileSync('git', ['status', '--ignored', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .filter((line) => line.startsWith('!!'))
      .length
  } catch {
    return 0
  }
})()

notes.push(`arquivos rastreados: ${files.length}`)
notes.push(`arquivos de texto varridos: ${scanned}`)
notes.push(`entradas ignoradas por .gitignore: ${ignored}`)
if (ignored === 0)
  notes.push('aviso: nada ignorado — confirme que o .gitignore está sendo aplicado')

for (const note of notes)
  console.log(`ok    ${note}`)
for (const problem of problems)
  console.log(`FAIL  ${problem.kind}: ${problem.file}${problem.line ? `:${problem.line}` : ''} — ${problem.why}`)
console.log(JSON.stringify({ passed: problems.length === 0, files: files.length, scanned, problems }))
process.exit(problems.length === 0 ? 0 : 1)

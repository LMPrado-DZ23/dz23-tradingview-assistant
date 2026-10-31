#!/usr/bin/env node
// The artifact, not the repository.
//
// Every other check inspects the source tree; a package can still be broken — a file the manifest references left out, a
// test swept in, a credential, an empty entry. This opens assistant-ext.zip and verifies what actually ships.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { manifestReferencedFiles } from '../release/lib.mjs'
import { readZipEntry, readZipIndex } from '../release/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// O caminho pode vir como argumento para o teste apontar um pacote deliberadamente quebrado.
const ZIP = process.argv[2] ? process.argv[2] : join(ROOT, 'assistant-ext.zip')

if (!existsSync(ZIP)) {
  console.error(JSON.stringify({ passed: false, error: 'assistant-ext.zip não existe: rode `npm run release:pack`' }))
  process.exit(1)
}

const bytes = readFileSync(ZIP)
const { names } = readZipIndex(ZIP)
const problems = []

// 1. manifest presente e parseável
let manifest = null
if (!names.includes('manifest.json')) {
  problems.push({ kind: 'no_manifest', detail: 'sem manifest.json na raiz: a extensão não carrega' })
} else {
  try {
    manifest = JSON.parse(readZipEntry(ZIP, 'manifest.json').toString('utf8'))
  } catch (error) {
    problems.push({ kind: 'bad_manifest', detail: String(error.message).slice(0, 120) })
  }
}

// 2. tudo que o manifest referencia existe DENTRO do pacote
// manifestReferencedFiles devolve { files, globs }: caminhos exatos e padrões (ícones, _locales).
const cleanPath = (path) => normalize(path).split(String.fromCharCode(92)).join('/')
const matchesGlob = (name, glob) => {
  let pattern = '^'
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]
    if (char === '*' && glob[index + 1] === '*') {
      pattern += '.*'
      index++
    } else if (char === '*') {
      pattern += '[^/]*'
    } else if (char === '?') {
      pattern += '[^/]'
    } else {
      pattern += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${pattern}$`).test(name)
}
if (manifest) {
  const { files: exact, globs } = manifestReferencedFiles(manifest)
  const missing = exact.map(cleanPath).filter((path) => !names.includes(path))
  for (const glob of globs) {
    if (!names.some((name) => matchesGlob(name, cleanPath(glob))))
      missing.push(`${glob} (nenhum arquivo casa)`)
  }
  if (missing.length)
    problems.push({ kind: 'missing_referenced', detail: missing.slice(0, 8).join(', ') })
}

// 3. nada proibido viaja junto
const rules = [
  { pattern: /(^|\/)node_modules\//, why: 'dependência instalada' },
  { pattern: /\.test\.(mjs|js)$/, why: 'arquivo de teste' },
  { pattern: /(^|\/)\.env/, why: 'arquivo de ambiente' },
  { pattern: /\.(pem|key|p12|pfx)$/, why: 'material de chave' },
  { pattern: /(^|\/)(gateway-token|tradingview-mcp\.json)$/, why: 'credencial' },
  { pattern: /(^|\/)\.DS_Store$/, why: 'lixo de sistema' },
  { pattern: /(^|\/)(package-lock\.json|pnpm-lock\.yaml)$/, why: 'lockfile de desenvolvimento' },
]
const violations = names.filter((name) => rules.some((rule) => rule.pattern.test(name)))
if (violations.length) {
  const detail = violations.slice(0, 6).map((name) => `${name} (${rules.find((rule) => rule.pattern.test(name)).why})`)
  problems.push({ kind: 'forbidden_entry', detail: detail.join(', ') })
}

// 4. entrada vazia quase sempre é arquivo esquecido no include
const empty = names.filter((name) => readZipEntry(ZIP, name).length === 0)
if (empty.length)
  problems.push({ kind: 'empty_entry', detail: empty.slice(0, 6).join(', ') })

// 5. o manifest empacotado precisa carregar a chave (id estável) e ser MV3
if (manifest) {
  if (!manifest.key)
    problems.push({ kind: 'no_key', detail: 'sem `key`: o id voltaria a depender da pasta' })
  if (manifest.manifest_version !== 3)
    problems.push({ kind: 'not_mv3', detail: `manifest_version ${manifest.manifest_version}` })
}

const sha256 = createHash('sha256').update(bytes).digest('hex')
console.log(`pacote: ${names.length} entradas · ${(bytes.length / 1024).toFixed(1)} KB · versão ${manifest?.version ?? '—'}`)
console.log(`sha256: ${sha256}`)
for (const problem of problems)
  console.log(`FAIL ${problem.kind}: ${problem.detail}`)
console.log(JSON.stringify({ passed: problems.length === 0, entries: names.length, version: manifest?.version ?? null, sha256, problems }))
process.exit(problems.length === 0 ? 0 : 1)

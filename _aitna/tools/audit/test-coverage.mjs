#!/usr/bin/env node
// Nenhum arquivo de teste fica fora do gate.
//
// Isto existe por um defeito real: o gate listava três arquivos de teste do gateway à mão e deixava `core.test.mjs` de
// fora. Esse arquivo ficou falhando em silêncio por quinze rodadas — o gate dizia "42 testes, tudo verde" enquanto o
// quarto arquivo nunca rodava. Lista escrita à mão sempre diverge do disco; este auditor compara os dois.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const GATE = join(ROOT, '_aitna', 'tools', 'audit', 'gate.mjs')

const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage', 'dist', 'docs'])

function walk (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(entry))
        walk(path, out)
    } else if (/\.test\.mjs$/.test(entry)) {
      out.push(relative(ROOT, path).replace(/\\/g, '/'))
    }
  }
  return out
}

// Padrões que o gate declara: cada string do argv que pareça caminho ou glob.
const gateSource = readFileSync(GATE, 'utf8')
const declared = [...gateSource.matchAll(/[`']([^`'\n]*\.test\.mjs[^`'\n]*)[`']/g)].map((match) => match[1])
const TOOLS = join(ROOT, '_aitna', 'tools')
const expanded = declared.map((pattern) => pattern
  .replace(/\$\{TOOLS\}/g, '_aitna/tools')
  .replace(/\\/g, '/'))

function globToRegExp (pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
  return new RegExp(`^${escaped}$`)
}

const testFiles = walk(ROOT).sort()
const unmatched = testFiles.filter((file) => !expanded.some((pattern) => {
  // os padrões do gate são relativos à raiz, sem "./"
  const normalized = pattern.replace(/^\.\//, '')
  return globToRegExp(normalized).test(file) || normalized === file
}))

for (const file of testFiles)
  console.log(`${unmatched.includes(file) ? 'FORA ' : 'ok   '} ${file}`)
for (const pattern of expanded)
  console.log(`      padrão no gate: ${pattern}`)
console.log(JSON.stringify({
  passed: unmatched.length === 0,
  testFiles: testFiles.length,
  patterns: expanded.length,
  unmatched,
}))
process.exit(unmatched.length === 0 ? 0 : 1)

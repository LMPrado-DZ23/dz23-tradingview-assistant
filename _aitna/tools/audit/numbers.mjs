#!/usr/bin/env node
// The report's numbers, checked against the artifact they describe.
//
// Three claims in docs/ENTREGA.md had silently drifted (coverage, perf, a11y) because nothing compared the document with
// reality. Running every suite here would triple the gate, so this checks what is cheap and verifiable — packaging count,
// version, gate count — and, most importantly, whether the acceptance evidence is **older than the code it describes**.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZipIndex } from '../release/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const entrega = readFileSync(join(ROOT, 'docs/ENTREGA.md'), 'utf8')
const problems = []
const notes = []

// 1. contagem de arquivos do pacote
const zipPath = join(ROOT, 'assistant-ext.zip')
let entries = null
try {
  entries = readZipIndex(zipPath).names.length
} catch {
  problems.push({ kind: 'missing_package', detail: 'assistant-ext.zip não existe: rode npm run release:pack' })
}
const claimedFiles = /pacote:\s+assistant-ext\.zip · (\d+) arquivos/.exec(entrega)?.[1]
if (entries !== null && claimedFiles !== undefined) {
  if (Number(claimedFiles) !== entries)
    problems.push({ kind: 'files_mismatch', detail: `ENTREGA diz ${claimedFiles} arquivos, o ZIP tem ${entries}` })
  else
    notes.push(`arquivos no pacote: ${entries} (confere)`)
}

// 2. versão
const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'))
const claimedVersion = /pacote:\s+assistant-ext\.zip · \d+ arquivos · v([\d.]+)/.exec(entrega)?.[1]
if (claimedVersion !== undefined) {
  if (claimedVersion !== manifest.version)
    problems.push({ kind: 'version_mismatch', detail: `ENTREGA diz v${claimedVersion}, o manifest diz v${manifest.version}` })
  else
    notes.push(`versão: v${manifest.version} (confere)`)
}

// 3. quantidade de verificações do gate
const gateSource = readFileSync(join(ROOT, '_aitna/tools/audit/gate.mjs'), 'utf8')
const gateCount = (gateSource.match(/^\s*\{ name: '/gm) ?? []).length
const claimedGates = /(\d+) verificações/.exec(entrega)?.[1]
if (claimedGates !== undefined) {
  if (Number(claimedGates) !== gateCount)
    problems.push({ kind: 'gates_mismatch', detail: `ENTREGA diz ${claimedGates} verificações, gate.mjs define ${gateCount}` })
  else
    notes.push(`verificações do gate: ${gateCount} (confere)`)
}

// 4. a evidência do aceite é mais velha que o código que ela descreve?
function sourceHash () {
  const hash = createHash('sha256')
  const files = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry)
      const info = statSync(path)
      if (info.isDirectory()) {
        walk(path)
      } else if (/\.(js|mjs|html|css|json)$/.test(entry) && !/CHANGELOG/i.test(entry)) {
        files.push(path)
      }
    }
  }
  walk(join(ROOT, 'extension'))
  for (const file of files.sort())
    hash.update(file.slice(ROOT.length)).update(readFileSync(file))
  return hash.digest('hex')
}

function newest (directory, out = 0) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    const info = statSync(path)
    if (info.isDirectory()) {
      out = newest(path, out)
    } else if (/\.(js|mjs|html|css|json)$/.test(entry) && !/CHANGELOG/i.test(entry)) {
      out = Math.max(out, info.mtimeMs)
    }
  }
  return out
}
const newestSource = newest(join(ROOT, 'extension'))
let acceptance = null
try {
  acceptance = JSON.parse(readFileSync(join(ROOT, 'docs/ACEITACAO.json'), 'utf8'))
} catch {
  problems.push({ kind: 'missing_acceptance', detail: 'docs/ACEITACAO.json não existe: rode npm run accept' })
}
if (acceptance) {
  if (acceptance.source?.hash) {
    // O hash é a comparação certa: mtime muda quando a auditoria de mutação reescreve e restaura um arquivo,
    // e a evidência continuaria perfeitamente válida.
    const current = sourceHash()
    if (current !== acceptance.source.hash)
      problems.push({ kind: 'acceptance_stale', detail: 'o código da extensão mudou desde o relatório de aceite: rode npm run accept de novo' })
    else
      notes.push('aceite descreve exatamente o código atual (hash confere)')
  } else {
  const generatedAt = Date.parse(acceptance.generatedAt ?? '')
  if (!Number.isFinite(generatedAt)) {
    problems.push({ kind: 'acceptance_no_date', detail: 'ACEITACAO.json sem generatedAt' })
  } else if (newestSource > generatedAt) {
    const minutes = Math.round((newestSource - generatedAt) / 60_000)
    problems.push({
      kind: 'acceptance_stale',
      detail: `a extensão mudou ${minutes} min depois do relatório de aceite: rode npm run accept de novo`,
    })
  } else {
    notes.push('aceite gerado depois da última mudança em extension/ (confere)')
  }
  }
}

for (const note of notes)
  console.log(`ok    ${note}`)
for (const problem of problems)
  console.log(`FAIL  ${problem.kind}: ${problem.detail}`)
console.log(JSON.stringify({ passed: problems.length === 0, notes: notes.length, problems }))
process.exit(problems.length === 0 ? 0 : 1)

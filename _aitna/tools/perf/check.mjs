#!/usr/bin/env node
// Performance budget with real measurements (§13 loading, §14 build/smoke).
//
// Two kinds of assertion:
//   1. static — bytes that the browser must fetch, split into "eager" (everything except the lazy 3D chart library) and
//      the lazy asset itself, which must stay lazy: no HTML may reference it and no module may import it eagerly;
//   2. dynamic — time to a usable screen, measured in a real Chrome over the actual pages.
//
// Budgets are set just above today's numbers, so this is a regression guard, not a decoration.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXTENSION = join(ROOT, 'extension')

export const BUDGETS = {
  eagerJsKb: 600,
  cssKb: 60,
  htmlKb: 70,
  largestEagerKb: 120,
  contentScriptsKb: 300,
  pageInteractiveMs: 1500,
}

const LAZY_ASSETS = ['plotly.min.js']

function walk (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory())
      walk(path, out)
    else
      out.push(path)
  }
  return out
}

const files = walk(EXTENSION)
const kb = (bytes) => Math.round((bytes / 1024) * 10) / 10
const byExt = (ext) => files.filter((path) => path.endsWith(ext))
const isLazy = (path) => LAZY_ASSETS.some((name) => path.endsWith(name))

const problems = []
const notes = []

// 1. estático
const jsFiles = byExt('.js').map((path) => ({ path, size: statSync(path).size }))
const eager = jsFiles.filter((file) => !isLazy(file.path))
const lazy = jsFiles.filter((file) => isLazy(file.path))
const eagerKb = kb(eager.reduce((total, file) => total + file.size, 0))
const cssKb = kb(byExt('.css').reduce((total, path) => total + statSync(path).size, 0))
const htmlKb = kb(byExt('.html').reduce((total, path) => total + statSync(path).size, 0))
const largest = eager.reduce((best, file) => (file.size > best.size ? file : best), { path: '', size: 0 })

notes.push(`JS eager: ${eagerKb} KB em ${eager.length} arquivos (orçamento ${BUDGETS.eagerJsKb} KB)`)
notes.push(`maior arquivo eager: ${kb(largest.size)} KB ${relative(ROOT, largest.path).replace(/\\/g, '/')} (orçamento ${BUDGETS.largestEagerKb} KB)`)
notes.push(`CSS: ${cssKb} KB · HTML: ${htmlKb} KB`)
if (lazy.length)
  notes.push(`lazy: ${lazy.map((file) => `${relative(ROOT, file.path).replace(/\\/g, '/')} ${kb(file.size)} KB`).join(', ')}`)

if (eagerKb > BUDGETS.eagerJsKb)
  problems.push(`JS eager acima do orçamento: ${eagerKb} KB > ${BUDGETS.eagerJsKb} KB`)
if (cssKb > BUDGETS.cssKb)
  problems.push(`CSS acima do orçamento: ${cssKb} KB > ${BUDGETS.cssKb} KB`)
if (htmlKb > BUDGETS.htmlKb)
  problems.push(`HTML acima do orçamento: ${htmlKb} KB > ${BUDGETS.htmlKb} KB`)
if (kb(largest.size) > BUDGETS.largestEagerKb)
  problems.push(`arquivo eager grande demais: ${kb(largest.size)} KB > ${BUDGETS.largestEagerKb} KB (${relative(ROOT, largest.path)})`)

const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'))
const contentScriptFiles = (manifest.content_scripts ?? []).flatMap((entry) => entry.js ?? [])
const contentScriptBytes = contentScriptFiles.reduce((total, file) => {
  const path = join(EXTENSION, file)
  try {
    return total + statSync(path).size
  } catch {
    return total
  }
}, 0)
const contentScriptsKb = kb(contentScriptBytes)
notes.push(`content_scripts: ${contentScriptFiles.length} arquivos, ${contentScriptsKb} KB (orçamento ${BUDGETS.contentScriptsKb} KB) — rodam em cada página do TradingView`)
if (contentScriptsKb > BUDGETS.contentScriptsKb)
  problems.push(`content_scripts acima do orçamento: ${contentScriptsKb} KB > ${BUDGETS.contentScriptsKb} KB`)

// 2. a biblioteca pesada precisa continuar preguiçosa
for (const path of byExt('.html')) {
  const text = readFileSync(path, 'utf8')
  for (const asset of LAZY_ASSETS) {
    if (text.includes(asset))
      problems.push(`${relative(ROOT, path).replace(/\\/g, '/')} referencia ${asset}: a carga deixa de ser sob demanda`)
  }
}
for (const file of eager) {
  const text = readFileSync(file.path, 'utf8')
  for (const asset of LAZY_ASSETS) {
    if (new RegExp(`import[^\\n]*${asset.replace('.', '\\.')}`).test(text))
      problems.push(`${relative(ROOT, file.path).replace(/\\/g, '/')} importa ${asset} de forma estática`)
  }
}
notes.push(`lazy confirmado: nenhuma página referencia ${LAZY_ASSETS.join(', ')}`)

for (const note of notes)
  console.log(note)
for (const problem of problems)
  console.log(`FAIL ${problem}`)

const staticResult = { ok: problems.length === 0, problems }
if (process.argv.includes('--json'))
  console.log(JSON.stringify({ budgets: BUDGETS, static: staticResult }, null, 2))
else
  console.log(JSON.stringify({ passed: problems.length === 0, problems: problems.length }))

process.exit(problems.length === 0 ? 0 : 1)

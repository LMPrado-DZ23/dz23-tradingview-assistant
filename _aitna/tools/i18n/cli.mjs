#!/usr/bin/env node
// Localization tool for the extension catalogs (extension/_locales/<locale>/messages.json).
//
//   node _aitna/tools/i18n/cli.mjs check [--json]
//       Verify the catalogs and every reference to them: translation parity, placeholders, reserved
//       characters, keys that no file uses, references to keys that do not exist.
//
//   node _aitna/tools/i18n/cli.mjs merge
//       Move the per-area fragments in extension/_locales/.frag/ into the catalogs. A fragment pair is
//       "<namespace>.en.json" + "<namespace>.pt_BR.json" with the same keys; fragments are removed after
//       a successful merge, so parallel work can add keys without editing the catalogs directly.
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SKIP_SOURCE_FILES,
  checkCatalogEntries,
  checkTranslationParity,
  checkUsage,
  extractKeys,
  formatCatalog,
  summarize,
  toCatalogMap,
} from './lib.mjs'

const REFERENCE_LOCALE = 'en'
const SOURCE_EXTENSIONS = ['.js', '.html', '.json']
const FRAGMENT_DIR = '.frag'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const extensionDir = join(repoRoot, 'extension')
const localesDir = join(extensionDir, '_locales')

function listFiles (dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '_locales' || entry.name === 'node_modules')
        continue
      files.push(...listFiles(path))
    } else if (!SKIP_SOURCE_FILES.has(entry.name) && SOURCE_EXTENSIONS.includes(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(path)
    }
  }
  return files
}

function loadCatalogs () {
  const problems = []
  const catalogs = new Map()
  if (!existsSync(localesDir)) {
    problems.push({ level: 'error', code: 'locales_missing', message: `no locales directory at ${relative(repoRoot, localesDir)}` })
    return { catalogs, problems }
  }
  for (const locale of readdirSync(localesDir).sort()) {
    if (locale.startsWith('.'))
      continue
    const file = join(localesDir, locale, 'messages.json')
    if (!existsSync(file))
      continue
    try {
      catalogs.set(locale, toCatalogMap(JSON.parse(readFileSync(file, 'utf8'))))
    } catch (err) {
      problems.push({ level: 'error', code: 'invalid_json', message: `${relative(repoRoot, file)}: ${err.message}` })
    }
  }
  return { catalogs, problems }
}

function collectUsage () {
  const usage = []
  for (const file of listFiles(extensionDir)) {
    const source = readFileSync(file, 'utf8')
    for (const key of extractKeys(source))
      usage.push({ key, file: relative(repoRoot, file) })
  }
  return usage
}

function sortProblems (problems) {
  return problems.sort((left, right) =>
    left.level.localeCompare(right.level) || left.message.localeCompare(right.message))
}

const PT_BR_ONLY = new Map([
  ['extension/copilot/index.html', 'painel do DZ23: escrito em pt-BR por decisão, junto com a documentação e os relatórios'],
  ['extension/settings/index.html', 'tela de configurações: pt-BR por decisão, mesma razão do painel'],
  ['extension/research/index.html', 'página de pesquisa: pt-BR por decisão, mesma razão do painel'],
])

// Uma superfície está "localizada" se referencia o catálogo; senão precisa estar declarada acima.
function checkSurfaceLocalization () {
  const problems = []
  for (const file of listFiles(extensionDir)) {
    if (!/\.html$/.test(file))
      continue
    const source = readFileSync(file, 'utf8')
    const path = relative(repoRoot, file).replace(/\\/g, '/')
    const localized = /i18n\.t\(|data-i18n=/.test(source)
    const declared = PT_BR_ONLY.has(path)
    if (!localized && !declared)
      problems.push({ level: 'error', code: 'surface_not_localized', message: `${path} tem texto visível e não usa o catálogo nem declara pt-BR-only` })
    if (localized && declared)
      problems.push({ level: 'error', code: 'surface_declared_and_localized', message: `${path} está na lista pt-BR-only mas usa o catálogo: remova da lista` })
  }
  return problems
}

function check () {
  const { catalogs, problems } = loadCatalogs()
  const referenceCatalog = catalogs.get(REFERENCE_LOCALE)
  if (!referenceCatalog)
    return [...problems, { level: 'error', code: 'reference_missing', message: `no "${REFERENCE_LOCALE}" catalog` }]

  for (const [locale, catalog] of catalogs)
    problems.push(...checkCatalogEntries(catalog, locale))
  problems.push(...checkTranslationParity(catalogs, REFERENCE_LOCALE))
  problems.push(...checkUsage(collectUsage(), referenceCatalog))
  problems.push(...checkSurfaceLocalization())
  return sortProblems(problems)
}

function parseFragment (file) {
  const json = JSON.parse(readFileSync(file, 'utf8'))
  for (const [key, value] of Object.entries(json)) {
    if (!value || typeof value.message !== 'string')
      throw new Error(`${file}: "${key}" must be { "message": "<text>" }`)
  }
  return toCatalogMap(json)
}

function merge () {
  const fragmentDir = join(localesDir, FRAGMENT_DIR)
  if (!existsSync(fragmentDir))
    return { problems: [], merged: 0 }
  const { catalogs, problems } = loadCatalogs()
  if (problems.length)
    return { problems, merged: 0 }

  const namespaces = new Set()
  for (const name of readdirSync(fragmentDir)) {
    const match = name.match(/^(.+)\.(.+)\.json$/)
    if (match)
      namespaces.add(match[1])
  }

  let merged = 0
  const fragmentFiles = []
  for (const namespace of [...namespaces].sort()) {
    const files = new Map()
    for (const locale of catalogs.keys()) {
      const file = join(fragmentDir, `${namespace}.${locale}.json`)
      if (!existsSync(file)) {
        problems.push({ level: 'error', code: 'fragment_incomplete', message: `fragment "${namespace}" has no ${locale} part` })
        continue
      }
      files.set(locale, file)
    }
    if (files.size !== catalogs.size)
      continue

    const fragments = new Map()
    for (const [locale, file] of files) {
      try {
        fragments.set(locale, parseFragment(file))
      } catch (err) {
        problems.push({ level: 'error', code: 'fragment_invalid', message: err.message })
      }
    }
    if (fragments.size !== files.size)
      continue

    const entries = [...fragments].map(([locale, catalog]) => [locale, catalog])
    for (const [locale, catalog] of entries)
      problems.push(...checkCatalogEntries(catalog, `${locale} (fragment ${namespace})`))
    for (const [locale, catalog] of entries) {
      const reference = fragments.get(REFERENCE_LOCALE)
      if (!reference || locale === REFERENCE_LOCALE)
        continue
      for (const key of reference.keys())
        if (!catalog.has(key))
          problems.push({ level: 'error', code: 'fragment_mismatch', message: `fragment ${namespace}: the ${locale} part has no "${key}"` })
      for (const key of catalog.keys())
        if (!reference.has(key))
          problems.push({ level: 'error', code: 'fragment_mismatch', message: `fragment ${namespace}: "${key}" is not in the ${REFERENCE_LOCALE} part` })
    }

    for (const [locale, catalog] of entries) {
      const target = catalogs.get(locale)
      for (const [key, message] of catalog) {
        if (!target.has(key)) {
          target.set(key, message)
          merged++
          continue
        }
        if (target.get(key) !== message)
          problems.push({ level: 'error', code: 'key_conflict', message: `${locale}: "${key}" already exists with another text` })
      }
    }
    fragmentFiles.push(...files.values())
  }

  if (problems.some(item => item.level === 'error'))
    return { problems: sortProblems(problems), merged: 0 }

  for (const [locale, catalog] of catalogs)
    writeFileSync(join(localesDir, locale, 'messages.json'), formatCatalog(catalog), 'utf8')
  for (const file of fragmentFiles)
    rmSync(file, { force: true })
  if (!readdirSync(fragmentDir).length)
    rmSync(fragmentDir, { recursive: true, force: true })
  return { problems: sortProblems(problems), merged }
}

function printProblems (problems) {
  for (const item of problems) {
    const mark = item.level === 'error' ? 'error  ' : 'warning'
    console.log(`  ${mark}  ${item.code.padEnd(20)}  ${item.message}`)
  }
}

function main (argv) {
  const command = argv[0] || 'check'
  if (command === 'check') {
    const problems = check()
    const counts = summarize(problems)
    console.log(`i18n check — ${relative(repoRoot, extensionDir)}`)
    printProblems(problems)
    console.log(`${counts.errors} error(s), ${counts.warnings} warning(s)`)
    return counts.errors ? 1 : 0
  }
  if (command === 'merge') {
    const { problems, merged } = merge()
    const counts = summarize(problems)
    console.log(`i18n merge — ${relative(repoRoot, localesDir)}`)
    printProblems(problems)
    console.log(`${counts.errors} error(s), ${counts.warnings} warning(s), ${merged} message(s) merged`)
    return counts.errors ? 1 : 0
  }
  console.error(`unknown command "${command}" (expected "check" or "merge")`)
  return 2
}

process.exit(main(process.argv.slice(2)))

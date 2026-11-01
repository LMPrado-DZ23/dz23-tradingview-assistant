#!/usr/bin/env node
// Orphan audit for the extension: every file must be reachable from something.
//
// The reference sources are the ones the browser itself uses: the manifest (content scripts, background, pages,
// web-accessible resources, icons), the HTML (script/link tags) and the JavaScript (static imports, import(), and
// getURL('literal') for files injected at runtime). A file nobody references is dead weight in the package — and, worse,
// a feature nobody can open.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXTENSION = join(ROOT, 'extension')

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
const rel = (path) => relative(EXTENSION, path).replace(/\\/g, '/')
const codeFiles = files.filter((path) => /\.(js|mjs|html)$/.test(path))

// 1. manifest
const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'))
const referenced = new Set()
const add = (value) => {
  if (typeof value === 'string' && value)
    referenced.add(value.replace(/^\/+/, '').replace(/\\/g, '/'))
}
add(manifest.background?.service_worker)
for (const script of manifest.background?.scripts ?? [])
  add(script)
for (const entry of manifest.content_scripts ?? []) {
  for (const script of entry.js ?? [])
    add(script)
  for (const style of entry.css ?? [])
    add(style)
}
add(manifest.side_panel?.default_path)
add(manifest.action?.default_popup)
add(manifest.options_ui?.page)
add(manifest.options_page)
for (const value of Object.values(manifest.icons ?? {}))
  add(value)
for (const resource of manifest.web_accessible_resources ?? [])
  for (const file of resource.resources ?? [])
    add(file)

// 2. HTML: src/href de scripts, links e imagens
for (const file of files.filter((path) => path.endsWith('.html'))) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/(?:src|href)="([^"#:]+)"/g))
    add(join(dirname(rel(file)), match[1]))
}

// 3. JS da extensão: imports estáticos, import() e nomes citados em getURL(...)
for (const file of codeFiles.filter((path) => /\.(js|mjs)$/.test(path))) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const target = match[1]
    if (target.startsWith('.'))
      add(join(dirname(rel(file)), target))
  }
  for (const match of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const target = match[1]
    if (target.startsWith('.'))
      add(join(dirname(rel(file)), target))
  }
  for (const match of text.matchAll(/getURL\(\s*['"]([^'"]+)['"]/g))
    add(match[1])
}

// Consumidores fora da extensão (CLIs, gateway, mcp, dz23): um módulo usado por eles não é órfão.
const repoRoot = ROOT
const consumers = []
for (const directory of ['_aitna/tools', 'gateway', 'mcp', 'dz23']) {
  const base = join(repoRoot, directory)
  if (!existsSync(base))
    continue
  for (const path of walk(base)) {
    if (/\.(mjs|js)$/.test(path) && !/\.test\.mjs$/.test(path))
      consumers.push(path)
  }
}
for (const file of consumers) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
    const target = match[1]
    if (!target.startsWith('.'))
      continue
    const absolute = join(dirname(file), target)
    const insideExtension = absolute.startsWith(EXTENSION)
    if (insideExtension)
      add(relative(EXTENSION, absolute).replace(/\\/g, '/'))
  }
}

// Normaliza: sem "./", resolve caminhos relativos já montados
const normalized = new Set()
for (const value of referenced) {
  const clean = value.replace(/^\.\//, '').replace(/\/+/g, '/')
  normalized.add(clean)
  // quem referencia "settings/index.html" também alcança o .js da página por import; nada a fazer aqui
}

const existing = new Set(files.map(rel))
const missing = [...normalized].filter((value) => !existing.has(value) && /\.(js|mjs|html|css|png|svg|woff2)$/.test(value))

const entryPoints = new Set([
  'manifest.json',
  'background.js',
  'content_scripts/chartBridge.js',
  'copilot/index.html',
  'popup/assistant.html',
  'settings/index.html',
  'research/index.html',
])

const orphans = []
for (const path of existing) {
  if (!/\.(js|mjs|html|css)$/.test(path))
    continue
  if (entryPoints.has(path))
    continue
  if (normalized.has(path))
    continue
  // um .css referenciado por HTML com caminho relativo já entrou em normalized
  orphans.push(path)
}

console.log(`arquivos na extensão: ${files.length} · referências declaradas: ${normalized.size}`)
if (missing.length) {
  console.log('referências que não existem:')
  for (const value of missing)
    console.log(`  MISSING ${value}`)
}
if (orphans.length) {
  console.log('arquivos sem referência (ninguém abre, importa ou injeta):')
  for (const value of orphans)
    console.log(`  ORPHAN ${value}`)
}
console.log(JSON.stringify({ passed: missing.length === 0 && orphans.length === 0, missing: missing.length, orphans: orphans.length }))
process.exit(missing.length === 0 && orphans.length === 0 ? 0 : 1)

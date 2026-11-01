#!/usr/bin/env node
// Documentation consistency: every `npm run <script>` and every referenced file must exist. A doc that teaches a command
// which does not exist is a contradiction, and this check turns that into a failing exit code instead of a surprise.
//
//   npm run docs:check
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const scripts = new Set(Object.keys(pkg.scripts ?? {}))

function walk (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (['node_modules', '.git', '_aitna'].includes(entry))
        continue
      walk(path, out)
    } else if (entry.endsWith('.md')) {
      out.push(path)
    }
  }
  return out
}

const docs = [join(ROOT, 'README.md'), ...walk(join(ROOT, 'docs'))].filter((path) => existsSync(path))
const problems = []
let commandsChecked = 0
let filesChecked = 0

for (const doc of docs) {
  const text = readFileSync(doc, 'utf8')
  const relativeDoc = relative(ROOT, doc).replace(/\\/g, '/')

  // npm run <script> [-- args]  (aceita também `npm run <script> -- --flag`)
  for (const match of text.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
    commandsChecked += 1
    const script = match[1]
    if (!scripts.has(script))
      problems.push(`${relativeDoc}: comando "npm run ${script}" não existe no package.json`)
  }

  // Artefatos gerados por build não ficam no Git; a citação é válida se houver script que os produza.
  const ARTEFATOS_GERADOS = [/\.zip$/, /^dist\//, /\.sha256$/]
  const declaredScripts = new Set(Object.keys(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}))

  // arquivos citados em docs: `docs/ALGO.md`, `extension/lib/x.js`, `_aitna/tools/y.mjs`
  for (const match of text.matchAll(/`([A-Za-z0-9_./-]+\.(?:md|js|mjs|json|html|css|zip|cmd))`/g)) {
    const target = match[1]
    if (target.includes('*') || target.startsWith('http') || target.includes('<') || target.includes('>'))
      continue
    filesChecked += 1
    const absolute = join(ROOT, target)
    const fromDocs = join(ROOT, 'docs', target)
    if (!existsSync(absolute) && !existsSync(fromDocs)) {
      const gerado = ARTEFATOS_GERADOS.some((pattern) => pattern.test(target))
      const haScriptDeBuild = ['release:pack', 'verify'].some((name) => declaredScripts.has(name))
      if (!(gerado && haScriptDeBuild))
        problems.push(`${relativeDoc}: arquivo citado "${target}" não existe`)
    }
  }
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ docs: docs.length, commandsChecked, filesChecked, problems }, null, 2))
} else {
  console.log(`documentos verificados: ${docs.length}`)
  console.log(`comandos npm run: ${commandsChecked} · arquivos citados: ${filesChecked}`)
  for (const problem of problems)
    console.log(`FAIL ${problem}`)
  console.log(problems.length ? JSON.stringify({ passed: false, problems: problems.length }) : JSON.stringify({ passed: true, problems: 0 }))
}

process.exit(problems.length === 0 ? 0 : 1)

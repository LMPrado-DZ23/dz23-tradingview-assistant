#!/usr/bin/env node
// Creates a backup snapshot of the working tree (code + docs), excluding node_modules and caches (§15).
//
//   npm run backup -- [--label antes-da-rodada-x]
//
// The snapshot is a plain directory copy so a rollback is: copy `extension/` back and load it unpacked.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BACKUP_ROOT = process.env.DZ23_BACKUP_ROOT
  ?? join(homedir(), 'Documents', 'dz23-backups')
const INCLUDES = ['extension', 'gateway', 'mcp', 'dz23', 'docs', '_aitna/tools', 'package.json', 'README.md', 'eslint.config.mjs', 'native-host']
const SKIP = new Set(['node_modules', '.git', '.browser', 'dist', 'coverage'])

const label = process.argv.includes('--label') ? process.argv[process.argv.indexOf('--label') + 1] : null
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const target = join(BACKUP_ROOT, `tv-assistant-${stamp}${label ? `-${label.replace(/[^a-z0-9-]/gi, '')}` : ''}`)

function walk (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    if (SKIP.has(entry))
      continue
    const path = join(directory, entry)
    if (statSync(path).isDirectory())
      walk(path, out)
    else
      out.push(path)
  }
  return out
}

if (existsSync(target))
  rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })

let files = 0
const copied = []
for (const include of INCLUDES) {
  const source = join(ROOT, include)
  if (!existsSync(source))
    continue
  const destination = join(target, include)
  cpSync(source, destination, { recursive: true, filter: (path) => !SKIP.has(basename(path)) })
  // package.json e README.md são arquivos: só conta, não percorre
  files += statSync(destination).isDirectory() ? walk(destination).length : 1
  copied.push(include)
}

writeFileSync(join(target, 'BACKUP.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  label,
  includes: copied,
  files,
  source: ROOT,
}, null, 2))

console.log(JSON.stringify({ ok: true, path: target, files, includes: copied.length, relativeFrom: relative(dirname(BACKUP_ROOT), target) }, null, 2))

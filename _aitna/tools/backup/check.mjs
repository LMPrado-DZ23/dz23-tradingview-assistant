#!/usr/bin/env node
// Backup verification and rollback rehearsal (§15).
//
// Proves the backup is usable without touching the live tree: it verifies the archive's structure, re-runs syntax checks
// on every restored script in a temporary copy, validates the restored manifest, and reports what differs from the current
// working tree so the rollback is a known quantity instead of a hope.
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const BACKUP_ROOT = process.env.DZ23_BACKUP_ROOT
  ?? join(homedir(), 'Documents', 'dz23-backups')
const problems = []
const notes = []

function listBackups () {
  if (!existsSync(BACKUP_ROOT))
    return []
  return readdirSync(BACKUP_ROOT)
    .filter((name) => name.startsWith('tv-assistant-'))
    .map((name) => ({ name, path: join(BACKUP_ROOT, name), mtime: statSync(join(BACKUP_ROOT, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
}

function walk (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (['node_modules', '.git'].includes(entry))
        continue
      walk(path, out)
    } else {
      out.push(path)
    }
  }
  return out
}

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

// `--backup=` aponta um backup específico e não depende de existir nada na pasta padrão. A ordem importa: antes isto
// listava primeiro e saía com "nenhum backup" quando a pasta estava vazia — o argumento nunca era lido (numa máquina sem
// backups, o ensaio de rollback nem podia ser apontado para um fixture).
const overrideArg = process.argv.find((arg) => arg.startsWith('--backup='))
const override = overrideArg ? overrideArg.slice('--backup='.length) : null

const backups = override ? [] : listBackups()
if (!override && !backups.length) {
  console.log(`FAIL nenhum backup em ${BACKUP_ROOT}`)
  process.exit(1)
}
if (!override)
  notes.push(`backups encontrados: ${backups.length}`)

const target = override
  ? { name: basename(override), path: override }
  : backups[0]
if (override && !existsSync(override)) {
  console.log(`FAIL backup inexistente: ${override}`)
  process.exit(1)
}
notes.push(`verificando o mais recente: ${target.name}`)

// 1. estrutura mínima
for (const required of ['extension', 'extension/manifest.json', 'package.json']) {
  if (!existsSync(join(target.path, required)))
    problems.push(`backup sem ${required}`)
}

// 2. o manifest restaurado é JSON válido e tem as chaves que a extensão precisa
const manifestPath = join(target.path, 'extension', 'manifest.json')
let manifest = null
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const key of ['manifest_version', 'name', 'version'])
    if (!manifest[key])
      problems.push(`manifest restaurado sem "${key}"`)
  notes.push(`manifest: ${manifest.name} v${manifest.version} (MV${manifest.manifest_version})`)

  // arquivos que o próprio manifest referencia precisam existir no backup
  const referenced = []
  const backgroundScript = manifest.background?.service_worker ?? (Array.isArray(manifest.background?.scripts) ? manifest.background.scripts[0] : null)
  if (backgroundScript)
    referenced.push(backgroundScript)
  else
    notes.push('manifest sem background (layout anterior ao worker; aceito)')
  for (const item of manifest.content_scripts ?? [])
    for (const file of item.js ?? [])
      referenced.push(file)
  const popupPath = manifest.action?.default_popup ?? manifest.browser_action?.default_popup
  if (popupPath)
    referenced.push(popupPath)
  if (manifest.side_panel?.default_path)
    referenced.push(manifest.side_panel.default_path)
  let missing = 0
  for (const file of [...new Set(referenced)]) {
    if (!existsSync(join(target.path, 'extension', file))) {
      missing += 1
      problems.push(`backup: arquivo referenciado pelo manifest não existe (${file})`)
    }
  }
  notes.push(`arquivos declarados no manifest: ${new Set(referenced).size} (${missing} faltando)`)

} catch (error) {
  problems.push(`manifest restaurado inválido: ${error.message}`)
}

// 3. ensaio de restauração: copia para um diretório temporário e roda node --check em todo JS/MJS
const sandbox = mkdtempSync(join(tmpdir(), 'dz23-rollback-'))
try {
  cpSync(join(target.path, 'extension'), join(sandbox, 'extension'), { recursive: true })
  const scripts = walk(join(sandbox, 'extension')).filter((path) => path.endsWith('.js') || path.endsWith('.mjs'))
  let failed = 0
  for (const script of scripts) {
    const result = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' })
    if (result.status !== 0) {
      failed += 1
      problems.push(`script restaurado não compila: ${relative(sandbox, script).replace(/\\/g, '/')}`)
    }
  }
  notes.push(`sintaxe verificada em ${scripts.length} script(s) restaurados: ${scripts.length - failed} ok`)

  // 4. conteúdo: a extensão restaurada difere da atual? (o delta é a informação útil para decidir voltar)
  const current = join(ROOT, 'extension')
  const currentFiles = new Set(walk(current).map((path) => relative(current, path).replace(/\\/g, '/')))
  const backupFiles = new Set(walk(join(sandbox, 'extension')).map((path) => relative(join(sandbox, 'extension'), path).replace(/\\/g, '/')))
  const onlyInBackup = [...backupFiles].filter((file) => !currentFiles.has(file))
  const onlyInCurrent = [...currentFiles].filter((file) => !backupFiles.has(file))
  let changed = 0
  for (const file of backupFiles) {
    if (!currentFiles.has(file))
      continue
    if (sha(join(sandbox, 'extension', file)) !== sha(join(current, file)))
      changed += 1
  }
  notes.push(`delta vs. árvore atual: ${changed} arquivo(s) alterado(s), ${onlyInCurrent.length} só na atual, ${onlyInBackup.length} só no backup`)
  if (onlyInCurrent.length)
    notes.push(`  só na atual (seria perdido ao voltar): ${onlyInCurrent.slice(0, 8).join(', ')}${onlyInCurrent.length > 8 ? '…' : ''}`)

  // 4b. ensaio de rollback funcional: a árvore restaurada tem de rodar, não só compilar.
  const functional = join(sandbox, 'repo')
  try {
    cpSync(target.path, functional, { recursive: true })
    const suite = join(functional, '_aitna', 'tools', 'extension-tests')
    const preferred = ['config.test.mjs', 'chartActions.test.mjs', 'marketIntel.test.mjs', 'agents.test.mjs']
      .map((name) => join(suite, name))
      .filter((path) => existsSync(path))
    const picks = preferred.length
      ? preferred
      : (existsSync(suite)
          ? readdirSync(suite).filter((name) => name.endsWith('.test.mjs')).slice(0, 4).map((name) => join(suite, name))
          : [])
    if (!picks.length) {
      notes.push('ensaio funcional: o backup não traz a suíte de testes (só estrutura)')
    } else {
      const cleanEnv = { ...process.env }
      delete cleanEnv.NODE_TEST_CONTEXT
      delete cleanEnv.NODE_OPTIONS
      const run = spawnSync(process.execPath, ['--test', ...picks], { cwd: functional, encoding: 'utf8', timeout: 300_000, env: cleanEnv })
      const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
      const tests = Number((/ℹ tests (\d+)/.exec(output) ?? /# tests (\d+)/.exec(output))?.[1] ?? 0)
      const pass = Number(/ℹ pass (\d+)/.exec(output)?.[1] ?? 0)
      if (tests === 0) {
        problems.push('ensaio funcional não executou nenhum teste (suíte do backup vazia ou quebrada)')
        notes.push(`  saída do ensaio: ${output.replace(/\s+/g, ' ').slice(0, 220) || '(vazia)'}`)
      } else if (run.status !== 0) {
        problems.push(`rollback funcional falhou: ${picks.length} arquivo(s) da suíte do backup não passaram (exit ${run.status})`)
        notes.push(output.split('\n').filter((line) => /✖|not ok/.test(line)).slice(0, 3).join(' | '))
      } else {
        notes.push(`ensaio funcional: ${pass}/${tests} teste(s) da própria árvore restaurada passaram`)
      }
    }
  } finally {
    rmSync(functional, { recursive: true, force: true })
  }

  // 5. o rollback precisa ser reproduzível: registra o comando exato
  const plan = {
    backup: target.path,
    verifiedAt: new Date().toISOString(),
    scriptsChecked: scripts.length,
    changedFiles: changed,
    onlyInCurrent,
    onlyInBackup,
    restore: [
      `remover a extensão atual do Chrome (chrome://extensions)`,
      `copiar ${target.path}\\extension para uma pasta nova`,
      `carregar sem compactação em chrome://extensions apontando para a pasta nova`,
    ],
  }
  writeFileSync(join(sandbox, 'rollback-plan.json'), JSON.stringify(plan, null, 2))
  notes.push('plano de rollback gerado (rollback-plan.json no diretório de ensaio)')
} finally {
  rmSync(sandbox, { recursive: true, force: true })
}

for (const note of notes)
  console.log(note)
for (const problem of problems)
  console.log(`FAIL ${problem}`)

if (process.argv.includes('--json'))
  console.log(JSON.stringify({ passed: problems.length === 0, backup: target.name, notes, problems }, null, 2))
else
  console.log(JSON.stringify({ passed: problems.length === 0, problems: problems.length }))

process.exit(problems.length === 0 ? 0 : 1)

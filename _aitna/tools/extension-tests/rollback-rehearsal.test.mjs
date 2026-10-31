// The rollback rehearsal has to fail on a backup that cannot run — otherwise "rollback validado" is a phrase.
//
// A backup is built from scratch here (manifest, one module, one test that exercises it) so the cases are deterministic:
// a healthy backup must pass the functional rehearsal, a broken one must be named by the checker.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CHECKER = join(ROOT, '_aitna/tools/backup/check.mjs')

function runChecker (backupPath) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHECKER, `--backup=${backupPath}`], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`
      const summary = output.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? '{}'
      let parsed = {}
      try {
        parsed = JSON.parse(summary)
      } catch {
        parsed = {}
      }
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output, summary: parsed })
    })
  })
}

const MANIFEST = JSON.stringify({
  manifest_version: 3,
  name: 'dz23 backup de teste',
  version: '1.0.0',
  key: 'x'.repeat(40),
  background: { service_worker: 'background.js' },
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
})

const HEALTHY_TEST = `import assert from 'node:assert/strict'
import test from 'node:test'
import { double } from '../../../extension/lib/math.mjs'

test('a árvore restaurada funciona', () => {
  assert.equal(double(2), 4)
})
`

function makeBackup ({ moduleSource, testSource = HEALTHY_TEST } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dz23-backup-'))
  mkdirSync(join(dir, 'extension', 'lib'), { recursive: true })
  mkdirSync(join(dir, '_aitna', 'tools', 'extension-tests'), { recursive: true })
  writeFileSync(join(dir, 'extension', 'manifest.json'), MANIFEST)
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'dz23-fixture', version: '1.0.0' }))
  writeFileSync(join(dir, 'extension', 'background.js'), 'void 0\n')
  writeFileSync(join(dir, 'extension', 'lib', 'math.mjs'), moduleSource ?? 'export const double = (value) => value * 2\n')
  writeFileSync(join(dir, '_aitna', 'tools', 'extension-tests', 'math.test.mjs'), testSource)
  return dir
}

test('backup que roda passa no ensaio funcional', async () => {
  const dir = makeBackup()
  try {
    const result = await runChecker(dir)
    assert.equal(result.code, 0, result.output)
    assert.match(result.output, /ensaio funcional: 1\/1/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup cujo teste falha é reprovado como rollback quebrado', async () => {
  const dir = makeBackup({ moduleSource: 'export const double = (value) => value * 3\n' })
  try {
    const result = await runChecker(dir)
    assert.equal(result.code, 1, 'um backup que não passa na própria suíte não é um rollback válido')
    assert.match(result.output, /rollback funcional falhou/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('backup sem manifest é reprovado antes de qualquer ensaio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dz23-backup-sem-manifest-'))
  mkdirSync(join(dir, 'extension'), { recursive: true })
  writeFileSync(join(dir, 'extension', 'background.js'), 'void 0\n')
  try {
    const result = await runChecker(dir)
    assert.equal(result.code, 1)
    assert.match(result.output, /manifest/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

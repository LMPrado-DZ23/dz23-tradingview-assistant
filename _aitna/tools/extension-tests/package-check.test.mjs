// The package check must fail on a broken package — otherwise it is decoration.
//
// Each case builds a small archive with one specific defect and asserts the checker names that defect. The last case uses
// the real assistant-ext.zip and asserts it is clean, so the test also proves the shipped artifact.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { zipDirectory } from '../release/zip.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CHECKER = join(ROOT, '_aitna/tools/audit/package.mjs')

function runChecker (zipPath) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CHECKER, zipPath], { cwd: ROOT, encoding: 'utf8' }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}${stderr ?? ''}`
      const summary = output.trim().split('\n').filter((line) => line.startsWith('{')).at(-1) ?? '{}'
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output, summary: JSON.parse(summary) })
    })
  })
}

function buildPackage (files) {
  const dir = mkdtempSync(join(tmpdir(), 'dz23-pkg-'))
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, content)
  }
  const zipPath = join(mkdtempSync(join(tmpdir(), 'dz23-zip-')), 'pacote.zip')
  zipDirectory(dir, zipPath)
  return { dir, zipPath }
}

const manifestWith = (extra = {}) => JSON.stringify({ manifest_version: 3, name: 'teste', version: '1.0.0', key: 'x'.repeat(40), ...extra })

test('pacote que referencia arquivo inexistente é reprovado com o nome do arquivo', async () => {
  const { dir, zipPath } = buildPackage({ 'manifest.json': manifestWith({ background: { service_worker: 'background.js' } }) })
  try {
    const result = await runChecker(zipPath)
    assert.equal(result.code, 1)
    assert.equal(result.summary.passed, false)
    assert.match(result.output, /missing_referenced.*background\.js/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(zipPath), { recursive: true, force: true })
  }
})

test('pacote com teste dentro é reprovado', async () => {
  const { dir, zipPath } = buildPackage({
    'manifest.json': manifestWith(),
    'quant/metrics.test.mjs': 'export const x = 1',
  })
  try {
    const result = await runChecker(zipPath)
    assert.equal(result.code, 1)
    assert.match(result.output, /forbidden_entry.*metrics\.test\.mjs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(zipPath), { recursive: true, force: true })
  }
})

test('pacote sem chave é reprovado (o id voltaria a depender da pasta)', async () => {
  const { dir, zipPath } = buildPackage({ 'manifest.json': JSON.stringify({ manifest_version: 3, name: 't', version: '1.0.0' }) })
  try {
    const result = await runChecker(zipPath)
    assert.equal(result.code, 1)
    assert.match(result.output, /no_key/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(zipPath), { recursive: true, force: true })
  }
})

test('pacote sem manifest é reprovado', async () => {
  const { dir, zipPath } = buildPackage({ 'background.js': 'void 0' })
  try {
    const result = await runChecker(zipPath)
    assert.equal(result.code, 1)
    assert.match(result.output, /no_manifest/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dirname(zipPath), { recursive: true, force: true })
  }
})

test('o pacote de distribuição real passa em todas as regras', async () => {
  const result = await runChecker(join(ROOT, 'assistant-ext.zip'))
  assert.equal(result.code, 0, result.output)
  assert.equal(result.summary.passed, true)
  assert.equal(result.summary.version, '2.17.0')
  assert.ok(result.summary.entries > 50, `entradas: ${result.summary.entries}`)
})

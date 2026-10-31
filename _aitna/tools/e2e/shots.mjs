#!/usr/bin/env node
// Regenera as capturas de `docs/screenshots/` de propósito.
//
// As ferramentas de evidência gravam em pasta temporária por padrão, porque verificar não deve reescrever arquivo
// versionado — sem isso a árvore nunca fica limpa e cada rodada suja os PNGs com bytes diferentes de renderização.
// Este comando é o ato intencional de atualizar a evidência visual.
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const OUT = join(ROOT, 'docs', 'screenshots')
mkdirSync(OUT, { recursive: true })

const TOOLS = ['popup-shot.mjs', 'settings-page.mjs', 'research-pine.mjs', 'contrast-audit.mjs']
const results = []

for (const tool of TOOLS) {
  const path = join(HERE, tool)
  const run = spawnSync(process.execPath, [path], {
    cwd: ROOT,
    env: { ...process.env, DZ23_WRITE_SCREENSHOTS: '1' },
    encoding: 'utf8',
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const passed = run.status === 0
  results.push({ tool, passed })
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${tool}${passed ? '' : `  ← ${output.trim().split('\n').at(-1)?.slice(0, 120)}`}`)
}

const failures = results.filter((item) => !item.passed)
console.log(JSON.stringify({ passed: failures.length === 0, output: OUT, tools: results.length, failures: failures.map((item) => item.tool) }))
console.log('Confira o diff: as capturas devem mostrar a interface atual, não outra coisa.')
process.exit(failures.length === 0 ? 0 : 1)

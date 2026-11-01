#!/usr/bin/env node
// Lint com marcador de resultado sempre presente.
//
// O gate procurava a string "0 error" na saída do eslint. Essa string só aparece quando o eslint imprime o resumo — ou
// seja, quando existe pelo menos um problema. Com a árvore limpa o eslint não imprime nada, o marcador desaparecia e o
// gate reprovava o próprio sucesso. É o mesmo defeito que este projeto vem caçando desde a rodada 91: verde sem evidência.
//
// Este wrapper imprime a saída do eslint (para humano ler) e SEMPRE termina com uma linha JSON de contrato.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const run = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['--no-install', 'eslint', '.'],
  { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32', timeout: 10 * 60_000, env: { ...process.env, NO_COLOR: '1' } },
)

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd()
if (output)
  console.log(output)

// "✖ 11 problems (0 errors, 11 warnings)" | "✖ 2 problems (2 errors, 0 warnings)"
const resumo = /(\d+)\s+problems?\s+\((\d+)\s+errors?,\s+(\d+)\s+warnings?\)/.exec(output)
const errors = resumo ? Number(resumo[2]) : 0
const warnings = resumo ? Number(resumo[3]) : 0
const code = run.status === null ? 1 : run.status

// contrato: quem consome não depende de texto humano nem de ausência de saída
console.log(JSON.stringify({ passed: errors === 0 && code === 0, errors, warnings, exit: code }))
process.exit(code === 0 && errors === 0 ? 0 : 1)

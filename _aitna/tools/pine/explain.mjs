#!/usr/bin/env node
// Pine explanation / documentation CLI.
//
//   npm run pine:explain -- script.pine            # imprime o prompt e os achados; nada é enviado
//   npm run pine:explain -- script.pine --live     # modelo explica, fatos do validador impressos separados
//   npm run pine:doc -- script.pine                # cabeçalho de documentação gerado a partir dos fatos + modelo
//
// The validator runs first. If the script does not parse, the CLI says so and still explains what is wrong — it does not
// pretend the code is fine.
import { readFileSync } from 'node:fs'
import { buildExplainPrompt, formatExplanation } from '../../../extension/quant/pineExplain.mjs'
import { validatePine } from '../../../extension/quant/pine.mjs'
import { askGateway } from './gateway.mjs'

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const target = argv.find((value) => !value.startsWith('--'))

if (!target) {
  console.error('uso: npm run pine:explain -- <arquivo.pine> [--live]')
  process.exit(2)
}

let code
try {
  code = readFileSync(target, 'utf8')
} catch (error) {
  console.error(`não consegui ler ${target}: ${error.message}`)
  process.exit(2)
}

const report = validatePine(code)
const prompt = buildExplainPrompt(code, report)

if (!live) {
  console.log(prompt)
  console.log('\n(sem --live: nada foi enviado a provedor)')
  process.exit(report.ok ? 0 : 1)
}

let answer
try {
  answer = await askGateway({ prompt, user: 'Explique o script.' })
} catch (error) {
  console.error(`falha ao pedir a explicação: ${error.message}`)
  process.exit(1)
}

console.log(formatExplanation({ report, answer }))
process.exit(report.ok ? 0 : 1)

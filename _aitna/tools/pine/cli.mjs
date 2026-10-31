#!/usr/bin/env node
// Pine Script validator CLI.
//
//   npm run pine:check -- caminho/do/script.pine
//   node _aitna/tools/pine/cli.mjs -          (lê da entrada padrão)
//   node _aitna/tools/pine/cli.mjs script.pine --json
//
// Exit code 0 quando não há erro (avisos não falham), 1 quando há erro, 2 quando o arquivo não pode ser lido.
import { readFileSync } from 'node:fs'
import { formatPineReport, validatePine } from '../../../extension/quant/pine.mjs'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const target = argv.find((value) => !value.startsWith('--'))

if (!target) {
  console.error('uso: pine:check <arquivo.pine|-> [--json]')
  process.exit(2)
}

let source
try {
  source = target === '-' ? readFileSync(0, 'utf8') : readFileSync(target, 'utf8')
} catch (error) {
  console.error(`não foi possível ler ${target}: ${error.message}`)
  process.exit(2)
}

const result = validatePine(source)
if (json)
  console.log(JSON.stringify({ file: target === '-' ? '<stdin>' : target, ...result }, null, 2))
else
  console.log(formatPineReport(result))

process.exit(result.ok ? 0 : 1)

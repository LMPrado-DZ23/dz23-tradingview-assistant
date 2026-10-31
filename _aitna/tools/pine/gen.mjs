#!/usr/bin/env node
// Pine generation CLI: asks the gateway model for a script, then validates it with the same linter before showing it.
// A script that fails validation is printed with its findings and the CLI exits non-zero — never "here is your working
// indicator" for code that does not pass.
//
//   npm run pine:gen -- "RSI com divergência e alerta" --live
//   npm run pine:gen -- "estratégia de rompimento com ATR" --kind strategy --live
//
// Without --live it prints the prompt and exits: nothing is sent to a provider, so it is free.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildPinePrompt, describeGeneration, extractPineCode } from '../../../extension/quant/pineGen.mjs'
import { validatePine } from '../../../extension/quant/pine.mjs'

const argv = process.argv.slice(2)
const live = argv.includes('--live')
const kind = argv.includes('--kind') && argv[argv.indexOf('--kind') + 1] === 'strategy' ? 'strategy' : 'indicator'
const spec = argv.filter((value, index) => !value.startsWith('--') && argv[index - 1] !== '--kind').join(' ').trim()

if (!spec) {
  console.error('uso: npm run pine:gen -- "descreva o script" [--kind strategy] [--live]')
  process.exit(2)
}

const prompt = buildPinePrompt(spec, { kind })
if (!live) {
  console.log(prompt)
  console.log('\n(sem --live: nada foi enviado a provedor)')
  process.exit(0)
}

function token () {
  try {
    return readFileSync(join(homedir(), '.dz23', 'gateway-token'), 'utf8').trim()
  } catch {
    return null
  }
}

const auth = process.env.DZ23_GATEWAY_TOKEN ?? token()
const gateway = process.env.DZ23_GATEWAY_URL ?? 'http://127.0.0.1:8777'
const provider = argv.includes('--provider') ? argv[argv.indexOf('--provider') + 1] : 'deepseek'
if (!auth) {
  console.error('sem token do gateway: rode `npm run gateway:dev` ou defina DZ23_GATEWAY_TOKEN')
  process.exit(2)
}

const response = await fetch(new URL('/chat', gateway), {
  method: 'POST',
  headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
  body: JSON.stringify({ provider, stream: true, messages: [
    { role: 'system', content: prompt },
    { role: 'user', content: 'Gere o script.' },
  ] }),
})
if (!response.ok) {
  console.error(`gateway ${response.status}: ${(await response.text()).slice(0, 160)}`)
  process.exit(1)
}

const body = await response.text()
let answer = ''
for (const line of body.split('\n')) {
  if (!line.startsWith('data: '))
    continue
  try {
    const event = JSON.parse(line.slice(6))
    if (event.type === 'delta' && event.text)
      answer += event.text
    else if (event.type === 'done' && event.text && !answer)
      answer = event.text
  } catch {
    /* mantém o texto legível */
  }
}

const extracted = extractPineCode(answer)
const report = validatePine(extracted.code)
console.log(describeGeneration({ code: extracted.code, report, discarded: extracted.discarded }))
if (extracted.code) {
  console.log('\n--- script ---')
  console.log(extracted.code)
}
process.exit(report.ok && extracted.code ? 0 : 1)

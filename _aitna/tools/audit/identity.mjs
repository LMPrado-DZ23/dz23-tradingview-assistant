#!/usr/bin/env node
// Identidade pública do pacote: nome, descrição e para onde apontam os links.
//
// O repositório é público e o produto é obra derivada. Duas coisas já deram errado aqui: o README mandava instalar a
// extensão de terceiros e o package.json se apresentava com o nome do projeto original. Este verificador impede que a
// identidade volte a descrever outro produto — sem apagar a atribuição, que é obrigação da licença.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const REPO = 'https://github.com/LMPrado-DZ23/dz23-tradingview-assistant'
const problems = []
const notes = []

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'))

// 1. nome do pacote
if (!/dz23/i.test(pkg.name))
  problems.push({ kind: 'package_name', detail: `package.json name "${pkg.name}" não identifica o produto (DZ23)` })
else
  notes.push(`package.json name: ${pkg.name}`)

// 2. descrição do pacote: precisa dizer o que o produto faz, não o que ele herdou
if (!/copiloto|copilot/i.test(pkg.description ?? ''))
  problems.push({ kind: 'package_description', detail: 'package.json description não menciona o copiloto (o produto não é só backtest)' })
else
  notes.push('package.json description descreve o produto')

// 3. links apontam para ESTE repositório
for (const [field, value] of [
  ['repository', pkg.repository?.url ?? ''],
  ['homepage', pkg.homepage ?? ''],
  ['bugs', pkg.bugs?.url ?? ''],
]) {
  if (!value.toString().includes('LMPrado-DZ23/dz23-tradingview-assistant'))
    problems.push({ kind: `package_${field}`, detail: `package.json ${field} não aponta para ${REPO}` })
  else
    notes.push(`package.json ${field}: aponta para este repositório`)
}

// 4. nome visível da extensão (via i18n)
const catalogs = {}
for (const locale of ['pt_BR', 'en'])
  catalogs[locale] = JSON.parse(readFileSync(join(ROOT, 'extension/_locales', locale, 'messages.json'), 'utf8'))

for (const [locale, catalog] of Object.entries(catalogs)) {
  const name = catalog.ext_name?.message ?? ''
  if (!/dz23/i.test(name))
    problems.push({ kind: 'ext_name', detail: `${locale}: ext_name "${name}" não identifica o produto` })
  else
    notes.push(`${locale}: ext_name = ${name}`)
}

// 5. descrição visível: limite do Chrome (132) e conteúdo que não seja só o texto herdado
const UPSTREAM_DESCRIPTION = /backtesting trading strategies and showing external signals/i
for (const [locale, catalog] of Object.entries(catalogs)) {
  const description = catalog.ext_description?.message ?? ''
  if (description.length > 132)
    problems.push({ kind: 'ext_description_length', detail: `${locale}: descrição tem ${description.length} chars (limite do Chrome: 132)` })
  if (UPSTREAM_DESCRIPTION.test(description) || /backtest de estratégias e exibição de sinais externos/i.test(description))
    problems.push({ kind: 'ext_description_herdada', detail: `${locale}: descrição ainda é a do projeto original, descrevendo só backtest` })
  if (!/copiloto|copilot/i.test(description))
    problems.push({ kind: 'ext_description_produto', detail: `${locale}: descrição não menciona o copiloto` })
  if (!problems.some((problem) => problem.detail.startsWith(`${locale}:`)))
    notes.push(`${locale}: descrição ${description.length} chars, descreve o copiloto`)
}

// 6. atribuição preservada onde a licença exige
const notice = readFileSync(join(ROOT, 'docs/NOTICE.md'), 'utf8')
if (!/akumidv/.test(notice))
  problems.push({ kind: 'attribution', detail: 'docs/NOTICE.md perdeu a atribuição ao projeto original (GPL-3.0)' })
else
  notes.push('atribuição ao projeto original preservada')

// 7. o manifest declara a versão do produto (o README e o pacote precisam concordar)
if (pkg.version !== manifest.version)
  problems.push({ kind: 'version_mismatch', detail: `package.json ${pkg.version} vs manifest ${manifest.version}` })
else
  notes.push(`versão ${pkg.version} igual no package.json e no manifest`)

for (const note of notes)
  console.log(`ok    ${note}`)
for (const problem of problems)
  console.log(`FAIL  ${problem.kind}: ${problem.detail}`)
console.log(JSON.stringify({ passed: problems.length === 0, notes: notes.length, problems }))
process.exit(problems.length === 0 ? 0 : 1)

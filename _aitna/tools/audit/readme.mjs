// O README é a porta de entrada do repositório e cita números do gate. Número em README envelhece mais rápido que
// qualquer outro: quem chega lê a primeira linha, e é a primeira a ficar errada.
//
// Este verificador compara o que o README **afirma** com o que a evidência de aceite **mede**, e com o que o gate define.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const problems = []
const notes = []

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
let acceptance = null
try {
  acceptance = JSON.parse(readFileSync(join(ROOT, 'docs/ACEITACAO.json'), 'utf8'))
} catch {
  problems.push({ kind: 'missing_acceptance', detail: 'docs/ACEITACAO.json não existe: rode npm run accept' })
}

// 1. contagem de verificações do gate (vem do código do gate, não do relatório: é a fonte)
const gateSource = readFileSync(join(ROOT, '_aitna/tools/audit/gate.mjs'), 'utf8')
const gateCount = (gateSource.match(/^\s*\{ name: '/gm) ?? []).length
const claimedGates = /\*\*(\d+) verificações\*\*/.exec(readme)?.[1]
if (claimedGates !== undefined) {
  if (Number(claimedGates) !== gateCount)
    problems.push({ kind: 'readme_gates_mismatch', detail: `README diz ${claimedGates} verificações, gate.mjs define ${gateCount}` })
  else
    notes.push(`README: ${gateCount} verificações (confere)`)
}

if (acceptance) {
  // 2. contagem de testes (medida na última execução do aceite)
  const claimedTests = /\*\*(\d+) testes\*\*/.exec(readme)?.[1]
  const measured = acceptance.gate?.totalTests
  if (claimedTests !== undefined && Number.isFinite(measured)) {
    if (Number(claimedTests) !== measured)
      problems.push({ kind: 'readme_tests_mismatch', detail: `README diz ${claimedTests} testes, a evidência mediu ${measured}` })
    else
      notes.push(`README: ${measured} testes (confere)`)
  }

  // 3. critérios de aceite
  const claimedCriteria = /aceite \*\*(\d+)\/(\d+)\*\*/.exec(readme)
  if (claimedCriteria && acceptance.summary) {
    const [, pass, total] = claimedCriteria
    if (Number(pass) !== acceptance.summary.pass || Number(total) !== acceptance.summary.criteria)
      problems.push({
        kind: 'readme_criteria_mismatch',
        detail: `README diz ${pass}/${total}, a evidência mede ${acceptance.summary.pass}/${acceptance.summary.criteria}`,
      })
    else
      notes.push(`README: ${pass}/${total} critérios (confere)`)
  }

  // 4. dependências externas e ausências declaradas
  const claimedExternal = /\((\d+) dependências externas/.exec(readme)?.[1]
  const claimedAbsent = /(\d+) itens ausentes/.exec(readme)?.[1]
  if (claimedExternal !== undefined && Number(claimedExternal) !== acceptance.summary?.external)
    problems.push({ kind: 'readme_external_mismatch', detail: `README diz ${claimedExternal} externas, a evidência mede ${acceptance.summary?.external}` })
  if (claimedAbsent !== undefined && Number(claimedAbsent) !== acceptance.summary?.absent)
    problems.push({ kind: 'readme_absent_mismatch', detail: `README diz ${claimedAbsent} ausentes, a evidência mede ${acceptance.summary?.absent}` })
  if (claimedExternal !== undefined && claimedAbsent !== undefined)
    notes.push('README: externas e ausentes conferem')
}

// 5. o README não pode mandar instalar a extensão de terceiros (era o defeito original)
if (/chrome(webstore|\.google\.com\/webstore)/i.test(readme))
  problems.push({ kind: 'readme_points_to_store', detail: 'o README manda instalar pela Web Store, que publica o produto ORIGINAL, não este' })
else
  notes.push('README não aponta para a Web Store (instalação sem compactação)')

// 6. atribuição preservada: obra derivada precisa citar a origem
const notice = (() => {
  try {
    return readFileSync(join(ROOT, 'docs/NOTICE.md'), 'utf8')
  } catch {
    return ''
  }
})()
if (!/akumidv\/tradingview-assistant-chrome-extension/.test(notice))
  problems.push({ kind: 'attribution_missing', detail: 'docs/NOTICE.md não cita o repositório de origem (obra derivada GPL)' })
else
  notes.push('atribuição ao projeto original presente em docs/NOTICE.md')
if (!/GPL/i.test(notice) || !/GPL/i.test(readme))
  problems.push({ kind: 'license_not_declared', detail: 'licença GPL-3.0 precisa ser declarada no README e no NOTICE' })


// 7. o README precisa estar no histórico, não só na árvore de trabalho
const tracked = (() => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', 'README.md'], { cwd: ROOT, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
if (!tracked)
  problems.push({ kind: 'readme_untracked', detail: 'README.md não está no Git' })
else
  notes.push('README versionado (confere)')

for (const note of notes)
  console.log(`ok    ${note}`)
for (const problem of problems)
  console.log(`FAIL  ${problem.kind}: ${problem.detail}`)
console.log(JSON.stringify({ passed: problems.length === 0, notes: notes.length, problems }))
process.exit(problems.length === 0 ? 0 : 1)

// Roda a bateria de verificação do §14/§17 UM COMANDO POR VEZ e registra o código de saída de cada um.
//
// Por que existe: no PowerShell, `cmd1; cmd2` faz o último comando decidir o resultado. Um relatório que termina em
// "npm run verify: ok" pode estar escondendo quatro falhas anteriores — foi exatamente esse tipo de silêncio que este
// projeto passou rodadas inteiras corrigindo. Aqui cada comando tem o seu exit code, e o pior deles decide o total.
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

const BATERIA = [
  { nome: 'lint', argv: ['run', 'lint'] },
  { nome: 'i18n:check', argv: ['run', 'i18n:check'] },
  { nome: 'test:ext', argv: ['run', 'test:ext'] },
  { nome: 'test:gateway', argv: ['run', 'test:gateway'] },
  { nome: 'test:quant', argv: ['run', 'test:quant'] },
  { nome: 'test:dz23', argv: ['run', 'test:dz23'] },
  { nome: 'test:mcp', argv: ['run', 'test:mcp'] },
  { nome: 'test:tools', argv: ['run', 'test:tools'] },
  { nome: 'test:bridge', argv: ['run', 'test:bridge'] },
  { nome: 'test:e2e', argv: ['run', 'test:e2e'] },
  { nome: 'test:a11y', argv: ['run', 'test:a11y'] },
  { nome: 'perf:check', argv: ['run', 'perf:check'] },
  { nome: 'audit', argv: ['audit', '--omit=dev'] },
  { nome: 'release:check', argv: ['run', 'release:check', '--', '--dev', '--offline'] },
  { nome: 'verify', argv: ['run', 'verify'] },
]

const resultados = []

// A evidência vai a disco a cada etapa, não só no fim: um dos passos (verify) roda o docs:check, que exige que o arquivo
// citado no ENTREGA.md já exista.
function gravarEvidencia () {
  const falhasParciais = resultados.filter((r) => r.code !== 0).map((r) => r.etapa)
  const parcial = {
    ok: falhasParciais.length === 0,
    emAndamento: true,
    quando: new Date().toISOString(),
    etapas: resultados,
    falhas: falhasParciais,
  }
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  writeFileSync(join(ROOT, 'docs', 'BATERIA.json'), `${JSON.stringify(parcial, null, 2)}\n`)
}
const inicio = Date.now()

for (const etapa of BATERIA) {
  const t0 = Date.now()
  process.stdout.write(`${etapa.nome} ... `.padEnd(22))
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', etapa.argv, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    shell: process.platform === 'win32',
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
  })
  const duracao = ((Date.now() - t0) / 1000).toFixed(1)
  const code = run.status === null ? 'timeout' : run.status
  const saida = `${run.stdout ?? ''}${run.stderr ?? ''}`
  // resumo: última linha com número de testes, contador de erros ou o motivo do erro
  const linhas = saida.split('\n').map((l) => l.trim()).filter(Boolean)
  const resumo = linhas.filter((l) => /^ℹ (tests|pass|fail)|# (tests|pass|fail)|\bproblems?\b|\berrors?\b|found \d+ vulnerabilit|"ok"\s*:|FAIL|✖/.test(l)).slice(-3).join(' | ')
  // As suítes E2E imprimem o próprio contrato ({"passed":true,"steps":N}); o resumo precisa entender os dois formatos.
  const contrato = /"passed"\s*:\s*(true|false)[^\n]*"steps"\s*:\s*(\d+)/.exec(saida) ?? /"passed"\s*:\s*(true|false)/.exec(saida)
  // Contratos aceitos como prova: contagem de testes do node, "passed" das suítes E2E, "ok" dos auditores, contadores de
  // problema/vulnerabilidade do lint e do npm audit, e o PASS/FAIL dos E2E. Qualquer outra coisa que saia 0 é silêncio.
  const evidencia = /ℹ (tests|pass|fail)\s+\d+|# (tests|pass|fail)\s+\d+|"passed"\s*:\s*(true|false)|"ok"\s*:\s*(true|false)|\bproblems?\b|\bvulnerabilit|\bwarnings?\b|^(PASS|FAIL) /im.test(saida)

  // Verde sem evidência é a falha mais perigosa do relatório: o comando roda, sai 0 e não prova nada. Um teste que não
  // chegou a começar, um script que saiu antes do primeiro assert — ambos passariam despercebidos no exit code.
  const semEvidencia = code === 0 && !evidencia
  if (semEvidencia)
    process.stdout.write('sem evidência ')
  resultados.push({
    etapa: etapa.nome,
    code: semEvidencia ? 'sem_evidencia' : code,
    duracaoSegundos: Number(duracao),
    contrato: contrato ? { passed: contrato[1] === 'true', steps: contrato[2] ? Number(contrato[2]) : null } : null,
    resumo: (resumo || resumoDoContrato(contrato)).slice(0, 300),
  })
  console.log(`${code === 0 && !semEvidencia ? 'ok' : 'FALHOU'} (${duracao}s)`)
  gravarEvidencia()
}

function resumoDoContrato (contrato) {
  if (!contrato)
    return ''
  return `contrato: passed=${contrato[1]}${contrato[2] ? `, steps=${contrato[2]}` : ''}`
}


const falhas = resultados.filter((r) => r.code !== 0)
const relatorio = {
  ok: falhas.length === 0,
  quando: new Date().toISOString(),
  duracaoTotalSegundos: Math.round((Date.now() - inicio) / 1000),
  etapas: resultados,
  falhas: falhas.map((f) => f.etapa),
}


console.log('')
for (const r of resultados)
  console.log(`${String(r.code).padStart(3)}  ${r.etapa.padEnd(16)} ${r.duracaoSegundos}s  ${r.resumo}`)
console.log('')
console.log(JSON.stringify({ ok: relatorio.ok, etapas: resultados.length, falhas: relatorio.falhas }))
process.exit(relatorio.ok ? 0 : 1)

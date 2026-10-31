// Agent orchestration: planning, contract parsing, cross-validation and failure handling — all without a model.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ROLES, agentPrompt, crossValidate, parseVerdict, planRun, runAgents, summarizeRun,
} from '../../../extension/lib/agents.js'

const intel = { available: true, rsi: 62, atr: 1.5, macd: { value: 0.4, signal: 0.2, histogram: 0.2 }, bollinger: { middle: 100, upper: 104, lower: 96 }, ema20: 101, structure: { rangeHigh: 105, rangeLow: 95 }, trend: 'alta' }
const valid = (stance = 'alta', confidence = 0.7) => JSON.stringify({ stance, confidence, evidence: ['RSI 62', 'EMA20 101'], interpretation: 'leitura', invalidation: 'perder 95' })

test('o plano é determinístico e escolhe papéis pela pergunta', () => {
  const simple = planRun({ question: 'como está o mercado?', intel, hasCandles: true })
  assert.deepEqual(simple.tasks.map((task) => task.role), ['market-analyst', 'qa-reviewer'])
  const risky = planRun({ question: 'qual o risco e onde invalida?', intel, hasCandles: true })
  assert.ok(risky.tasks.some((task) => task.role === 'risk-manager'))
  const technical = planRun({ question: 'veja suporte e RSI', intel, hasCandles: true })
  assert.ok(technical.tasks.some((task) => task.role === 'technical-analyst'))
  assert.deepEqual(planRun({ question: 'x', intel, hasCandles: true }), planRun({ question: 'x', intel, hasCandles: true }), 'mesma entrada, mesmo plano')
})

test('cada tarefa só recebe métricas que existem', () => {
  const partial = { available: true, rsi: 55, atr: null, macd: null, bollinger: null, ema20: 100, structure: null, trend: 'lateral' }
  const plan = planRun({ question: 'rsi e macd', intel: partial, hasCandles: true })
  const technical = plan.tasks.find((task) => task.role === 'technical-analyst')
  assert.deepEqual(technical.receives.evidence.metrics.sort(), ['ema20', 'rsi', 'trend'])
  assert.ok(!technical.focus.includes('macd'), 'não pede foco em métrica ausente')
})

test('o prompt do agente carrega papel, evidência e o contrato', () => {
  const plan = planRun({ question: 'como está?', intel, hasCandles: true })
  const prompt = agentPrompt(plan.tasks[0])
  assert.match(prompt, /Market Analyst/)
  assert.match(prompt, /candles=sim/)
  assert.match(prompt, /Responda SOMENTE com um objeto JSON/)
  assert.match(prompt, /inconclusivo/)
})

test('o prompt leva os valores, não só os nomes das métricas', () => {
  const plan = planRun({ question: 'tendência?', intel, hasCandles: true })
  const prompt = agentPrompt(plan.tasks[0])
  assert.match(prompt, /RSI\(14\) = 62/)
  assert.match(prompt, /EMA20 = 101/)
  assert.match(prompt, /Tendência \(regra fixa\) = alta/)
  assert.match(prompt, /Faixa: 95 – 105/)
  assert.match(prompt, /Valores calculados/)
})

test('parseVerdict aceita o contrato e normaliza', () => {
  const parsed = parseVerdict(`texto antes ${valid('Alta', 0.8)} texto depois`)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.verdict.stance, 'alta')
  assert.equal(parsed.verdict.confidence, 0.8)
  assert.deepEqual(parsed.verdict.evidence, ['RSI 62', 'EMA20 101'])
})

test('parseVerdict recusa fora do contrato', () => {
  assert.equal(parseVerdict('sem json').ok, false)
  assert.equal(parseVerdict('{quebrado').ok, false)
  assert.equal(parseVerdict(JSON.stringify({ stance: 'compra', confidence: 0.5, evidence: ['x'] })).ok, false, 'stance fora do vocabulário')
  assert.equal(parseVerdict(JSON.stringify({ stance: 'alta', confidence: 2, evidence: ['x'] })).ok, false, 'confiança > 1')
  assert.equal(parseVerdict(JSON.stringify({ stance: 'alta', confidence: 0.5, evidence: [] })).ok, false, 'conclusão sem evidência')
  assert.equal(parseVerdict(JSON.stringify({ stance: 'inconclusivo', confidence: 0.2, evidence: [] })).ok, true, 'inconclusivo pode não citar evidência')
})

test('crossValidate: maioria, empate e dissenso', () => {
  const alta = { role: 'a', verdict: { stance: 'alta' } }
  const alta2 = { role: 'b', verdict: { stance: 'alta' } }
  const baixa = { role: 'c', verdict: { stance: 'baixa' } }
  const aligned = crossValidate([alta, alta2])
  assert.equal(aligned.stance, 'alta')
  assert.equal(aligned.consensus, true)
  assert.equal(aligned.agreement, 1)
  const split = crossValidate([alta, baixa])
  assert.equal(split.consensus, false)
  assert.equal(split.dissenters.length, 1)
  const tie = crossValidate([alta, alta2, baixa, baixa])
  assert.equal(tie.consensus, false)
  assert.match(tie.reason, /empate/)
  const none = crossValidate([])
  assert.equal(none.stance, 'inconclusivo')
})

test('runAgents executa o plano, valida as respostas e registra trace', async () => {
  const plan = planRun({ question: 'como está o mercado?', intel, hasCandles: true })
  const calls = []
  const run = await runAgents({ plan, callModel: async ({ role }) => { calls.push(role); return { text: valid() } } })
  assert.equal(run.ok, true)
  assert.equal(calls.length, plan.tasks.length)
  assert.equal(run.verdicts.length, plan.tasks.length)
  assert.equal(run.result.consensus, true)
  assert.equal(run.trace.entries.every((entry) => entry.status === 'ok'), true)
  assert.match(run.trace.id, /^run-/)
})

test('runAgents tenta de novo uma vez e registra a falha sem inventar parecer', async () => {
  const plan = planRun({ question: 'x', intel, hasCandles: true })
  let attempt = 0
  const run = await runAgents({
    plan,
    callModel: async () => {
      attempt += 1
      if (attempt === 1)
        throw new Error('rede caiu')
      return { text: valid('baixa', 0.6) }
    },
  })
  const first = run.trace.entries[0]
  assert.equal(first.attempts, 2)
  assert.equal(first.status, 'ok')
  assert.equal(run.verdicts[0].verdict.stance, 'baixa')
})

test('runAgents trata resposta inválida como sem parecer', async () => {
  const plan = planRun({ question: 'x', intel, hasCandles: true })
  const run = await runAgents({ plan, callModel: async () => ({ text: 'acho que vai subir' }) })
  assert.equal(run.ok, false)
  assert.equal(run.result.stance, 'inconclusivo')
  assert.equal(run.trace.entries[0].status, 'invalid')
  assert.match(run.trace.entries[0].error, /JSON/)
})

test('runAgents respeita timeout por agente e segue para o próximo', async () => {
  const plan = planRun({ question: 'x', intel, hasCandles: true })
  const run = await runAgents({
    plan,
    timeoutMs: 20,
    callModel: async ({ role }) => {
      if (role === plan.tasks[0].role)
        return new Promise(() => {}) // nunca resolve
      return { text: valid() }
    },
  })
  assert.equal(run.trace.entries[0].status, 'error')
  assert.match(run.trace.entries[0].error, /timeout/)
  assert.equal(run.trace.entries[1].status, 'ok', 'o segundo agente responde mesmo assim')
})

test('summarizeRun mostra pareceres, consenso e o aviso de interpretação', async () => {
  const plan = planRun({ question: 'risco?', intel, hasCandles: true })
  const run = await runAgents({ plan, callModel: async () => ({ text: valid('alta', 0.8) }) })
  const text = summarizeRun(run)
  assert.match(text, /Sofia · 3 parecer\(es\)/)
  assert.match(text, /Consenso: sim/)
  assert.match(text, /não são recomendação de operação/)
})

test('papéis declarados têm objetivo e foco definidos', () => {
  for (const [id, role] of Object.entries(ROLES)) {
    assert.ok(role.label && role.goal, id)
    assert.ok(Array.isArray(role.focus), id)
  }
})

test('memória do usuário entra no plano e no prompt de cada papel', () => {
  const plan = planRun({ question: 'analise o gráfico', intel: { available: true, rsi: 55, trend: 'alta', sample: 60 }, hasCandles: true, memoryNotes: ['  rompeu a máxima de 20 dias  ', '', 'stop em 1.2%'] })
  assert.deepEqual(plan.evidence.memory, ['rompeu a máxima de 20 dias', 'stop em 1.2%'], 'notas vazias são descartadas')
  for (const task of plan.tasks) {
    const prompt = agentPrompt(task)
    assert.match(prompt, /Memória desta estratégia/)
    assert.match(prompt, /rompeu a máxima de 20 dias/)
    assert.match(prompt, /contexto, não como fato de mercado/, 'a memória não vira fato de mercado')
  }
})

test('sem memória, o prompt não inventa a seção', () => {
  const plan = planRun({ question: 'analise', intel: { available: true, rsi: 55, trend: 'alta', sample: 60 }, hasCandles: true })
  assert.deepEqual(plan.evidence.memory, [])
  assert.doesNotMatch(agentPrompt(plan.tasks[0]), /Memória desta estratégia/)
})

test('memória é limitada a 10 notas para não inflar o prompt', () => {
  const notes = Array.from({ length: 25 }, (_, index) => `nota ${index}`)
  const plan = planRun({ question: 'x', intel: { available: true, rsi: 50, trend: 'lateral', sample: 60 }, hasCandles: true, memoryNotes: notes })
  assert.equal(plan.evidence.memory.length, 10)
  assert.equal(plan.evidence.memory.at(-1), 'nota 24', 'fica com as mais recentes')
})

test('resposta com JSON inválido é recusada como contrato, sem lançar', () => {
  const parsed = parseVerdict('{ stance: alta, confidence: 0.8 }')
  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /JSON inválido/)
  assert.equal(parsed.verdict, null)
})

test('resumo mostra o motivo quando um papel não entregou parecer', async () => {
  const run = await runAgents({
    plan: planRun({ question: 'x', intel: { available: true, rsi: 50, trend: 'lateral', sample: 60 }, hasCandles: true }),
    callModel: async () => ({ text: 'sem json' }),
  })
  const text = summarizeRun(run)
  assert.match(text, /(invalid|error) — /, 'o status e o motivo aparecem')
  assert.match(text, /não são recomendação de operação/)
})

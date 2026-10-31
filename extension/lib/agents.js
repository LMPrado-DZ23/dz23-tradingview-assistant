// Agent orchestration: Sofia plans, specialists answer under a strict contract, and the result is cross-validated.
//
// Design rules that make this verifiable instead of decorative:
//  - an agent only sees evidence that exists (chart, candles, computed metrics); a missing input is stated, not filled;
//  - every specialist must answer with the same JSON contract, parsed and validated here — an invalid answer is
//    recorded as `unknown`, never reinterpreted into a conclusion;
//  - disagreement is preserved: the summary lists who dissented and what each one cited;
//  - every run has a trace (id, per-agent status, duration, model) that can be printed and audited.
//
// Pure logic: the model call is injected, so tests exercise planning, parsing, validation and failure handling.

export const CONTRACT_VERSION = 1

export const ROLES = {
  'market-analyst': {
    label: 'Market Analyst',
    goal: 'ler contexto, tendência e estrutura a partir das métricas calculadas',
    focus: ['trend', 'structure', 'rsi', 'ema'],
  },
  'technical-analyst': {
    label: 'Technical Analyst',
    goal: 'avaliar níveis, momentum e volatilidade com os números disponíveis',
    focus: ['structure', 'rsi', 'macd', 'atr', 'bollinger'],
  },
  'risk-manager': {
    label: 'Risk Manager',
    goal: 'dizer o que invalidaria a leitura e qual o risco de estar errado',
    focus: ['atr', 'structure'],
  },
  'qa-reviewer': {
    label: 'QA Reviewer',
    goal: 'verificar se a conclusão se apoia em dados presentes e se rotula interpretação',
    focus: [],
  },
}

const CONTRACT_INSTRUCTIONS = `Responda SOMENTE com um objeto JSON, sem texto antes ou depois:
{"stance":"alta|baixa|lateral|inconclusivo","confidence":0.0,"evidence":["..."],"interpretation":"...","invalidation":"..."}
Regras: "stance" deve refletir os números fornecidos; "evidence" cita apenas valores presentes no contexto; se faltar
dado para concluir, use "inconclusivo" e explique em "invalidation" o que faltaria. Não invente números.`

// Which specialists a question needs, and what each one receives. Deterministic: same input, same plan.
export function planRun ({ question = '', intel = null, hasCandles = false, memoryNotes = [] } = {}) {
  const text = String(question).toLowerCase()
  const roles = new Set(['market-analyst'])
  if (/risco|stop|invalida|drawdown|perda/.test(text)) roles.add('risk-manager')
  if (/técnic|tecnic|nível|nivel|suporte|resist|momentum|rsi|macd|volat/.test(text)) roles.add('technical-analyst')
  roles.add('qa-reviewer')
  const notes = Array.isArray(memoryNotes) ? memoryNotes.map((note) => String(note ?? '').trim()).filter(Boolean).slice(-10) : []
  const evidence = {
    hasChart: Boolean(intel?.available),
    hasCandles: Boolean(hasCandles),
    // Notas que o próprio usuário registrou para esta estratégia; vão para todos os papéis, marcadas como fornecidas.
    memory: notes,
    metrics: intel?.available ? ['rsi', 'atr', 'macd', 'bollinger', 'ema20', 'structure', 'trend'].filter((key) => intel[key] !== null && intel[key] !== undefined) : [],
    // Os números: sem eles o especialista só pode responder "inconclusivo" — foi o que aconteceu em teste real
    values: intel?.available ? {
      rsi: intel.rsi,
      atr: intel.atr,
      atrPercent: intel.atrPercent,
      macd: intel.macd,
      bollinger: intel.bollinger,
      ema20: intel.ema20,
      ema50: intel.ema50 ?? null,
      sma20: intel.sma20 ?? null,
      vwap: intel.vwap ?? null,
      trend: intel.trend,
      structure: intel.structure,
      sample: intel.sample,
      timeframe: intel.timeframe,
      source: intel.source,
    } : null,
  }
  const tasks = [...roles].map((role, index) => ({
    id: `${role}-${index + 1}`,
    role,
    label: ROLES[role].label,
    goal: ROLES[role].goal,
    focus: ROLES[role].focus.filter((key) => evidence.metrics.includes(key)),
    receives: { question, evidence },
  }))
  return { question, evidence, tasks, contract: CONTRACT_VERSION }
}

// The actual numbers, so the specialist can cite them instead of naming them
function valuesBlock (values) {
  if (!values)
    return 'Valores calculados: nenhum (sem candles).'
  const lines = ['Valores calculados (use estes números):']
  if (values.rsi !== null && values.rsi !== undefined) lines.push(`- RSI(14) = ${values.rsi}`)
  if (values.atr !== null && values.atr !== undefined) lines.push(`- ATR(14) = ${values.atr} (${values.atrPercent}% do preço)`)
  if (values.macd) lines.push(`- MACD = ${values.macd.value} · sinal ${values.macd.signal} · histograma ${values.macd.histogram}`)
  if (values.bollinger) lines.push(`- Bollinger = ${values.bollinger.lower} / ${values.bollinger.middle} / ${values.bollinger.upper}`)
  if (values.ema20 !== null && values.ema20 !== undefined) lines.push(`- EMA20 = ${values.ema20}${values.ema50 !== null ? ` · EMA50 = ${values.ema50}` : ''}${values.sma20 !== null ? ` · SMA20 = ${values.sma20}` : ''}`)
  if (values.vwap !== null && values.vwap !== undefined) lines.push(`- VWAP = ${values.vwap}`)
  if (values.trend) lines.push(`- Tendência (regra fixa) = ${values.trend}`)
  if (values.structure) lines.push(`- Faixa: ${values.structure.rangeLow} – ${values.structure.rangeHigh} · swing highs ${JSON.stringify(values.structure.swingHighs)} · swing lows ${JSON.stringify(values.structure.swingLows)}`)
  lines.push(`- Amostra: ${values.sample} candles de ${values.source ?? 'fonte pública'} · timeframe ${values.timeframe ?? '—'}`)
  return lines.join('\n')
}

export function agentPrompt (task) {
  const lines = [
    `Você é ${task.label} no DZ23. Objetivo: ${task.goal}.`,
    task.focus.length ? `Foque em: ${task.focus.join(', ')}.` : 'Sem métrica específica: avalie a consistência da conclusão.',
    '',
    `Pergunta do usuário: ${task.receives.question}`,
    '',
    `Evidência disponível: gráfico=${task.receives.evidence.hasChart ? 'sim' : 'não'}, candles=${task.receives.evidence.hasCandles ? 'sim' : 'não'}, métricas=${task.receives.evidence.metrics.join(', ') || 'nenhuma'}.`,
    valuesBlock(task.receives.evidence.values),
    ...(task.receives.evidence.memory?.length
      ? ['', 'Memória desta estratégia (fornecida pelo usuário; trate como contexto, não como fato de mercado):', ...task.receives.evidence.memory.map((note) => `- ${note}`)]
      : []),
    'Se a evidência não bastar, responda "inconclusivo" e diga o que falta.',
    '',
    CONTRACT_INSTRUCTIONS,
  ]
  return lines.join('\n')
}

const STANCES = new Set(['alta', 'baixa', 'lateral', 'inconclusivo'])

// Extracts the JSON object from a model answer and validates it. Anything off-contract becomes `unknown`.
export function parseVerdict (text) {
  const raw = String(text ?? '')
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match)
    return { ok: false, reason: 'sem objeto JSON na resposta', verdict: null }
  let parsed
  try {
    parsed = JSON.parse(match[0])
  } catch {
    return { ok: false, reason: 'JSON inválido', verdict: null }
  }
  const stance = String(parsed.stance ?? '').toLowerCase()
  if (!STANCES.has(stance))
    return { ok: false, reason: `stance fora do contrato: ${parsed.stance ?? 'ausente'}`, verdict: null }
  const confidence = Number(parsed.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    return { ok: false, reason: `confidence inválida: ${parsed.confidence ?? 'ausente'}`, verdict: null }
  const evidence = Array.isArray(parsed.evidence) ? parsed.evidence.filter((item) => typeof item === 'string' && item.trim()).slice(0, 8) : []
  if (stance !== 'inconclusivo' && !evidence.length)
    return { ok: false, reason: 'conclusão sem evidência citada', verdict: null }
  return {
    ok: true,
    verdict: {
      stance,
      confidence,
      evidence,
      interpretation: typeof parsed.interpretation === 'string' ? parsed.interpretation.slice(0, 600) : '',
      invalidation: typeof parsed.invalidation === 'string' ? parsed.invalidation.slice(0, 400) : '',
    },
  }
}

// Majority over the specialists that produced a verdict. A tie or a single opinion is not "consensus".
export function crossValidate (verdicts = []) {
  const valid = verdicts.filter((entry) => entry?.verdict)
  if (!valid.length)
    return { stance: 'inconclusivo', agreement: 0, consensus: false, dissenters: [], reason: 'nenhum parecer válido' }
  const counts = new Map()
  for (const entry of valid) {
    const stance = entry.verdict.stance
    if (stance === 'inconclusivo')
      continue
    counts.set(stance, (counts.get(stance) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (!ranked.length)
    return { stance: 'inconclusivo', agreement: 0, consensus: false, dissenters: valid.map((entry) => entry.role), reason: 'todos inconclusivos' }
  const [stance, votes] = ranked[0]
  const decisive = valid.filter((entry) => entry.verdict.stance !== 'inconclusivo').length
  const dissenting = valid.filter((entry) => entry.verdict.stance !== stance)
  const tie = ranked.length > 1 && ranked[1][1] === votes
  return {
    stance,
    agreement: decisive ? votes / decisive : 0,
    consensus: !tie && votes >= 2 && dissenting.length === 0,
    dissenters: dissenting.map((entry) => ({ role: entry.role, stance: entry.verdict.stance })),
    reason: tie ? 'empate entre pareceres' : (dissenting.length ? 'há divergência' : 'pareceres alinhados'),
  }
}

// Runs the plan with limits: one retry on failure, a timeout per agent, and a trace for every attempt.
export async function runAgents ({ plan, callModel, timeoutMs = 45_000, now = () => Date.now(), id = () => `run-${Math.random().toString(36).slice(2, 10)}` } = {}) {
  if (!plan?.tasks?.length)
    return { ok: false, reason: 'plano vazio', trace: { id: id(), startedAt: now(), entries: [] } }
  const trace = { id: id(), startedAt: now(), entries: [], contract: plan.contract }
  const verdicts = []

  for (const task of plan.tasks) {
    const entry = { task: task.id, role: task.role, attempts: 0, status: 'pending', durationMs: null, error: null, text: null }
    const started = now()
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      entry.attempts = attempt
      try {
        const answer = await Promise.race([
          callModel({ prompt: agentPrompt(task), role: task.role, task }),
          new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'timeout' })), timeoutMs)),
        ])
        entry.text = String(answer?.text ?? answer ?? '')
        entry.model = answer?.model ?? null
        const parsed = parseVerdict(entry.text)
        if (parsed.ok) {
          entry.status = 'ok'
          verdicts.push({ role: task.role, verdict: parsed.verdict })
          break
        }
        entry.status = 'invalid'
        entry.error = parsed.reason
        if (attempt === 2)
          verdicts.push({ role: task.role, verdict: null, invalid: parsed.reason })
      } catch (error) {
        entry.status = 'error'
        entry.error = String(error?.message ?? error)
        if (attempt === 2)
          verdicts.push({ role: task.role, verdict: null, error: entry.error })
      }
    }
    entry.durationMs = now() - started
    trace.entries.push(entry)
  }

  const result = crossValidate(verdicts)
  trace.finishedAt = now()
  trace.result = result
  return { ok: trace.entries.some((entry) => entry.status === 'ok'), result, verdicts, trace }
}

// Chat-ready summary: what each agent said, the agreement, the dissent and what is missing.
export function summarizeRun (run) {
  if (!run)
    return 'sem execução'
  const lines = [`Sofia · ${run.trace.entries.length} parecer(es) · trace ${run.trace.id}`]
  for (const entry of run.trace.entries) {
    const verdict = run.verdicts.find((item) => item.role === entry.role)?.verdict
    if (entry.status === 'ok' && verdict)
      lines.push(`- ${entry.role}: ${verdict.stance} (confiança ${verdict.confidence}) · evidência: ${verdict.evidence.join('; ') || '—'}`)
    else
      lines.push(`- ${entry.role}: ${entry.status} — ${entry.error ?? 'sem parecer válido'}`)
  }
  const result = run.result ?? {}
  lines.push(`Consenso: ${result.consensus ? 'sim' : 'não'} (${result.reason ?? '—'}, concordância ${Math.round((result.agreement ?? 0) * 100)}%)`)
  if (result.dissenters?.length)
    lines.push(`Divergência: ${result.dissenters.map((item) => `${item.role}=${item.stance}`).join(', ')}`)
  lines.push('Pareceres são interpretação sobre os números citados; não são recomendação de operação.')
  return lines.join('\n')
}

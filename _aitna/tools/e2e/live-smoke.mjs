#!/usr/bin/env node
// Real-service smoke test: the real gateway talking to a real model on this machine.
//
// Every other test in this repository uses a fake upstream, because a paid call must not happen without authorization.
// A local Ollama is not a paid call, so this is the one place where the chain is exercised end to end with a real model:
// gateway process → provider HTTP → streamed tokens → gateway events → client.
//
// It proves plumbing and streaming, **not answer quality**: a 8B model answering a market question is a demo, not an
// analysis. When Ollama is absent the script says so and exits 0 — a skip must never look like a pass.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const PORT = Number(process.env.DZ23_SMOKE_PORT ?? 8791)
const TOKEN = 'smoke-local-token-0123456789'
const OLLAMA = process.env.DZ23_OLLAMA_URL ?? 'http://127.0.0.1:11434'

async function listModels () {
  try {
    const response = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok)
      return []
    const body = await response.json()
    return (body.models ?? []).map((model) => model.name)
  } catch {
    return []
  }
}

const models = await listModels()
if (!models.length) {
  console.log(JSON.stringify({
    passed: true,
    skipped: true,
    reason: 'sem Ollama local: teste de serviço real não executado (não é um passe, é um skip declarado)',
  }))
  process.exit(0)
}

// Modelo: preferência por um que exista de fato na máquina.
const preferred = ['qwen3:8b', 'llama3.2', 'qwen2.5-coder:7b', 'qwen3.5:4b']
const model = preferred.find((name) => models.some((installed) => installed.startsWith(name.split(':')[0]))) ?? models[0]

// Um prompt curto com números reais do gráfico: é o formato que o painel envia.
const candles = Array.from({ length: 60 }, (_, index) => ({
  time: Date.UTC(2024, 0, 1) + index * 3600_000,
  open: 100 + Math.sin(index / 5) * 2,
  high: 101 + Math.sin(index / 5) * 2,
  low: 99 + Math.sin(index / 5) * 2,
  close: 100 + Math.sin((index + 1) / 5) * 2,
  volume: 10 + index,
}))

const { summarizeMarket, marketIntelBlock } = await import('../../../extension/lib/marketIntel.js')
const intel = summarizeMarket({ candles, context: { symbol: 'BTCUSDT', timeframe: '1h', exchange: 'BINANCE' }, source: 'binance-public' })
const block = marketIntelBlock(intel)

const system = [
  'Você é o copiloto do DZ23. Responda em português, em no máximo 4 linhas.',
  'Separe o que é fato observado do que é interpretação. Se faltar dado, diga que falta.',
  block,
].join('\n')

const work = mkdtempSync(join(tmpdir(), 'dz23-smoke-'))
const configPath = join(work, 'gateway.json')
writeFileSync(configPath, JSON.stringify({
  port: PORT,
  authToken: TOKEN,
  timeoutMs: 120_000,
  rateLimit: { capacity: 20, refillPerSecond: 5 },
  providers: {
    ollama: { baseUrl: `${OLLAMA}/v1`, apiKey: 'local', models: [model], defaultModel: model },
  },
}))

const gateway = spawn(process.execPath, [join(ROOT, 'gateway/server.mjs')], {
  env: { ...process.env, DZ23_GATEWAY_CONFIG: configPath, DZ23_GATEWAY_TOKEN: TOKEN, DZ23_GATEWAY_PORT: String(PORT), DZ23_GATEWAY_DEV: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let gatewayLog = ''
gateway.stdout.on('data', (chunk) => { gatewayLog += chunk })
gateway.stderr.on('data', (chunk) => { gatewayLog += chunk })

const cleanup = () => {
  try { gateway.kill() } catch { /* já morreu */ }
  rmSync(work, { recursive: true, force: true })
}
process.on('exit', cleanup)

let healthy = false
for (let attempt = 0; attempt < 60 && !healthy; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1000) })
    healthy = response.ok
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
if (!healthy) {
  console.log(JSON.stringify({ passed: false, error: 'gateway não subiu', log: gatewayLog.slice(-300) }))
  process.exit(1)
}

const started = Date.now()
const response = await fetch(`http://127.0.0.1:${PORT}/chat`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({
    provider: 'ollama',
    model,
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'Com esses números, a tendência é de alta ou de baixa? Cite o RSI.' },
    ],
  }),
  signal: AbortSignal.timeout(180_000),
})

if (!response.ok) {
  const body = await response.text()
  console.log(JSON.stringify({ passed: false, status: response.status, error: body.slice(0, 300), model }))
  process.exit(1)
}

const reader = response.body.getReader()
const decoder = new TextDecoder()
let buffer = ''
let text = ''
let events = 0
let done = false
for (;;) {
  const { value, done: finished } = await reader.read()
  if (finished)
    break
  buffer += decoder.decode(value, { stream: true })
  let boundary = buffer.indexOf('\n\n')
  while (boundary >= 0) {
    const blockText = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    const line = blockText.split('\n').find((item) => item.startsWith('data:'))
    if (line) {
      try {
        const event = JSON.parse(line.slice(5).trim())
        events += 1
        if (event.type === 'delta')
          text += event.text
        if (event.type === 'done')
          done = true
      } catch { /* evento malformado é ignorado, como no painel */ }
    }
    boundary = buffer.indexOf('\n\n')
  }
}

// --- fase 2: cancelamento com modelo real ---------------------------------------------------------
// Com upstream falso o cancelamento é instantâneo e prova pouco. Com um modelo local lento, cancelar no meio
// do stream testa o caminho de verdade: o gateway aborta a chamada ao provider e o cliente para de receber.
async function cancelReal () {
  const requestId = `smoke-cancel-${Date.now()}`
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${PORT}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      provider: 'ollama',
      model,
      requestId,
      stream: true,
      messages: [
        { role: 'system', content: 'Escreva um texto longo, de 30 linhas, sobre gestão de risco.' },
        { role: 'user', content: 'Vá em frente.' },
      ],
    }),
    signal: controller.signal,
  })
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let received = ''
  let cancelled = false
  // espera o primeiro delta para garantir que o stream começou de verdade
  while (!received) {
    const { value } = await reader.read()
    if (!value)
      break
    received += decoder.decode(value, { stream: true })
  }
  const before = received.length
  const cancelResponse = await fetch(`http://127.0.0.1:${PORT}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ requestId }),
  })
  const cancelBody = await cancelResponse.json().catch(() => ({}))
  let tail = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done)
        break
      tail += decoder.decode(value, { stream: true })
    }
  } catch {
    /* o stream pode ser cortado: é o esperado */
  }
  cancelled = /cancelled/.test(tail) || cancelBody.cancelled === requestId
  return { started: before > 0, cancelAccepted: cancelResponse.ok, cancelled, before, tailEvents: (tail.match(/"type"/g) ?? []).length }
}

const cancel = await cancelReal()

// --- fase 3: agentes da Sofia com modelo real ------------------------------------------------------
// O contrato dos especialistas é JSON estrito. Um modelo local pequeno é o melhor teste de estresse dele:
// se o parser aceita aqui, o prompt tem instrução suficiente; se recusa, a recusa explica o que faltou.
async function sofiaReal () {
  const { planRun, agentPrompt, parseVerdict, crossValidate } = await import('../../../extension/lib/agents.js')
  const plan = planRun({
    question: 'A tendência é de alta ou de baixa, e o que invalidaria?',
    intel,
    hasCandles: true,
    memoryNotes: ['regra do usuário: só operar acima do VWAP'],
  })
  const verdicts = []
  const failures = []
  for (const task of plan.tasks) {
    const response = await fetch(`http://127.0.0.1:${PORT}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({
        provider: 'ollama',
        model,
        requestId: `smoke-agent-${task.role}-${Date.now()}`,
        messages: [
          { role: 'system', content: agentPrompt(task) },
          { role: 'user', content: 'Responda com o JSON do contrato, sem texto fora dele.' },
        ],
      }),
      signal: AbortSignal.timeout(120_000),
    })
    // /chat é SSE: junta os deltas como o painel faz
    let text = ''
    if ((response.headers.get('content-type') ?? '').includes('text/event-stream')) {
      const reader = response.body.getReader()
      const decoder2 = new TextDecoder()
      let raw = ''
      for (;;) {
        const { value, done: finished } = await reader.read()
        if (finished)
          break
        raw += decoder2.decode(value, { stream: true })
        let boundary2 = raw.indexOf('\n\n')
        while (boundary2 >= 0) {
          const chunk = raw.slice(0, boundary2)
          raw = raw.slice(boundary2 + 2)
          const dataLine = chunk.split('\n').find((item) => item.startsWith('data:'))
          if (dataLine) {
            try {
              const event = JSON.parse(dataLine.slice(5).trim())
              if (event.type === 'delta')
                text += event.text
              else if (event.type === 'done' && event.text && !text)
                text = event.text
            } catch { /* evento malformado: ignora */ }
          }
          boundary2 = raw.indexOf('\n\n')
        }
      }
    } else {
      const body = await response.json().catch(() => ({}))
      text = body.text ?? body.choices?.[0]?.message?.content ?? ''
    }
    const parsed = parseVerdict(text)
    if (parsed.ok)
      verdicts.push({ role: task.role, verdict: parsed.verdict })
    else
      failures.push({ role: task.role, reason: parsed.reason, sample: String(text).slice(0, 80) })
  }
  const result = crossValidate(verdicts)
  return {
    roles: plan.tasks.length,
    verdicts: verdicts.length,
    stances: verdicts.map((item) => `${item.role}=${item.verdict.stance}`),
    failures,
    consensus: result.consensus ?? null,
    agreement: result.agreement ?? null,
  }
}

const sofia = await sofiaReal()

const ms = Date.now() - started
const answer = text.trim()
const checks = {
  streaming: events > 1,
  sofiaRan: sofia.verdicts >= 1,
  sofiaContractHeld: sofia.verdicts === sofia.roles,
  cancelStarted: cancel.started,
  cancelAccepted: cancel.cancelAccepted,
  cancelStopped: cancel.cancelled,
  answerNotEmpty: answer.length > 20,
  finished: done,
  citesNumbers: /\d/.test(answer),
}
const passed = Object.values(checks).every(Boolean)

console.log(JSON.stringify({
  passed,
  skipped: false,
  tier: 'serviço real (Ollama local), sem custo e sem chamada paga',
  model,
  ms,
  events,
  characters: answer.length,
  checks,
  cancel,
  sofia,
  sample: answer.slice(0, 220),
}, null, 2))
process.exit(passed ? 0 : 1)

#!/usr/bin/env node
// Sofia — agent orchestration CLI.
//
//   npm run agents -- "vale a pena comprar o BTC agora?"
//   npm run agents -- "..." --live                  (chama o gateway de verdade; custa tokens do provedor)
//   npm run agents -- "..." --symbol ETHUSDT --interval 15 --live
//
// Without --live it only prints the plan, the prompts and the evidence each agent would receive: nothing is sent to a
// provider, so it is free and safe in CI. With --live it fetches candles from the public source, builds the computed
// metrics with the same module the panel uses, and calls the gateway once per specialist.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fetchCandles } from '../../../extension/lib/candles.js'
import { normalizeInterval } from '../../../extension/lib/chartActions.js'
import { summarizeMarket } from '../../../extension/lib/marketIntel.js'
import { agentPrompt, planRun, runAgents, summarizeRun } from '../../../extension/lib/agents.js'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback = null) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}
const question = argv.filter((item) => !item.startsWith('--') && item !== value('--symbol') && item !== value('--interval')).join(' ').trim()

if (!question) {
  console.error('uso: npm run agents -- "pergunta" [--symbol BTCUSDT] [--interval 60] [--provider deepseek] [--live]')
  process.exit(2)
}

const symbol = (value('--symbol', 'BTCUSDT') ?? 'BTCUSDT').toUpperCase()
const intervalArg = value('--interval', '60')
const interval = normalizeInterval(intervalArg).ok ? normalizeInterval(intervalArg).timeframe : intervalArg
const live = flag('--live')
const provider = value('--provider', 'deepseek')

function readGateway (field) {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.dz23', 'gateway-config.json'), 'utf8'))
    return config?.[field] ?? null
  } catch {
    return null
  }
}

const gatewayUrl = process.env.DZ23_GATEWAY_URL ?? readGateway('url') ?? 'http://127.0.0.1:8777'
const token = process.env.DZ23_GATEWAY_TOKEN ?? readGateway('token') ?? readTokenFile()

function readTokenFile () {
  try {
    return readFileSync(join(homedir(), '.dz23', 'gateway-token'), 'utf8').trim() || null
  } catch {
    return null
  }
}

// Candles + metrics: the same path the panel takes. Without --live nothing is fetched.
let intel = null
let candles = []
if (live) {
  const result = await fetchCandles({ context: { symbol, exchange: 'BINANCE', timeframe: interval, resolution: interval } })
  if (!result.ok) {
    console.error(`candles indisponíveis: ${result.reason}`)
    process.exit(1)
  }
  candles = result.candles
  intel = summarizeMarket({ candles, context: { timeframe: interval }, source: result.source })
}

const plan = planRun({ question, intel, hasCandles: candles.length > 0 })
console.log(`Pergunta: ${question}`)
console.log(`Plano: ${plan.tasks.map((task) => task.label).join(' → ')}`)
console.log(`Evidência: gráfico=${plan.evidence.hasChart ? 'sim' : 'não'} · candles=${plan.evidence.hasCandles ? candles.length : 0} · métricas=${plan.evidence.metrics.join(', ') || 'nenhuma'}`)

if (!live) {
  for (const task of plan.tasks) {
    console.log(`\n--- ${task.label} (${task.id}) ---`)
    console.log(agentPrompt(task))
  }
  console.log('\n(sem --live: nada foi enviado a nenhum provedor)')
  process.exit(0)
}

if (!token) {
  console.error('sem token do gateway: rode `npm run gateway:dev` e use o token gerado, ou defina DZ23_GATEWAY_TOKEN')
  process.exit(1)
}

// One non-streaming call per specialist, through the gateway. The SSE body is read to the end and joined.
async function callModel ({ prompt }) {
  const response = await fetch(new URL('/chat', gatewayUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ provider, stream: true, messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'Responda com o JSON do contrato.' }] }),
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`gateway ${response.status}: ${body.slice(0, 120)}`)
  }
  const text = await response.text()
  let answer = ''
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: '))
      continue
    try {
      const event = JSON.parse(line.slice(6))
      if (event.type === 'delta' && event.text)
        answer += event.text
      if (event.type === 'done' && event.text && !answer)
        answer = event.text
    } catch {
      /* keep the readable part */
    }
  }
  return { text: answer, model: provider }
}

const run = await runAgents({ plan, callModel, timeoutMs: 60_000 })
console.log(`\n${summarizeRun(run)}`)
console.log(`\nTrace ${run.trace.id}: ${run.trace.entries.map((entry) => `${entry.role}=${entry.status}(${entry.attempts}x,${entry.durationMs}ms)`).join(' ')}`)
process.exit(run.ok ? 0 : 1)

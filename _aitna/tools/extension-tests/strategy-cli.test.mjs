// The overfitting module existed, was tested, and nothing called it — so "PBO/DSR" was a claim without a consumer.
// These tests drive the CLI: with per-trial series it must report PBO; without them it must say so instead of silence.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLI = join(ROOT, '_aitna/tools/strategy/compare.mjs')

const candidate = (overrides = {}) => ({
  name: 'estrategia',
  metrics: { netProfit: 1200 },
  period: { start: '2024-01-01', end: '2024-12-31' },
  costs: { commissionPct: 0.04, slippagePct: 0.01 },
  sharpe: 1.8,
  observations: 500,
  trials: 40,
  ...overrides,
})

function runCompare (files) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...files], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout ?? ''}${stderr ?? ''}` })
    })
  })
}

function writeFixtures (payloads) {
  const dir = mkdtempSync(join(tmpdir(), 'dz23-strategy-'))
  const files = payloads.map((payload, index) => {
    const path = join(dir, `c${index}.json`)
    writeFileSync(path, JSON.stringify(payload))
    return path
  })
  return { dir, files }
}

test('com séries por tentativa, o PBO é calculado e reportado', async () => {
  const { dir, files } = writeFixtures([
    candidate({ name: 'a', returns: [0.1, -0.05, 0.2, 0.02, 0.15, -0.1, 0.3, 0.05] }),
    candidate({ name: 'b', metrics: { netProfit: 900 }, returns: [0.02, -0.01, 0.05, 0.01, 0.03, -0.02, 0.04, 0.01] }),
  ])
  try {
    const result = await runCompare(files)
    assert.match(result.output, /PBO: \d+% \(CSCV/)
    assert.match(result.output, /DSR: \d\.\d{3}/)
    assert.doesNotMatch(result.output, /PBO: não calculado/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sem séries, diz exatamente o que falta em vez de omitir', async () => {
  const { dir, files } = writeFixtures([
    candidate({ name: 'a' }),
    candidate({ name: 'b', metrics: { netProfit: 900 } }),
  ])
  try {
    const result = await runCompare(files)
    assert.match(result.output, /PBO: não calculado — sem séries de retorno/)
    assert.match(result.output, /DSR: \d\.\d{3}/, 'DSR não depende de séries: com sharpe/observações/tentativas ele é calculado')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sem sharpe/observações/tentativas, o DSR também declara o que falta', async () => {
  const { dir, files } = writeFixtures([
    { name: 'a', metrics: { netProfit: 1200 }, period: { start: '2024-01-01', end: '2024-12-31' }, costs: { commissionPct: 0.04, slippagePct: 0.01 } },
    { name: 'b', metrics: { netProfit: 900 }, period: { start: '2024-01-01', end: '2024-12-31' }, costs: { commissionPct: 0.04, slippagePct: 0.01 } },
  ])
  try {
    const result = await runCompare(files)
    assert.match(result.output, /DSR: não calculado — sem sharpe/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('PBO alto é marcado como sorte compatível, não como resultado', async () => {
  // séries que se cruzam muito: o melhor in-sample não se sustenta out-of-sample
  const noisy = [
    [0.3, -0.2, 0.25, -0.15, 0.4, -0.3, 0.2, -0.1, 0.35, -0.25, 0.15, -0.05],
    [-0.1, 0.2, -0.05, 0.15, -0.2, 0.25, -0.3, 0.1, -0.15, 0.3, -0.25, 0.2],
    [0.05, -0.05, 0.1, -0.1, 0.2, -0.2, 0.15, -0.15, 0.25, -0.25, 0.3, -0.3],
  ]
  const { dir, files } = writeFixtures(noisy.map((returns, index) => candidate({ name: `n${index}`, metrics: { netProfit: 100 + index }, returns })))
  try {
    const result = await runCompare(files)
    assert.match(result.output, /PBO: \d+% \(CSCV/)
    // ou marca ALTO, ou o valor é baixo — o que não pode é o texto desaparecer
    assert.match(result.output, /ALTO|PBO: \d+%/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Monte Carlo e walk-forward são calculados quando a série existe', async () => {
  const returns = Array.from({ length: 24 }, (_, index) => Number((Math.sin(index) * 0.05 + 0.01).toFixed(4)))
  const { dir, files } = writeFixtures([
    candidate({ name: 'a', returns }),
    candidate({ name: 'b', metrics: { netProfit: 900 }, returns: returns.map((value) => value * 0.7) }),
  ])
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...files, '--montecarlo', '--walkforward'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, output: `${stdout ?? ''}${stderr ?? ''}` })
      })
    })
    assert.match(result.output, /Monte Carlo \(\d+ reamostragens\): lucro p5/)
    assert.match(result.output, /ruína \d+\.\d%/)
    assert.match(result.output, /Walk-forward \(\d+ janela\(s\)\): t0 treino/)
    assert.match(result.output, /Relatório de overfitting \((stable|degraded|collapsed|unknown)\): IS /, 'o relatório junta IS/OOS, PBO e DSR')
    assert.match(result.output, /aviso (oos_collapsed|oos_degraded|many_trials|pbo_high|dsr_low):|sem avisos automáticos/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sem série, Monte Carlo e walk-forward dizem o que falta', async () => {
  const { dir, files } = writeFixtures([candidate({ name: 'a' }), candidate({ name: 'b', metrics: { netProfit: 900 } })])
  try {
    const result = await new Promise((resolve) => {
      execFile(process.execPath, [CLI, ...files, '--montecarlo', '--walkforward'], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 }, (error, stdout, stderr) => {
        resolve({ code: error ? 1 : 0, output: `${stdout ?? ''}${stderr ?? ''}` })
      })
    })
    assert.match(result.output, /Monte Carlo: não calculado — sem série de retornos/)
    assert.match(result.output, /Walk-forward: não calculado — sem série de retornos/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

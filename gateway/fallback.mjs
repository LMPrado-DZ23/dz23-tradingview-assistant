// Provider fallback and usage ledger (§12).
//
// The rules are narrow on purpose: a fallback is only used when the first provider failed *before any text was delivered*
// and the failure is the provider's (timeout, 5xx, rate limit, unreachable) — not when the request itself was wrong, because
// retrying a bad request on another provider just burns quota. Every attempt is recorded, successful or not, and the ledger
// is a bounded ring so a long session cannot grow without limit.

export const USAGE_LIMIT = 200

// A failure worth trying another provider for: the provider is at fault, not the payload.
export function isFallbackable (code) {
  return ['timeout', 'upstream_error', 'rate_limited', 'provider_unavailable', 'internal_error'].includes(code)
}

// Builds the ordered chain: the requested provider first, then the explicit fallbacks (or every other configured one).
export function buildProviderChain (providers = [], { provider = null, fallback = null } = {}) {
  const enabled = providers.filter((item) => item.enabled)
  const configured = enabled.filter((item) => item.configured)
  const first = provider ?? configured[0]?.id ?? null
  if (!first)
    return []
  const requested = enabled.find((item) => item.id === first)
  if (!requested)
    throw new Error(`unknown or disabled provider "${first}"`)
  const ids = [first]
  const candidates = Array.isArray(fallback)
    ? fallback
    : fallback === true
      ? configured.map((item) => item.id)
      : []
  for (const candidate of candidates) {
    if (ids.includes(candidate))
      continue
    const found = enabled.find((item) => item.id === candidate)
    if (!found)
      continue
    if (found.configured)
      ids.push(candidate)
  }
  return ids
}

export function createUsageLedger (limit = USAGE_LIMIT) {
  return { entries: [], limit }
}

export function recordUsage (ledger, entry) {
  ledger.entries.push({ at: new Date().toISOString(), ...entry })
  while (ledger.entries.length > ledger.limit)
    ledger.entries.shift()
  return ledger
}

// Aggregates per provider; a provider with zero attempts simply does not appear.
export function summarizeUsage (ledger) {
  const byProvider = {}
  for (const entry of ledger.entries) {
    const row = byProvider[entry.provider] ?? { attempts: 0, ok: 0, failed: 0, totalMs: 0, inputTokens: 0, outputTokens: 0, lastError: null }
    row.attempts += 1
    if (entry.ok) {
      row.ok += 1
      row.totalMs += Number(entry.ms ?? 0)
    } else {
      row.failed += 1
      row.lastError = entry.code ?? 'error'
      row.totalMs += Number(entry.ms ?? 0)
    }
    row.inputTokens += Number(entry.inputTokens ?? 0)
    row.outputTokens += Number(entry.outputTokens ?? 0)
    byProvider[entry.provider] = row
  }
  for (const row of Object.values(byProvider))
    row.averageMs = row.attempts ? Math.round(row.totalMs / row.attempts) : null
  return {
    window: ledger.entries.length,
    limit: ledger.limit,
    providers: byProvider,
    last: ledger.entries.at(-1) ?? null,
  }
}

// One stream attempt over a chain. `attempt(providerId)` must resolve {ok: true, ...} or throw {code, delivered?}.
// Returns { used, attempts, results } and never swallows the last error.
export async function runWithFallback ({ chain, attempt, onFallback = null }) {
  const results = []
  let lastError = null
  for (let index = 0; index < chain.length; index += 1) {
    const provider = chain[index]
    try {
      const result = await attempt(provider)
      results.push({ provider, ok: true })
      return { used: provider, attempts: results.length, results, result }
    } catch (error) {
      lastError = error
      results.push({ provider, ok: false, code: error?.code ?? 'error' })
      const canRetry = index + 1 < chain.length && isFallbackable(error?.code) && !error?.delivered
      if (!canRetry)
        break
      if (onFallback)
        onFallback(provider, chain[index + 1], error)
    }
  }
  const failure = lastError ?? new Error('fallback exhausted')
  failure.attempts = results
  throw failure
}

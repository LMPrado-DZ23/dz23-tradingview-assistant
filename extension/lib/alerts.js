// Alerts: rules evaluated locally against a price/indicator snapshot.
//
// Honest scope: these are DZ23 alerts, evaluated when the panel evaluates them. They are not TradingView alerts —
// TradingView runs its own alerts on its servers and exposes no public API for creating them, so nothing here claims
// to have done that. A rule fires once per crossing (state is stored), and every evaluation returns the real state
// read back from the stored rules, not the intent.

export const ALERT_TYPES = ['price_above', 'price_below', 'rsi_above', 'rsi_below', 'pct_move']

const number = (value) => (Number.isFinite(Number(value)) ? Number(value) : null)

export function createAlert ({ symbol, type, value, note = '', cooldownMs = 15 * 60_000, now = () => Date.now() } = {}) {
  const cleanSymbol = String(symbol ?? '').trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9._-]{1,20}(:[A-Z][A-Z0-9._-]{1,20})?$/.test(cleanSymbol))
    return { ok: false, reason: 'símbolo inválido' }
  if (!ALERT_TYPES.includes(type))
    return { ok: false, reason: `tipo inválido: use ${ALERT_TYPES.join(', ')}` }
  const threshold = number(value)
  if (threshold === null)
    return { ok: false, reason: 'valor do alerta precisa ser numérico' }
  if ((type === 'rsi_above' || type === 'rsi_below') && (threshold < 0 || threshold > 100))
    return { ok: false, reason: 'RSI vai de 0 a 100' }
  return {
    ok: true,
    alert: {
      id: `al-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      symbol: cleanSymbol,
      type,
      value: threshold,
      note: String(note).slice(0, 120),
      state: 'armed',
      armedAt: new Date(now()).toISOString(),
      lastFiredAt: null,
      lastValue: null,
      cooldownMs,
    },
  }
}

// Editing keeps the identity and the state; only the fields that make sense to change are accepted.
// A fired alert can be edited and is re-armed, because the old condition no longer describes what the user wants.
export function editAlert (alerts, id, patch = {}, now = () => Date.now()) {
  const alert = alerts.find((item) => item.id === id)
  if (!alert)
    return { ok: false, reason: 'alerta não encontrado' }
  const next = { ...alert }
  if (patch.type !== undefined) {
    if (!ALERT_TYPES.includes(patch.type))
      return { ok: false, reason: `tipo inválido: use ${ALERT_TYPES.join(', ')}` }
    next.type = patch.type
  }
  if (patch.value !== undefined) {
    const threshold = number(patch.value)
    if (threshold === null)
      return { ok: false, reason: 'valor do alerta precisa ser numérico' }
    if ((next.type === 'rsi_above' || next.type === 'rsi_below') && (threshold < 0 || threshold > 100))
      return { ok: false, reason: 'RSI vai de 0 a 100' }
    next.value = threshold
  }
  if (patch.note !== undefined)
    next.note = String(patch.note).slice(0, 120)
  if (patch.cooldownMs !== undefined) {
    const cooldown = number(patch.cooldownMs)
    if (cooldown === null || cooldown < 0)
      return { ok: false, reason: 'cooldown precisa ser um número >= 0' }
    next.cooldownMs = cooldown
  }
  const changed = next.type !== alert.type || next.value !== alert.value || next.note !== alert.note || next.cooldownMs !== alert.cooldownMs
  if (!changed)
    return { ok: true, alerts, unchanged: true }
  next.editedAt = new Date(now()).toISOString()
  // Condição mudou: volta a monitorar e zera o último disparo, senão o alerta novo herdaria o silêncio do antigo.
  if (next.type !== alert.type || next.value !== alert.value) {
    next.state = 'armed'
    next.lastFiredAt = null
    next.lastValue = null
  }
  return { ok: true, alerts: alerts.map((item) => (item.id === id ? next : item)), alert: next }
}

export function pauseAlert (alerts, id, now = () => Date.now()) {
  const alert = alerts.find((item) => item.id === id)
  if (!alert)
    return { ok: false, reason: 'alerta não encontrado' }
  return { ok: true, alerts: alerts.map((item) => (item.id === id ? { ...item, state: 'paused', pausedAt: new Date(now()).toISOString() } : item)) }
}

export function resumeAlert (alerts, id) {
  const alert = alerts.find((item) => item.id === id)
  if (!alert)
    return { ok: false, reason: 'alerta não encontrado' }
  return { ok: true, alerts: alerts.map((item) => (item.id === id ? { ...item, state: 'armed', lastValue: null } : item)) }
}

export function removeAlert (alerts, id) {
  if (!alerts.some((item) => item.id === id))
    return { ok: false, reason: 'alerta não encontrado' }
  return { ok: true, alerts: alerts.filter((item) => item.id !== id) }
}

// snapshot: { [symbol]: { price, rsi, changePct, at } }
export function evaluateAlerts (alerts, snapshot = {}, now = () => Date.now()) {
  const fired = []
  const pending = []
  const skipped = []
  const updated = alerts.map((alert) => {
    if (alert.state !== 'armed') {
      skipped.push({ id: alert.id, reason: `estado ${alert.state}` })
      return alert
    }
    const reading = snapshot[alert.symbol]
    if (!reading || reading.price === undefined || reading.price === null) {
      skipped.push({ id: alert.id, reason: 'sem leitura para o símbolo' })
      return alert
    }
    const price = number(reading.price)
    const rsi = number(reading.rsi)
    const changePct = number(reading.changePct)
    let crossed = false
    let observed = null
    if (alert.type === 'price_above') { observed = price; crossed = price !== null && price > alert.value }
    else if (alert.type === 'price_below') { observed = price; crossed = price !== null && price < alert.value }
    else if (alert.type === 'rsi_above') { observed = rsi; crossed = rsi !== null && rsi > alert.value }
    else if (alert.type === 'rsi_below') { observed = rsi; crossed = rsi !== null && rsi < alert.value }
    else if (alert.type === 'pct_move') { observed = changePct; crossed = changePct !== null && Math.abs(changePct) >= Math.abs(alert.value) }

    if (observed === null) {
      skipped.push({ id: alert.id, reason: 'leitura sem o campo necessário' })
      return alert
    }
    const cooldownActive = alert.lastFiredAt && (now() - Date.parse(alert.lastFiredAt)) < (alert.cooldownMs ?? 0)
    if (!crossed) {
      pending.push({ id: alert.id, symbol: alert.symbol, type: alert.type, value: alert.value, observed })
      return { ...alert, lastValue: observed }
    }
    if (cooldownActive) {
      pending.push({ id: alert.id, symbol: alert.symbol, type: alert.type, value: alert.value, observed, cooldown: true })
      return { ...alert, lastValue: observed }
    }
    fired.push({ id: alert.id, symbol: alert.symbol, type: alert.type, value: alert.value, observed, at: new Date(now()).toISOString() })
    return { ...alert, state: 'fired', lastFiredAt: new Date(now()).toISOString(), lastValue: observed }
  })
  return { alerts: updated, fired, pending, skipped, checkedAt: new Date(now()).toISOString() }
}

export function summarizeAlerts (evaluation) {
  if (!evaluation)
    return 'sem avaliação'
  const lines = [`Avaliação ${evaluation.checkedAt}: ${evaluation.fired.length} disparado(s), ${evaluation.pending.length} aguardando, ${evaluation.skipped.length} sem leitura`]
  for (const item of evaluation.fired)
    lines.push(`- DISPAROU ${item.symbol} ${item.type} ${item.value} (observado ${item.observed})`)
  for (const item of evaluation.pending)
    lines.push(`- aguardando ${item.symbol} ${item.type} ${item.value} (observado ${item.observed}${item.cooldown ? ', em cooldown' : ''})`)
  for (const item of evaluation.skipped)
    lines.push(`- sem avaliação ${item.id}: ${item.reason}`)
  lines.push('Alertas do DZ23: avaliados aqui, não são alertas do TradingView.')
  return lines.join('\n')
}

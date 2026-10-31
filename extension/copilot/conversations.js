// DZ23 Copilot — conversation persistence.
//
// A chat that loses its history on one bad write is unusable, so loading is defensive by design: a corrupt entry,
// an older schema or one malformed conversation never throws and never takes the rest of the history with it.
// Pure functions: the storage is passed in, so the recovery rules are tested without a browser.

export const STATE_VERSION = 3

export function emptyState (defaultGateway = 'http://127.0.0.1:8777') {
  return {
    version: STATE_VERSION,
    conversations: [],
    activeId: null,
    settings: { gatewayUrl: defaultGateway, token: '', provider: '', model: '', modelsByProvider: {}, user: 'local' },
  }
}

function cleanSettings (settings, defaults) {
  const source = settings && typeof settings === 'object' ? settings : {}
  return {
    ...defaults.settings,
    ...Object.fromEntries(Object.entries(source).filter(([, value]) => typeof value === 'string' || (value && typeof value === 'object'))),
  }
}

function cleanConversation (value) {
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id)
    return null
  const messages = Array.isArray(value.messages)
    ? value.messages
      .filter((message) => message && typeof message === 'object' && typeof message.content === 'string' &&
        (message.role === 'user' || message.role === 'assistant'))
      .map((message) => ({
        role: message.role,
        content: message.content.slice(0, 200_000),
        at: typeof message.at === 'string' ? message.at : null,
        provider: typeof message.provider === 'string' ? message.provider : null,
        model: typeof message.model === 'string' ? message.model : null,
        rating: message.rating === 'up' || message.rating === 'down' ? message.rating : null,
        streaming: false,
      }))
    : []
  const context = value.context && typeof value.context === 'object' ? value.context : {}
  return {
    id: value.id,
    title: typeof value.title === 'string' && value.title.trim() ? value.title.slice(0, 120) : 'Nova conversa',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    context: {
      asset: typeof context.asset === 'string' ? context.asset : '',
      timeframe: typeof context.timeframe === 'string' ? context.timeframe : '',
      strategy: typeof context.strategy === 'string' ? context.strategy : '',
      notes: typeof context.notes === 'string' ? context.notes : '',
    },
    messages,
  }
}

/**
 * Reads a stored state. Returns { state, repaired, reason } — `repaired` means something was dropped or migrated,
 * which the UI can surface instead of pretending nothing happened.
 */
export function readState (raw, defaults = emptyState()) {
  if (typeof raw !== 'string' || !raw.trim())
    return { state: defaults, repaired: false, reason: 'empty' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { state: defaults, repaired: true, reason: 'corrupt json' }
  }
  if (!parsed || typeof parsed !== 'object')
    return { state: defaults, repaired: true, reason: 'not an object' }

  const conversations = []
  const seen = new Set()
  for (const candidate of Array.isArray(parsed.conversations) ? parsed.conversations : []) {
    const conversation = cleanConversation(candidate)
    if (!conversation || seen.has(conversation.id))
      continue
    seen.add(conversation.id)
    conversations.push(conversation)
  }

  const droppedCount = (Array.isArray(parsed.conversations) ? parsed.conversations.length : 0) - conversations.length
  const state = {
    version: STATE_VERSION,
    conversations,
    activeId: conversations.some((conversation) => conversation.id === parsed.activeId) ? parsed.activeId : (conversations[0]?.id ?? null),
    settings: cleanSettings(parsed.settings, defaults),
  }
  const migrated = parsed.version !== STATE_VERSION
  const repaired = droppedCount > 0 || migrated || state.activeId !== (parsed.activeId ?? null)
  return {
    state,
    repaired,
    reason: repaired ? [droppedCount ? `${droppedCount} conversa(s) inválida(s)` : null, migrated ? `esquema v${parsed.version ?? '?'} migrado para v${STATE_VERSION}` : null].filter(Boolean).join(', ') : 'ok',
  }
}

export function writeState (state) {
  const safe = { ...state, version: STATE_VERSION }
  return { json: JSON.stringify(safe), state: safe }
}

// One conversation by id, so a deep link or a recovery action can open it without touching the others.
export function findConversation (state, id) {
  return (state?.conversations ?? []).find((conversation) => conversation.id === id) ?? null
}

// The most recent conversation, used when the stored activeId no longer exists.
export function mostRecent (state) {
  return [...(state?.conversations ?? [])].sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))[0] ?? null
}

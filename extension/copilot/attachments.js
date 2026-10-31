// DZ23 Copilot — attachments.
//
// An attachment is text the user chooses to send with a message. The gateway and the model only ever receive
// text: the validation here is the boundary that keeps a binary, a huge file or an executable out of the chat.
// Pure functions, so the limits are tested without a browser.

export const ATTACHMENT_LIMITS = { maxBytes: 256 * 1024, maxCount: 3, maxChars: 20_000 }

// Only formats the model can read as text and that a trader actually exports: notes, CSV, JSON, Markdown.
export const ALLOWED_TYPES = [
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
]

const EXTENSION_TYPES = {
  txt: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
}

export function normaliseType (name, type) {
  const declared = String(type ?? '').toLowerCase().split(';')[0].trim()
  if (ALLOWED_TYPES.includes(declared))
    return declared
  const extension = String(name ?? '').toLowerCase().split('.').pop()
  return EXTENSION_TYPES[extension] ?? (declared || 'application/octet-stream')
}

// { ok: true, type } or { ok: false, code, message } — the caller shows the message, never a silent drop.
export function validateFile ({ name = '', type = '', size = 0 } = {}, { count = 0, limits = ATTACHMENT_LIMITS } = {}) {
  if (count >= limits.maxCount)
    return { ok: false, code: 'count', message: `no máximo ${limits.maxCount} anexos por mensagem` }
  const resolved = normaliseType(name, type)
  if (!ALLOWED_TYPES.includes(resolved))
    return { ok: false, code: 'type', message: `"${name || 'arquivo'}" não é um formato de texto aceito (${ALLOWED_TYPES.join(', ')})` }
  if (!Number.isFinite(size) || size <= 0)
    return { ok: false, code: 'empty', message: `"${name || 'arquivo'}" está vazio` }
  if (size > limits.maxBytes)
    return { ok: false, code: 'size', message: `"${name}" tem ${Math.round(size / 1024)} KB; o limite é ${Math.round(limits.maxBytes / 1024)} KB` }
  return { ok: true, type: resolved }
}

// The text block that reaches the message. Truncation is marked, so the model knows it did not see everything.
export function attachmentText (name, content, { maxChars = ATTACHMENT_LIMITS.maxChars } = {}) {
  const text = String(content ?? '')
  const clipped = text.length > maxChars
  return {
    name,
    chars: text.length,
    truncated: clipped,
    text: clipped ? `${text.slice(0, maxChars)}\n… (anexo truncado em ${maxChars} caracteres de ${text.length})` : text,
  }
}

// How the attachment appears in the user message: the name plus the content, clearly delimited.
export function renderForMessage (attachment) {
  return `[anexo: ${attachment.name}]\n\`\`\`\n${attachment.text}\n\`\`\``
}

// The chips the composer shows; kept pure so a test can assert what the user sees.
export function attachmentSummary (attachment) {
  return `${attachment.name} · ${Math.max(1, Math.round(attachment.chars / 1024))} KB${attachment.truncated ? ' (truncado)' : ''}`
}

// Pine generation helpers: prompt building and code extraction. The generation itself needs a model; these are pure so
// the contract can be tested without network, and the CLI validates whatever comes back with the linter before showing it.

const BT = String.fromCharCode(96)
const FENCE = BT.repeat(3)

export const PINE_GEN_CONTRACT = [
  'Responda SOMENTE com um bloco de código Pine Script, sem explicação antes ou depois.',
  'Comece com //@version=5. Use apenas funções documentadas da v5.',
  'Se for estratégia, inclua commission/slippage e uma saída explícita (strategy.exit ou close).',
  'Não use request.security com lookahead_on e não referencie barras futuras.',
].join('\n')

export function buildPinePrompt (spec, { kind = 'indicator' } = {}) {
  const description = String(spec ?? '').trim()
  if (!description)
    throw new Error('descreva o indicador ou a estratégia')
  const lines = [
    `Você é um engenheiro de Pine Script. Gere um ${kind === 'strategy' ? 'estratégia' : 'indicador'} para:`,
    description,
    '',
    PINE_GEN_CONTRACT,
  ]
  return lines.join('\n')
}

// Accepts ```pine, ```, or a bare script. Returns the code and what was discarded, so the caller can show it.
export function extractPineCode (text) {
  const raw = String(text ?? '')
  const fenced = raw.match(new RegExp(FENCE + '(?:pine|pinescript)?\\s*\\n([^]*?)' + FENCE, 'i'))
  if (fenced && fenced[1].trim())
    return { code: fenced[1].trim(), discarded: raw.replace(fenced[0], '').trim() }
  const looksLikePine = /\/\/\s*@version|\b(indicator|strategy)\s*\(/.test(raw)
  if (looksLikePine)
    return { code: raw.trim(), discarded: '' }
  return { code: '', discarded: raw.trim(), reason: 'a resposta não contém bloco Pine nem declaração reconhecível' }
}

export function describeGeneration ({ code, report, discarded }) {
  const lines = []
  if (!code) {
    lines.push('geração sem código Pine reconhecível')
    if (discarded)
      lines.push(`resposta descartada (primeiros 200 caracteres): ${discarded.slice(0, 200)}`)
    return lines.join('\n')
  }
  lines.push(report.ok ? 'script gerado e aprovado pelo validador' : `script gerado com ${report.summary.errors} erro(s) — NÃO usar antes de corrigir`)
  lines.push(`versão ${report.version ?? '?'} · ${report.kind ?? 'sem declaração'} · ${report.summary.warnings} aviso(s)`)
  for (const finding of report.findings)
    lines.push(`  ${finding.level} L${finding.line}: [${finding.code}] ${finding.message}`)
  if (discarded)
    lines.push(`(texto fora do bloco descartado: ${discarded.slice(0, 120)})`)
  return lines.join('\n')
}

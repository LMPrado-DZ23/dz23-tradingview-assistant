// Pine explanation: the linter's findings are facts, the model's prose is interpretation, and they are printed apart.
// Pure helpers so the contract is testable without a provider.

export const EXPLAIN_CONTRACT = [
  'Explique o script Pine abaixo em português, em no máximo 12 linhas.',
  'Separe explicitamente: (1) o que o script calcula, (2) entradas e parâmetros, (3) risco de repainting ou uso de dados futuros, (4) o que NÃO é possível concluir só pelo código.',
  'Não afirme rentabilidade. Se algo depender de dados que você não tem, diga que não dá para concluir.',
].join('\n')

export function buildExplainPrompt (code, report, { maxCodeChars = 6000 } = {}) {
  const source = String(code ?? '')
  if (!source.trim())
    throw new Error('sem código para explicar')
  const findings = (report?.findings ?? []).map((finding) => `- ${finding.level} L${finding.line} [${finding.code}] ${finding.message}`)
  return [
    'Você é um engenheiro de Pine Script revisando código de outra pessoa.',
    EXPLAIN_CONTRACT,
    '',
    'Achados do validador (fatos verificados, não repita como se fossem sua opinião):',
    findings.length ? findings.join('\n') : '- nenhum achado',
    `Resumo do validador: ${report?.summary?.errors ?? 0} erro(s), ${report?.summary?.warnings ?? 0} aviso(s), versão ${report?.version ?? '?'}.`,
    '',
    'Código:',
    '```pine',
    source.slice(0, maxCodeChars) + (source.length > maxCodeChars ? '\n// ... truncado' : ''),
    '```',
  ].join('\n')
}

// Keeps the two authorities visibly separate. The first block is measured; the second is the model speaking.
export function formatExplanation ({ report, answer }) {
  const lines = []
  const errors = report?.summary?.errors ?? 0
  const warnings = report?.summary?.warnings ?? 0
  lines.push(`Validador (fatos): ${errors} erro(s), ${warnings} aviso(s), versão ${report?.version ?? '?'} · tipo ${report?.kind ?? 'sem declaração'}`)
  for (const finding of report?.findings ?? [])
    lines.push(`  ${finding.level} L${finding.line}: [${finding.code}] ${finding.message}`)
  lines.push('')
  lines.push('Explicação do modelo (interpretação, não verificação):')
  lines.push(String(answer ?? '').trim() || '(sem resposta do modelo)')
  return lines.join('\n')
}

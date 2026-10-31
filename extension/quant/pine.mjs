// Pine Script static validation for the Strategy Lab.
//
// This is a linter, not a compiler: it does not run the script and cannot prove it compiles on TradingView. It finds
// the problems that make a script unusable or the result misleading — missing declaration, unbalanced syntax, an
// unsupported version, look-ahead through request.security, future references, deprecated calls, and a strategy that
// reports performance without costs or without an exit rule. Every finding names the line and the pattern, so the
// author can check it in the editor.
//
// validatePine(source) always returns a report; it never throws.

export const SUPPORTED_VERSIONS = [1, 2, 3, 4, 5, 6]

const lines = (source) => String(source ?? '').split(/\r?\n/)

function lineOf (text, index) {
  return index + 1
}

function stripComment (line) {
  // removable: a comment after a string is rare enough in Pine that this simplification is safe, and it avoids
  // matching keywords inside comments
  const withoutBlock = line.replace(/\/\*[^]*?\*\//g, '')
  return withoutBlock.replace(/\/\/.*$/, '')
}

export function validatePine (source, { minVersion = 4 } = {}) {
  const findings = []
  const add = (level, code, message, line) => findings.push({ level, code, message, line })

  const text = String(source ?? '')
  const allLines = lines(text)
  const code = allLines.map(stripComment)

  if (!text.trim()) {
    add('error', 'pine.empty', 'o script está vazio', 1)
    return report({ version: null, kind: null, findings, allLines, text })
  }

  // ---- version
  const versionMatch = text.match(/^\s*\/\/\s*@version\s*=\s*(\d+)/m)
  const version = versionMatch ? Number(versionMatch[1]) : null
  if (!versionMatch)
    add('warning', 'pine.version_missing', 'sem "//@version=" o TradingView assume Pine v1; declare a versão', 1)
  else if (!SUPPORTED_VERSIONS.includes(version))
    add('error', 'pine.version_unsupported', `versão ${version} não existe (suportadas: ${SUPPORTED_VERSIONS.join(', ')})`, lineOf(text, text.indexOf(versionMatch[0].trim()) ? text.slice(0, text.indexOf(versionMatch[0].trim())).split('\n').length - 1 : 0))
  else if (version < minVersion)
    add('warning', 'pine.version_old', `versão ${version} é antiga; migre para v5/v6`, 1)

  // ---- declaration
  const indicatorAt = code.findIndex((line) => /\bindicator\s*\(/.test(line))
  const strategyAt = code.findIndex((line) => /\bstrategy\s*\(/.test(line))
  const kind = strategyAt >= 0 ? 'strategy' : indicatorAt >= 0 ? 'indicator' : null
  if (!kind)
    add('error', 'pine.declaration_missing', 'falta a declaração "indicator(...)" ou "strategy(...)" na primeira linha útil', 1)
  else if (strategyAt >= 0 && indicatorAt >= 0 && strategyAt > indicatorAt)
    add('error', 'pine.declaration_conflict', 'há "indicator(" e "strategy(" no mesmo script', strategyAt + 1)

  // ---- syntax the compiler would reject
  const joined = code.join('\n')
  for (const [open, close, name] of [['(', ')', 'parênteses'], ['[', ']', 'colchetes'], ['{', '}', 'chaves']]) {
    const balance = [...joined].reduce((total, char) => total + (char === open ? 1 : char === close ? -1 : 0), 0)
    if (balance !== 0)
      add('error', 'pine.unbalanced', `${name} desbalanceados (${balance > 0 ? 'faltam' : 'sobraram'} ${Math.abs(balance)})`, 1)
  }
  code.forEach((line, index) => {
    const quotes = (line.match(/"/g) ?? []).length
    if (quotes % 2 !== 0)
      add('error', 'pine.string_unterminated', 'string não terminada', index + 1)
  })

  // ---- look-ahead / repainting: the two ways a script lies about the past
  code.forEach((line, index) => {
    if (/request\.security\s*\(/.test(line) && /lookahead\s*=\s*barmerge\.lookahead_on/.test(line))
      add('warning', 'pine.lookahead', 'request.security com lookahead_on usa dados do futuro do timeframe superior', index + 1)
    // Comentário não é código: sem isso, a palavra numa nota geraria falso positivo.
    const withoutComment = line.replace(/\/\/.*$/, '')
    if (/\bvarip\b/.test(withoutComment))
      add('warning', 'pine.repainting_varip', 'varip mantém o valor entre ticks: o histórico difere do tempo real (repinta)', index + 1)
    if (/calc_on_every_tick\s*=\s*true/.test(withoutComment))
      add('warning', 'pine.repainting_calc_on_tick', 'calc_on_every_tick=true recalcula a cada tick: o resultado histórico não é reproduzível', index + 1)
    if (/barstate\.isrealtime/.test(line))
      add('warning', 'pine.repainting_realtime', 'barstate.isrealtime em condição de sinal: o resultado histórico difere do tempo real', index + 1)
    const future = line.match(/\b[a-zA-Z_][\w.]*\s*\[\s*-(\d+)\s*\]/)
    if (future)
      add('error', 'pine.future_reference', `referência a barra futura [-${future[1]}]`, index + 1)
    if (/\bsecurity\s*\(/.test(line) && !/request\.security\s*\(/.test(line))
      add('warning', 'pine.deprecated_security', '"security(" sem namespace foi descontinuado a partir da v5', index + 1)
    if (/\bstudy\s*\(/.test(line))
      add('warning', 'pine.deprecated_study', '"study(" foi substituído por "indicator(" na v5', index + 1)
    if (/\bta\./.test(line) && (version ?? 1) < 5 && !/\/\/@version/.test(line))
      add('error', 'pine.namespace_version', 'namespace "ta." exige Pine v5 ou superior', index + 1)
  })

  // ---- a strategy that reports performance must say what it costs and how it exits
  if (kind === 'strategy') {
    const declaration = code[strategyAt] ?? ''
    const hasCosts = /commission|slippage/i.test(declaration)
    const entries = code.filter((line) => /strategy\.(entry|order)\s*\(/.test(line)).length
    const exits = code.filter((line) => /strategy\.(exit|close)\s*\(/.test(line)).length
    if (!hasCosts)
      add('warning', 'pine.strategy_no_costs', 'strategy() sem commission/slippage: o backtest ignora custos reais', strategyAt + 1)
    if (!entries)
      add('warning', 'pine.strategy_no_entry', 'estratégia sem strategy.entry(): nada é operado', strategyAt + 1)
    if (entries && !exits)
      add('warning', 'pine.strategy_no_exit', 'há entrada e nenhum strategy.exit(): posição sem alvo/stop explícito', strategyAt + 1)
  }

  return report({ version, kind, findings, allLines, text, strategyAt: kind === 'strategy' ? strategyAt : null })
}

function report ({ version, kind, findings, allLines, text }) {
  const errors = findings.filter((finding) => finding.level === 'error')
  const warnings = findings.filter((finding) => finding.level === 'warning')
  return {
    ok: errors.length === 0,
    version,
    kind,
    findings: findings.sort((a, b) => a.line - b.line),
    stats: {
      lines: allLines.filter((line) => line.trim()).length,
      securityCalls: (text.match(/request\.security\s*\(/g) ?? []).length,
      entries: (text.match(/strategy\.(entry|order)\s*\(/g) ?? []).length,
      indicators: (text.match(/indicator\s*\(/g) ?? []).length,
    },
    summary: { errors: errors.length, warnings: warnings.length },
  }
}

// Human-readable lines for the CLI and the UI
export function formatPineReport (result) {
  const header = `${result.ok ? 'OK' : 'ERROS'} · ${result.kind ?? 'sem declaração'}${result.version ? ` · v${result.version}` : ''} · ${result.summary.errors} erro(s), ${result.summary.warnings} aviso(s)`
  const body = result.findings.map((finding) => `  ${finding.level === 'error' ? 'erro ' : 'aviso'} L${finding.line}: [${finding.code}] ${finding.message}`)
  return [header, ...body].join('\n')
}

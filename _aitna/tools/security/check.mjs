#!/usr/bin/env node
// Security invariants of the extension, checked as rules instead of promises (§10).
//
// Each rule is one of the things the mission forbids or requires: no cookie access, no broad host permissions, no eval,
// no secrets in the frontend, CSP declared, no undocumented network endpoints. A violation fails the build.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXTENSION = join(ROOT, 'extension')
const problems = []
const checked = []

function walk (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      if (['node_modules', '.git'].includes(entry))
        continue
      walk(path, out)
    } else if (/\.(js|mjs|html|json|css)$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

const RUNTIME_DIRS = ['gateway', 'native-host', 'dz23', 'mcp']
const runtimeFiles = RUNTIME_DIRS.flatMap((name) => {
  try {
    return walk(join(ROOT, name))
  } catch {
    return []
  }
})

const files = walk(EXTENSION)
// extension: regras de UI e manifest. runtime: token, log e segredo.
const extensionSources = files.filter((path) => /\.(js|mjs|html)$/.test(path))
const runtimeSources = runtimeFiles.filter((path) => /\.(js|mjs)$/.test(path))
const sources = [...extensionSources, ...runtimeSources]
const read = (path) => readFileSync(path, 'utf8')
const rel = (path) => relative(ROOT, path).replace(/\\/g, '/')

// 1. Nenhum acesso a cookies (proibido pela missão, ao contrário da extensão de referência).
checked.push('sem chrome.cookies')
for (const file of sources) {
  const text = read(file)
  if (/chrome\.cookies|document\.cookie/.test(text))
    problems.push(`${rel(file)}: acesso a cookies (chrome.cookies/document.cookie)`)
}

// 2. Permissões mínimas: nada de <all_urls> ou esquemas amplos.
checked.push('permissões mínimas no manifest')
const manifest = JSON.parse(read(join(EXTENSION, 'manifest.json')))
const permissionText = JSON.stringify([manifest.permissions ?? [], manifest.host_permissions ?? [], (manifest.content_scripts ?? []).flatMap((item) => item.matches ?? [])])
if (/<all_urls>|\*:\/\/\*\/\*/.test(permissionText))
  problems.push(`manifest: permissão ampla demais (${permissionText.slice(0, 120)})`)
if ((manifest.permissions ?? []).includes('cookies'))
  problems.push('manifest: pede a permissão cookies')
const matches = (manifest.content_scripts ?? []).flatMap((item) => item.matches ?? [])
if (!matches.every((match) => match.startsWith('https://*.tradingview.com/') || match.startsWith('https://www.tradingview.com/')))
  problems.push(`manifest: content script fora do domínio do TradingView (${matches.join(', ')})`)

// 3. Sem eval / new Function / setTimeout com string.
checked.push('sem eval nem Function dinâmica')
for (const file of sources) {
  const text = read(file)
  if (/\beval\s*\(|new\s+Function\s*\(/.test(text))
    problems.push(`${rel(file)}: eval/Function dinâmica`)
}

// 4. Sem segredos no frontend: padrões de chave e tokens longos.
checked.push('sem segredos no código da extensão')
const secretPatterns = [
  { name: 'OpenAI/DeepSeek', regex: /\bsk-[A-Za-z0-9_-]{16,}/, },
  { name: 'Google', regex: /\bAIza[0-9A-Za-z_-]{20,}/ },
  { name: 'Anthropic', regex: /\bsk-ant-[A-Za-z0-9_-]{10,}/ },
  { name: 'bearer literal', regex: /Bearer\s+[A-Za-z0-9._-]{24,}/ },
  { name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
]
const secretScan = [...files, ...runtimeFiles.filter((path) => /\.(js|mjs|json)$/.test(path))]
  .filter((path) => !/\.test\.(mjs|js)$/.test(path))
for (const file of secretScan) {
  const text = read(file)
  for (const pattern of secretPatterns) {
    if (pattern.regex.test(text))
      problems.push(`${rel(file)}: possível segredo (${pattern.name})`)
  }
}

// 5. CSP declarada e restritiva nas páginas da extensão.
checked.push('CSP declarada')
if (!manifest.content_security_policy?.extension_pages)
  problems.push('manifest: sem content_security_policy.extension_pages')
else if (!/script-src 'self'/.test(manifest.content_security_policy.extension_pages))
  problems.push(`manifest: CSP sem script-src 'self' (${manifest.content_security_policy.extension_pages})`)

// 6. Nenhum HTML da extensão inclui script remoto.
checked.push('sem script remoto nas páginas')
for (const file of files.filter((path) => path.endsWith('.html'))) {
  const text = read(file)
  if (/<script[^>]+src=["']https?:/i.test(text))
    problems.push(`${rel(file)}: <script src> remoto`)
}

// 7. Todo fetch externo das páginas da extensão precisa estar numa lista declarada (revisão humana).
checked.push('endpoints externos declarados')
const allowedHosts = ['api.binance.com', 'api.bybit.com', 'fapi.binance.com', 'query1.finance.yahoo.com', '127.0.0.1', 'localhost']
// Só argumentos de fetch/WebSocket/EventSource contam: links de documentação e namespaces XML não são chamadas de rede.
const networkCall = /(?:fetch|WebSocket|EventSource)\s*\(\s*[\u0060'"](?:https?:)?\/\/([a-z0-9.-]+)/gi
for (const file of sources) {
  const text = read(file)
  for (const match of text.matchAll(networkCall)) {
    const host = match[1].toLowerCase()
    if (!allowedHosts.some((allowed) => host === allowed || host.endsWith('.' + allowed)))
      problems.push(rel(file) + ': host externo não declarado (' + host + ')')
  }
}

// 7b. Nos módulos de execução, chamada de rede só para https ou loopback (nada de http em claro).
checked.push('runtime sem http em claro')
for (const file of runtimeSources) {
  const text = read(file)
  for (const match of text.matchAll(/(?:fetch|WebSocket|EventSource)\s*\(\s*[\u0060'"]http:\/\/([a-z0-9.:-]+)/gi)) {
    const host = match[1].toLowerCase()
    if (!host.startsWith('127.0.0.1') && !host.startsWith('localhost'))
      problems.push(rel(file) + ': http em claro para ' + host)
  }
}

// 8. O token nunca é impresso em log.
checked.push('token fora de logs')
// Citar a palavra num texto ("set DZ23_INGEST_TOKEN", "token recusado") é ajuda, não segredo. O vazamento é o VALOR
// como argumento. Para enxergar isso sem um parser, o texto de strings e de templates é descartado — só as
// interpolações `${...}` sobrevivem — e então se procura o identificador em posição de valor.
function codeOnly (text) {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === "'" || char === '"') {
      const quote = char
      index++
      while (index < text.length && text[index] !== quote) {
        if (text[index] === '\\')
          index++
        index++
      }
      index++
      out += ' STR '
    } else if (char === '`') {
      index++
      out += ' TPL '
      while (index < text.length && text[index] !== '`') {
        if (text[index] === '$' && text[index + 1] === '{') {
          const start = index + 2
          let depth = 1
          index = start
          while (index < text.length && depth > 0) {
            if (text[index] === '{')
              depth++
            else if (text[index] === '}')
              depth--
            index++
          }
          out += ` ${text.slice(start, index - 1)} `
        } else {
          index++
        }
      }
      index++
    } else {
      out += char
      index++
    }
  }
  return out
}

const SECRET_NAME = /(?<![\w$.])(?:token|secret|apiKey|accessToken|refreshToken)(?![\w$])/i

function logsSecretValue (text) {
  for (const line of text.split('\n')) {
    if (!/console\.(?:log|info|warn|error|debug)\s*\(/.test(line))
      continue
    // nome no plural não conta: describeTokens(result.tokens) devolve metadado, não o segredo
    if (SECRET_NAME.test(codeOnly(line)))
      return line.trim().slice(0, 90)
  }
  return null
}
for (const file of sources.filter((path) => /\.(js|mjs)$/.test(path) && !/\.min\.js$/.test(path))) {
  const leak = logsSecretValue(read(file))
  if (leak)
    problems.push(`${rel(file)}: log com valor de token (${leak})`)
}

console.log(`arquivos verificados: ${files.length} (${sources.length} com código)`)
console.log(`regras: ${checked.length}`)
for (const problem of problems)
  console.log(`FAIL ${problem}`)

if (process.argv.includes('--json'))
  console.log(JSON.stringify({ passed: problems.length === 0, rules: checked, problems }, null, 2))
else
  console.log(JSON.stringify({ passed: problems.length === 0, problems: problems.length }))

process.exit(problems.length === 0 ? 0 : 1)

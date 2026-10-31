#!/usr/bin/env node
// Permissões do manifest conferidas contra o código: §10 proíbe pedir permissão genérica sem necessidade, e loja de
// extensão reprova extensão que pede mais do que usa. Uma auditoria "de olho" erra — a minha errou duas vezes por causa
// de glob do shell — então ela vira gate.
//
// Regra: toda permissão declarada precisa de evidência de uso no código OU de uma justificativa explícita em ALLOWED
// (permissões implícitas por natureza, como unlimitedStorage, não aparecem em chamada de API).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXT = join(ROOT, 'extension')

// Cada permissão declara como se prova que é usada, ou por que dispensar a prova.
const RULES = {
  storage: { evidence: /chrome\.storage|storage\.local|storage\.sync/, kind: 'code' },
  unlimitedStorage: {
    kind: 'implicit',
    why: 'não aparece em chamada de API: eleva a cota do chrome.storage.local, que guarda memória e histórico de conversas e pode passar de 10 MB com uso longo',
  },
  activeTab: {
    kind: 'implicit',
    why: 'não aparece em chamada de API: concede acesso temporário à aba quando o usuário clica no painel, que é o gesto que abre o copiloto',
  },
  sidePanel: { evidence: /sidePanel/, kind: 'code' },
  tabs: { evidence: /chrome\.tabs/, kind: 'code' },
  scripting: { evidence: /chrome\.scripting|executeScript/, kind: 'code' },
  nativeMessaging: { evidence: /connectNative|sendNativeMessage/, kind: 'code' },
  alarms: { evidence: /chrome\.alarms/, kind: 'code' },
  notifications: { evidence: /chrome\.notifications/, kind: 'code' },
  contextMenus: { evidence: /chrome\.contextMenus/, kind: 'code' },
  cookies: { evidence: /chrome\.cookies/, kind: 'code' },
  webRequest: { evidence: /chrome\.webRequest/, kind: 'code' },
  declarativeNetRequest: { evidence: /declarativeNetRequest/, kind: 'code' },
  download: { evidence: /chrome\.downloads/, kind: 'code' },
}

function sourceFiles (directory, out = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out)
    } else if (/\.(js|mjs)$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'))
const files = sourceFiles(EXT)
const sources = files.map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))

const problems = []
const notes = []

for (const permission of manifest.permissions ?? []) {
  const rule = RULES[permission]
  if (!rule) {
    problems.push({ kind: 'unknown_permission', permission, detail: 'permissão sem regra: declare como é usada ou por que é implícita' })
    continue
  }
  if (rule.kind === 'implicit') {
    notes.push(`${permission}: implícita — ${rule.why}`)
    continue
  }
  const usedBy = sources.filter((file) => rule.evidence.test(file.text)).map((file) => file.path)
  if (!usedBy.length)
    problems.push({ kind: 'unused_permission', permission, detail: 'declarada no manifest e não usada em nenhum arquivo do código' })
  else
    notes.push(`${permission}: usada em ${usedBy.slice(0, 2).join(', ')}${usedBy.length > 2 ? ` (+${usedBy.length - 2})` : ''}`)
}

// host_permissions: cada origem declarada precisa aparecer no código (senão o pedido não tem por quê)
for (const origin of manifest.host_permissions ?? []) {
  const host = origin.replace(/^https?:\/\//, '').replace(/\/\*$/, '').replace(/^\*\./, '')
  const used = sources.some((file) => file.text.includes(host.split('/')[0].replace('*.', '')))
  if (!used)
    problems.push({ kind: 'unused_host_permission', permission: origin, detail: `nenhum arquivo menciona ${host}` })
  else
    notes.push(`host ${origin}: citado no código`)
}

// proibidas por princípio (§10): captura de sessão do TradingView
if ((manifest.permissions ?? []).includes('cookies'))
  problems.push({ kind: 'forbidden_permission', permission: 'cookies', detail: '§10 proíbe capturar cookies de sessão do TradingView' })

for (const note of notes)
  console.log(`ok    ${note}`)
for (const problem of problems)
  console.log(`FAIL  ${problem.kind}: ${problem.permission} — ${problem.detail}`)
console.log(JSON.stringify({
  passed: problems.length === 0,
  permissions: (manifest.permissions ?? []).length,
  hosts: (manifest.host_permissions ?? []).length,
  files: files.length,
  problems,
}))
process.exit(problems.length === 0 ? 0 : 1)

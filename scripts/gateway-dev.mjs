// One command to run the local gateway for the extension.
//
//   npm run gateway:dev
//
// - reuses (or creates) a stable token in ~/.dz23/gateway-token, so the panel pairs once and keeps working;
// - loads provider keys from ~/.dz23/providers.env, outside the repository, if that file exists;
// - inherits the user environment, so a key already set there (e.g. DEEPSEEK_API_KEY) is used as is;
// - binds 127.0.0.1 in development mode, which accepts the local http origin and unpacked extensions.
//
// It never prints a key, and the token it prints is the one to paste into the copilot settings (⚙).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const state = join(homedir(), '.dz23')
mkdirSync(state, { recursive: true })

const tokenFile = join(state, 'gateway-token')
let token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : ''
if (!token) {
  token = randomUUID()
  writeFileSync(tokenFile, token, { mode: 0o600 })
  console.log(`[gateway] token criado em ${tokenFile}`)
}

const envFile = join(state, 'providers.env')
if (existsSync(envFile)) {
  let loaded = 0
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match || line.trim().startsWith('#'))
      continue
    const value = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
    if (value && !process.env[match[1]]) {
      process.env[match[1]] = value
      loaded += 1
    }
  }
  console.log(`[gateway] ${loaded} chave(s) lida(s) de ${envFile}`)
}

console.log(`[gateway] http://127.0.0.1:${process.env.DZ23_GATEWAY_PORT ?? 8777}`)
console.log('[gateway] token para o copiloto:')
console.log('')
console.log(`  ${token}`)
console.log('')
console.log('[gateway] copie com:  Get-Content "$env:USERPROFILE\\.dz23\\gateway-token" | Set-Clipboard')

const child = spawn(process.execPath, [join(root, 'gateway', 'server.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DZ23_GATEWAY_TOKEN: token,
    DZ23_GATEWAY_DEV: process.env.DZ23_GATEWAY_DEV ?? '1',
    DZ23_GATEWAY_PORT: process.env.DZ23_GATEWAY_PORT ?? '8777',
  },
})
child.on('exit', (code) => process.exit(code ?? 0))

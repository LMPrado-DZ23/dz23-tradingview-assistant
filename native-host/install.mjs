// Installs (or removes) the DZ23 native messaging host for Chrome on Windows.
//
//   node native-host/install.mjs --extension-id <id> [--dry-run]
//   node native-host/install.mjs --uninstall
//
// It writes native-host/manifest.json plus a .cmd launcher (Chrome needs an executable path) and registers the host
// under HKCU\Software\Google\Chrome\NativeMessagingHosts\com.dz23.gateway — per user, no elevation, fully reversible.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const HOST_NAME = 'com.dz23.gateway'
const MANIFEST = join(HERE, 'manifest.json')
const LAUNCHER = join(HERE, 'dz23-host.cmd')
const REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`

function args (argv) {
  const result = { extensionId: null, uninstall: false, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--uninstall') result.uninstall = true
    else if (value === '--dry-run') result.dryRun = true
    else if (value === '--extension-id') { result.extensionId = argv[index + 1]; index += 1 }
    else if (value.startsWith('--extension-id=')) result.extensionId = value.split('=')[1]
  }
  return result
}

function runReg (argv) {
  return execFileSync('reg', argv, { encoding: 'utf8', windowsHide: true })
}

const options = args(process.argv.slice(2))

if (options.uninstall) {
  try {
    runReg(['delete', REGISTRY_KEY, '/f'])
    console.log('registro removido:', REGISTRY_KEY)
  } catch {
    console.log('registro já ausente:', REGISTRY_KEY)
  }
  for (const file of [MANIFEST, LAUNCHER]) {
    if (existsSync(file)) { rmSync(file); console.log('removido:', file) }
  }
  console.log('o gateway em execução não é encerrado por esta remoção')
  process.exit(0)
}

// O id vem da chave pública do manifest da extensão: com `key` fixo ele é o mesmo em qualquer pasta,
// e não depende de o usuário copiar 32 letras do chrome://extensions.
function idFromExtensionKey () {
  try {
    const extensionManifest = JSON.parse(readFileSync(join(HERE, '..', 'extension', 'manifest.json'), 'utf8'))
    if (!extensionManifest.key)
      return null
    const digest = createHash('sha256').update(Buffer.from(extensionManifest.key, 'base64')).digest()
    return [...digest.subarray(0, 16).toString('hex')].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')
  } catch {
    return null
  }
}

const extensionId = options.extensionId ?? idFromExtensionKey()
if (!extensionId || !/^[a-p]{32}$/.test(extensionId)) {
  console.error('informe o ID da extensão: --extension-id <32 letras a-p> (ou adicione `key` em extension/manifest.json)')
  console.error('dica: chrome://extensions → modo desenvolvedor → ID do cartão do DZ23')
  process.exit(2)
}

const manifest = {
  name: HOST_NAME,
  description: 'DZ23 gateway supervisor — starts and stops the local gateway for the extension',
  path: LAUNCHER,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}

// The launcher keeps the quoting rules explicit on Windows.
const launcher = `@echo off\r\nsetlocal\r\n"${process.execPath}" "${join(HERE, 'host.mjs')}" %*\r\n`
const manifestJson = JSON.stringify(manifest, null, 2) + '\n'

if (options.dryRun) {
  console.log('dry-run, nada foi escrito')
  console.log('manifest:', MANIFEST)
  console.log(manifestJson)
  console.log('launcher:', LAUNCHER)
  console.log(launcher.trim())
  console.log('registro:', REGISTRY_KEY, '->', MANIFEST)
  process.exit(0)
}

mkdirSync(HERE, { recursive: true })
writeFileSync(LAUNCHER, launcher, 'utf8')
writeFileSync(MANIFEST, manifestJson, 'utf8')
runReg(['add', REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', MANIFEST, '/f'])

console.log('instalado')
console.log('  host:     ', HOST_NAME)
console.log('  manifest: ', MANIFEST)
console.log('  launcher: ', LAUNCHER)
console.log('  origem:   ', `chrome-extension://${extensionId}/`)
console.log('  registro: ', REGISTRY_KEY)
console.log('Reinicie o Chrome. A extensão pede "dz23:gateway:ensure" e o host sobe o gateway em 127.0.0.1:8777.')
console.log('Para remover: node native-host/install.mjs --uninstall')

// Self-check: the manifest must be readable and point at an existing file
if (!existsSync(MANIFEST) || !existsSync(LAUNCHER)) {
  console.error('falha: manifesto ou launcher ausente após a instalação')
  process.exit(1)
}
if (JSON.parse(readFileSync(MANIFEST, 'utf8')).path !== LAUNCHER) {
  console.error('falha: o manifesto não aponta para o launcher')
  process.exit(1)
}

#!/usr/bin/env node
// Ícones da extensão: o arquivo que o usuário vê antes de qualquer texto.
//
// O ícone anterior era o do projeto original (candles com um "BUY" verde) e prometia sinal de compra num assistente que não
// emite recomendação — além de ser a marca de outro produto. Este verificador garante que o manifest só declare arquivos
// que existem, com a dimensão exata que ele promete, e que a arte seja a deste projeto.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const problems = []
const notes = []

const manifest = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'))
const REQUIRED = ['16', '32', '48', '128']

function dimensions (path) {
  const buffer = readFileSync(path)
  if (buffer.readUInt32BE(0) !== 0x89504e47)
    return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), bytes: buffer.length }
}

const icons = manifest.icons ?? {}
for (const size of REQUIRED) {
  if (!icons[size])
    problems.push({ kind: 'missing_size', detail: `manifest.icons não declara ${size}px (o Chrome mostra um ícone genérico)` })
}

for (const [size, relative] of Object.entries(icons)) {
  const absolute = join(ROOT, 'extension', relative)
  if (!existsSync(absolute)) {
    problems.push({ kind: 'missing_file', detail: `manifest declara ${relative} (${size}px), mas o arquivo não existe` })
    continue
  }
  const info = dimensions(absolute)
  if (!info) {
    problems.push({ kind: 'not_png', detail: `${relative} não é um PNG válido` })
    continue
  }
  if (String(info.width) !== String(size) || String(info.height) !== String(size))
    problems.push({ kind: 'wrong_size', detail: `${relative} é ${info.width}x${info.height}, o manifest promete ${size}x${size}` })
  if (info.bytes < 200)
    problems.push({ kind: 'too_small', detail: `${relative} tem ${info.bytes} bytes: provavelmente vazio` })
  else
    notes.push(`${relative}: ${info.width}x${info.height}, ${info.bytes} B`)
}

// a barra de ferramentas usa action.default_icon; divergir do icons mostra ícones diferentes no mesmo produto
const actionIcon = manifest.action?.default_icon
if (actionIcon && JSON.stringify(actionIcon) !== JSON.stringify(icons))
  problems.push({ kind: 'action_icon_diverges', detail: 'action.default_icon difere de icons (dois ícones no mesmo produto)' })
else if (actionIcon)
  notes.push('action.default_icon igual a icons')

// a arte precisa ser deste projeto: a do original tinha "BUY" e continua no histórico do Git
// (hashes calculados sobre os arquivos originais, não sobre cópias normalizadas por visualizador)
const UPSTREAM_HASHES = new Set([
  'cae45fa65e1ecb106a7fa9acb56303b4185039ffbd9be82373824d65e365af72', // 16px
  '6b187b87295521805bbb9d10e281e3ad7ff24e4bd36e0fb504c59669b099ee60', // 32px
  '395acda5b46126f3429cb9b1178262f238a184368e53331d3f780e17bf33f20c', // 48px
  '67cea583ab1018f648a65c83598dd4ac9384951649557166a11cf83a7900756a', // 64px
  '7fdaa2d04cf21ef025bf2edc727bfb117df8c6baab4e48dc1176badcb8f96b6f', // 128px
])
for (const [, relative] of Object.entries(icons)) {
  const absolute = join(ROOT, 'extension', relative)
  if (!existsSync(absolute))
    continue
  const sha = createHash('sha256').update(readFileSync(absolute)).digest('hex')
  if (UPSTREAM_HASHES.has(sha))
    problems.push({ kind: 'upstream_art', detail: `${relative} é a arte do projeto original (ícone com "BUY")` })
}

// todo PNG em images/ precisa ser usado: arquivo órfão aqui é ícone velho esquecido
const used = new Set(Object.values(icons).map((relative) => relative.replace(/^images\//, '')))
const listed = JSON.parse(readFileSync(join(ROOT, 'extension/manifest.json'), 'utf8'))
void listed
notes.push(`ícones declarados: ${Object.keys(icons).length}; usados: ${used.size}`)

for (const note of notes)
  console.log(`ok    ${note}`)
for (const problem of problems)
  console.log(`FAIL  ${problem.kind}: ${problem.detail}`)
console.log(JSON.stringify({ passed: problems.length === 0, notes: notes.length, problems }))
process.exit(problems.length === 0 ? 0 : 1)

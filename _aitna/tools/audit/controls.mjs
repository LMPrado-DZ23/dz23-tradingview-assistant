#!/usr/bin/env node
// §13: every control must do something. A button with no listener is a promise the product does not keep.
//
// For each page it extracts the interactive ids (button, select, input that is not text-like), ignores HTML comments, and
// requires a reference to that id in the page's own script or in any script of the extension (a listener may live in a
// shared module). It also reports ids that only exist inside comments — dead markup that reads like a feature.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const EXTENSION = join(ROOT, 'extension')

const PAGES = [
  'copilot/index.html',
  'popup/assistant.html',
  'settings/index.html',
  'research/index.html',
]

const stripComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '')

// Text-like inputs are usually read by name or by query, not by id — keep the check about things you click.
const isControl = (tag, attributes) => {
  if (tag === 'button')
    return true
  if (tag === 'select')
    return true
  if (tag === 'input') {
    const type = (attributes.match(/type="([^"]+)"/)?.[1] ?? 'text').toLowerCase()
    return ['button', 'submit', 'checkbox', 'radio', 'file'].includes(type)
  }
  return false
}

function controlsOf (html) {
  const found = []
  for (const match of html.matchAll(/<(button|select|input)\b([^>]*)>/g)) {
    const [, tag, attributes] = match
    const id = attributes.match(/id="([^"]+)"/)?.[1]
    if (id && isControl(tag, attributes))
      found.push(id)
  }
  return [...new Set(found)]
}

const allJs = []
for (const directory of ['', 'lib', 'copilot', 'popup', 'settings', 'research', 'content_scripts']) {
  const path = join(EXTENSION, directory)
  let entries = []
  try {
    entries = readdirSync(path)
  } catch {
    continue
  }
  for (const entry of entries) {
    const file = join(path, entry)
    if (statSync(file).isFile() && /\.(js|mjs)$/.test(entry))
      allJs.push(readFileSync(file, 'utf8'))
  }
}
const jsText = allJs.join('\n')

const problems = []
for (const page of PAGES) {
  let html = ''
  try {
    html = readFileSync(join(EXTENSION, page), 'utf8')
  } catch {
    problems.push({ page, kind: 'missing_page', detail: 'página declarada não existe' })
    continue
  }
  const live = controlsOf(stripComments(html))
  const commented = controlsOf(html).filter((id) => !live.includes(id))
  const withoutListener = live.filter((id) => !jsText.includes(`'${id}'`) && !jsText.includes(`"${id}"`) && !jsText.includes(`#${id}`))
  console.log(`${page.padEnd(22)} controles: ${String(live.length).padStart(2)} · sem referência: ${withoutListener.length ? withoutListener.join(', ') : 'nenhum'}${commented.length ? ` · só em comentário: ${commented.join(', ')}` : ''}`)
  if (withoutListener.length)
    problems.push({ page, kind: 'control_without_action', detail: withoutListener.join(', ') })
}

console.log(JSON.stringify({ passed: problems.length === 0, pages: PAGES.length, problems }))
process.exit(problems.length === 0 ? 0 : 1)

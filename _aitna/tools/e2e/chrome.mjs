// Onde está o Chrome para os testes que abrem navegador — resolvido, não fixado no caminho de uma máquina.
//
// Antes, cada ferramenta trazia `const CHROME = 'C:/Users/<usuário>/...'`: funcionava numa máquina e no CI falhava por
// caminho, não por defeito. Ordem de busca:
//   1. DZ23_CHROME (explícito — é o que o CI usa)
//   2. cache do puppeteer em _aitna/.browser (instalado por `npx puppeteer browsers install chrome`)
//   3. Chrome do sistema em caminhos conhecidos por plataforma
// Se nada for encontrado, o erro diz o que instalar — nunca "falhou sem motivo".
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CACHE = join(ROOT, '_aitna', '.browser')

function candidates () {
  const list = []
  if (process.env.DZ23_CHROME)
    list.push(process.env.DZ23_CHROME)

  if (existsSync(CACHE)) {
    for (const build of readdirSync(CACHE)) {
      if (!build.startsWith('chrome'))
        continue
      const dir = join(CACHE, build)
      for (const inner of readdirSync(dir)) {
        list.push(
          join(dir, inner, 'chrome'),
          join(dir, inner, 'chrome-linux64', 'chrome'),
          join(dir, inner, 'chrome-win64', 'chrome.exe'),
          join(dir, inner, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        )
      }
    }
  }

  if (process.platform === 'win32') {
    list.push(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    )
  } else if (process.platform === 'darwin') {
    list.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser')
  }
  return list
}

export function chromePath () {
  for (const path of candidates()) {
    if (path && existsSync(path))
      return path
  }
  throw new Error(
    'Chrome não encontrado. Instale com "npx puppeteer browsers install chrome" ' +
    '(cai em _aitna/.browser) ou aponte DZ23_CHROME para o executável.',
  )
}

// raiz do repositório, para as ferramentas não digitarem caminho de máquina
export const REPO_ROOT = ROOT
// pasta da extensão (o que a maioria das ferramentas serve ou inspeciona)
export const EXT_DIR = join(ROOT, 'extension')

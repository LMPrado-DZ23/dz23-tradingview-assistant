// Gateway client shared by the Pine CLIs: one place for auth, timeout and streaming parsing.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function readToken () {
  try {
    return readFileSync(join(homedir(), '.dz23', 'gateway-token'), 'utf8').trim()
  } catch {
    return null
  }
}

export function resolveAuth () {
  return process.env.DZ23_GATEWAY_TOKEN ?? readToken()
}

export function gatewayUrl () {
  return process.env.DZ23_GATEWAY_URL ?? 'http://127.0.0.1:8777'
}

// Sends one prompt and returns the full answer. Streaming events are concatenated; a non-streaming body is accepted too.
export async function askGateway ({ prompt, user = 'Responda.', provider = 'deepseek', timeoutMs = 120_000 } = {}) {
  const auth = resolveAuth()
  if (!auth)
    throw new Error('sem token do gateway: rode `npm run gateway:dev` ou defina DZ23_GATEWAY_TOKEN')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(new URL('/chat', gatewayUrl()), {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider, stream: true, messages: [{ role: 'system', content: prompt }, { role: 'user', content: user }] }),
      signal: controller.signal,
    })
    if (!response.ok)
      throw new Error(`gateway ${response.status}: ${(await response.text()).slice(0, 160)}`)
    const body = await response.text()
    if (!body.trim().startsWith('data:'))
      return body
    let answer = ''
    for (const line of body.split('\n')) {
      if (!line.startsWith('data: '))
        continue
      try {
        const event = JSON.parse(line.slice(6))
        if (event.type === 'delta' && event.text)
          answer += event.text
        else if (event.type === 'done' && event.text && !answer)
          answer = event.text
      } catch {
        /* fragmento ilegível: o texto final vem nos outros eventos */
      }
    }
    return answer
  } finally {
    clearTimeout(timer)
  }
}

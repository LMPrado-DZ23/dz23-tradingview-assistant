#!/usr/bin/env node
// TradingView MCP CLI.
//
//   npm run tv:mcp -- login            abre o navegador para autorizar (OAuth 2.1 + PKCE, cliente público)
//   npm run tv:mcp -- status          mostra o estado do token (nunca o token)
//   npm run tv:mcp -- tools           lista as ferramentas que o servidor realmente oferece
//   npm run tv:mcp -- call <tool> '{"json":"de argumentos"}'
//   npm run tv:mcp -- logout          apaga o token local
//
// The callback listens on 127.0.0.1 only. Tokens live in ~/.dz23/tradingview-mcp.json, outside the repository.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_SCOPE, buildAuthorizeUrl, createPkce, describeTokens, discoverEndpoints, exchangeCode,
  isExpired, randomState, refreshAccessToken, registerClient,
} from './tradingview-oauth.mjs'
import { AuthRequired, createMcpClient, summarizeInitialize } from './tradingview-client.mjs'

const STATE_DIR = join(homedir(), '.dz23')
const TOKEN_FILE = join(STATE_DIR, 'tradingview-mcp.json')
const CLIENT_FILE = join(STATE_DIR, 'tradingview-client.json')
const RESOURCE = 'https://mcp.tradingview.com/mcp'
const AS_METADATA_URL = 'https://www.tradingview.com/.well-known/oauth-authorization-server'
const PROBE_URL = 'https://mcp.tradingview.com/.well-known/oauth-protected-resource/mcp'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'status'

function readJson (path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

function writeJson (path, value) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  try {
    chmodSync(path, 0o600)
  } catch {
    /* Windows: o modo é consultivo */
  }
}

function openBrowser (url) {
  // Nunca por cmd/start: o "&" da query seria interpretado e a URL chegaria truncada (client_id ausente no OAuth).
  if (process.platform === 'win32') {
    spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
    return
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref()
}

async function discover () {
  const probe = await fetch(PROBE_URL, { headers: { accept: 'application/json' } }).then((response) => response.json()).catch(() => null)
  const metadata = await fetch(AS_METADATA_URL, { headers: { accept: 'application/json' } }).then((response) => response.json())
  const endpoints = discoverEndpoints(metadata)
  return { probe, endpoints }
}

async function login () {
  const { probe, endpoints } = await discover()
  console.log(`recurso: ${probe?.resource ?? RESOURCE}`)
  console.log(`autorização: ${endpoints.authorize}`)
  console.log(`escopos: ${DEFAULT_SCOPE}`)

  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const redirectUri = `http://127.0.0.1:${port}/callback`
  console.log(`callback local: ${redirectUri}`)

  const saved = readJson(CLIENT_FILE)
  const client = saved?.redirectUri === redirectUri && saved?.clientId
    ? { clientId: saved.clientId }
    : await registerClient({ registerEndpoint: endpoints.register, redirectUri })
  if (!saved || saved.clientId !== client.clientId)
    writeJson(CLIENT_FILE, { clientId: client.clientId, redirectUri, registeredAt: new Date().toISOString() })
  console.log(`cliente: ${client.clientId}`)

  const pkce = await createPkce()
  const state = randomState()
  const authorizeUrl = buildAuthorizeUrl({ endpoints, clientId: client.clientId, redirectUri, state, challenge: pkce.challenge })

  const result = await new Promise((resolve) => {
    const planHint = 'tempo esgotado (5 min) esperando a autorização. Se a página do TradingView mostrou "É necessário um plano pago", este é o limite do servidor oficial: o MCP da TradingView exige plano pago ativo. O DZ23 continua funcionando sem ele (contexto do gráfico, candles, métricas, Pine, Strategy Lab, agentes, alertas).'
    const timer = setTimeout(() => resolve({ ok: false, reason: planHint }), 5 * 60_000)
    server.on('request', async (request, response) => {
      const url = new URL(request.url, `http://127.0.0.1:${port}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('not found')
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      if (error) {
        const planBlocked = /plan|paid|subscription|upgrade/i.test(String(error))
        const reason = planBlocked
          ? 'o servidor exige plano pago ativo para o MCP oficial (recusado: ' + error + ')'
          : 'autorização recusada: ' + error
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(`<h1>Autorização recusada</h1><p>${error}</p>`)
        clearTimeout(timer)
        resolve({ ok: false, reason })
        return
      }
      if (returnedState !== state) {
        response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>state inválido</h1>')
        clearTimeout(timer)
        resolve({ ok: false, reason: 'state não confere (possível CSRF)' })
        return
      }
      try {
        const tokens = await exchangeCode({ tokenEndpoint: endpoints.token, clientId: client.clientId, code, verifier: pkce.verifier, redirectUri })
        writeJson(TOKEN_FILE, { ...tokens, clientId: client.clientId, tokenEndpoint: endpoints.token, resource: RESOURCE })
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>DZ23 autorizado</h1><p>Pode fechar esta aba e voltar ao terminal.</p>')
        clearTimeout(timer)
        resolve({ ok: true, tokens })
      } catch (exchangeError) {
        response.writeHead(500, { 'content-type': 'text/html; charset=utf-8' }).end(`<h1>Falha</h1><pre>${String(exchangeError.message)}</pre>`)
        clearTimeout(timer)
        resolve({ ok: false, reason: exchangeError.message })
      }
    })
    console.log('abrindo o navegador… autorize a aplicação; se nada abrir, visite:')
    console.log(authorizeUrl)
    writeJson(join(STATE_DIR, 'tradingview-authorize-url.json'), { url: authorizeUrl, createdAt: new Date().toISOString() })
    console.log(`URL salva em ${join(STATE_DIR, 'tradingview-authorize-url.json')} (copie o valor de "url" inteiro)`)
    openBrowser(authorizeUrl)
  })

  server.close()
  if (!result.ok) {
    console.error(`não autorizado: ${result.reason}`)
    process.exit(1)
  }
  console.log(`autorizado · ${describeTokens(result.tokens)}`)
}

async function loadTokens () {
  const stored = readJson(TOKEN_FILE)
  if (!stored?.accessToken)
    return null
  if (!isExpired(stored))
    return stored
  if (!stored.refreshToken)
    return null
  const refreshed = await refreshAccessToken({ tokenEndpoint: stored.tokenEndpoint, clientId: stored.clientId, refreshToken: stored.refreshToken })
  writeJson(TOKEN_FILE, { ...stored, ...refreshed })
  return { ...stored, ...refreshed }
}

async function withClient (run) {
  const tokens = await loadTokens()
  if (!tokens) {
    console.error('sem token válido: rode `npm run tv:mcp -- login`')
    process.exit(2)
  }
  const client = createMcpClient({ getToken: () => tokens.accessToken })
  try {
    return await run(client, tokens)
  } catch (error) {
    if (error instanceof AuthRequired) {
      console.error(`token recusado (${error.resourceMetadata ?? 'sem resource_metadata'}): rode \`npm run tv:mcp -- login\` de novo`)
      process.exit(3)
    }
    throw error
  }
}

if (command === 'login') {
  await login()
} else if (command === 'logout') {
  if (existsSync(TOKEN_FILE))
    unlinkSync(TOKEN_FILE)
  console.log('token local removido (a autorização na TradingView pode ser revogada na conta)')
} else if (command === 'status') {
  const stored = readJson(TOKEN_FILE)
  console.log(`arquivo: ${TOKEN_FILE}`)
  console.log(stored ? `${describeTokens(stored)} · cliente ${stored.clientId}` : 'sem token (rode login)')
} else if (command === 'tools') {
  await withClient(async (client) => {
    const init = await client.initialize()
    console.log(summarizeInitialize(init))
    const tools = await client.listTools()
    const list = tools?.tools ?? []
    console.log(`${list.length} ferramenta(s):`)
    for (const tool of list)
      console.log(`- ${tool.name}${tool.description ? `: ${tool.description.slice(0, 100)}` : ''}`)
  })
} else if (command === 'call') {
  const tool = argv[1]
  const args = argv[2] ? JSON.parse(argv[2]) : {}
  if (!tool) {
    console.error('uso: npm run tv:mcp -- call <tool> \'{"arg":1}\'')
    process.exit(2)
  }
  await withClient(async (client) => {
    await client.initialize()
    const result = await client.callTool(tool, args)
    console.log(JSON.stringify(result, null, 2))
  })
} else {
  console.error('comandos: login | logout | status | tools | call')
  process.exit(2)
}

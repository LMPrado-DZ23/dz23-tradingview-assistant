// TradingView official MCP — OAuth 2.1 (public client, PKCE S256) and token storage.
//
// Everything here was discovered from the server, not assumed:
//   POST https://mcp.tradingview.com/mcp            -> 401 + WWW-Authenticate: Bearer resource_metadata="..."
//   GET  /.well-known/oauth-protected-resource/mcp  -> resource + authorization_servers
//   GET  https://www.tradingview.com/.well-known/oauth-authorization-server
//        -> authorize/token/register/revoke endpoints, S256, scopes mcp:read and mcp:tools, "none" auth method
//
// The client registers itself dynamically, keeps tokens outside the repository (~/.dz23), and never logs them.

export const DEFAULT_RESOURCE = 'https://mcp.tradingview.com/mcp'
export const DEFAULT_AUTHORIZATION_SERVER = 'https://www.tradingview.com'
export const DEFAULT_SCOPE = 'mcp:read mcp:tools'

export function discoverEndpoints (metadata) {
  if (!metadata || typeof metadata !== 'object')
    throw new Error('metadados OAuth ausentes')
  const required = ['authorization_endpoint', 'token_endpoint']
  for (const key of required) {
    if (typeof metadata[key] !== 'string' || !/^https:\/\//.test(metadata[key]))
      throw new Error(`metadados sem ${key} válido`)
  }
  return {
    issuer: metadata.issuer ?? null,
    authorize: metadata.authorization_endpoint,
    token: metadata.token_endpoint,
    register: metadata.registration_endpoint ?? null,
    revocation: metadata.revocation_endpoint ?? null,
    scopes: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [],
    pkceMethods: Array.isArray(metadata.code_challenge_methods_supported) ? metadata.code_challenge_methods_supported : [],
  }
}

// PKCE with S256: the verifier never leaves this process; only the challenge goes in the URL.
export async function createPkce (subtle = globalThis.crypto?.subtle) {
  if (!subtle)
    throw new Error('WebCrypto indisponível para PKCE')
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const verifier = base64url(bytes)
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64url(new Uint8Array(digest)), method: 'S256' }
}

function base64url (bytes) {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomState () {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return base64url(bytes)
}

export function buildAuthorizeUrl ({ endpoints, clientId, redirectUri, state, challenge, scope = DEFAULT_SCOPE, resource = DEFAULT_RESOURCE }) {
  if (!endpoints?.authorize)
    throw new Error('endpoint de autorização ausente')
  if (!clientId || !redirectUri || !state || !challenge)
    throw new Error('autorização precisa de client_id, redirect_uri, state e code_challenge')
  const url = new URL(endpoints.authorize)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challenge)
  url.searchParams.set('code_challenge_method', 'S256')
  url.searchParams.set('scope', scope)
  if (resource)
    url.searchParams.set('resource', resource)
  return url.toString()
}

export async function registerClient ({ registerEndpoint, redirectUri, clientName = 'DZ23 TradingView Assistant', fetchImpl = globalThis.fetch, scope = DEFAULT_SCOPE }) {
  if (!registerEndpoint)
    throw new Error('servidor não oferece registro dinâmico de cliente')
  const response = await fetchImpl(registerEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(`registro dinâmico falhou (${response.status}): ${body?.error_description ?? body?.error ?? 'sem detalhe'}`)
  if (!body.client_id)
    throw new Error('registro dinâmico não devolveu client_id')
  return { clientId: body.client_id, clientSecret: body.client_secret ?? null, raw: body }
}

export async function exchangeCode ({ tokenEndpoint, clientId, code, verifier, redirectUri, resource = DEFAULT_RESOURCE, fetchImpl = globalThis.fetch }) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  if (resource)
    form.set('resource', resource)
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(`troca de código falhou (${response.status}): ${body?.error_description ?? body?.error ?? 'sem detalhe'}`)
  if (!body.access_token)
    throw new Error('resposta do token sem access_token')
  return normalizeTokens(body)
}

export async function refreshAccessToken ({ tokenEndpoint, clientId, refreshToken, fetchImpl = globalThis.fetch }) {
  if (!refreshToken)
    throw new Error('sem refresh_token para renovar')
  const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId })
  const response = await fetchImpl(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok)
    throw new Error(`renovação falhou (${response.status}): ${body?.error_description ?? body?.error ?? 'sem detalhe'}`)
  return normalizeTokens(body)
}

function normalizeTokens (body) {
  const expiresIn = Number(body.expires_in)
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    tokenType: body.token_type ?? 'Bearer',
    scope: body.scope ?? null,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
    obtainedAt: new Date().toISOString(),
  }
}

// A token that expires in less than a minute is treated as expired, so a call never starts doomed.
export function isExpired (tokens, skewMs = 60_000, now = () => Date.now()) {
  if (!tokens?.accessToken)
    return true
  if (!tokens.expiresAt)
    return false
  return tokens.expiresAt - skewMs <= now()
}

export function describeTokens (tokens) {
  if (!tokens?.accessToken)
    return 'sem token'
  const left = tokens.expiresAt ? Math.round((tokens.expiresAt - Date.now()) / 1000) : null
  return `token presente${tokens.scope ? ` · escopos ${tokens.scope}` : ''}${left !== null ? ` · expira em ${Math.max(left, 0)}s` : ''}${tokens.refreshToken ? ' · com refresh' : ''}`
}

// Exposed for the contract tests: the same normalization used by exchange/refresh.
export const normalizeTokensForTest = (body) => normalizeTokens(body)

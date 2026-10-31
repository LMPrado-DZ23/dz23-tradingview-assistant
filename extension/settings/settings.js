// DZ23 — the single settings screen. Reads and writes the one record (`dz23.config.v1`) through the shared bridge,
// talks to the gateway for status/diagnosis, and never stores a provider key: keys belong to the gateway process.
const $ = (id) => document.getElementById(id)
function el (tag, className = '', text = '') {
  const node = document.createElement(tag)
  if (className)
    node.className = className
  node.textContent = text
  return node
}
const bridge = window.dz23ConfigBridge
let config = null

const state = {
  label: (text, kind = '') => {
    const target = $('gatewayStatus')
    target.textContent = text
    target.className = `status ${kind}`
  },
}

async function loadConfig () {
  config = await bridge.load()
  $('gatewayUrl').value = config.gateway.url
  $('gatewayToken').value = config.gateway.token
  $('user').value = config.user === 'local' ? '' : config.user
  const options = config.popup?.options ?? {}
  const keys = Object.keys(options)
  $('popupOptions').textContent = keys.length ? `${keys.length} opção(ões) salva(s)` : 'padrão'
  $('diagVersion').textContent = `v${config.version}`
  $('diagMigration').textContent = config.meta?.migratedFrom?.length ? config.meta.migratedFrom.join(', ') : 'nada a migrar'
  $('diagToken').textContent = config.gateway.token ? 'pareado (guardado em chrome.storage.local)' : 'sem token'
  $('diagGateway').textContent = config.gateway.token ? 'pronto para autenticar' : 'health anônimo apenas'
  await refreshProviders()
}

async function gatewayFetch (path, options = {}) {
  const base = $('gatewayUrl').value.trim() || config.gateway.url
  const token = $('gatewayToken').value.trim() || config.gateway.token
  const headers = { ...(options.headers ?? {}) }
  if (token)
    headers.authorization = `Bearer ${token}`
  const response = await fetch(new URL(path, base), { ...options, headers })
  return response
}

async function refreshProviders () {
  const box = $('providers')
  try {
    const response = await gatewayFetch('/providers')
    if (response.status === 401) {
      box.innerHTML = '<span class="status bad">token recusado pelo gateway — salve o token correto</span>'
      $('globalState').textContent = 'gateway on-line · sem autenticação'
      return
    }
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`)
    const { providers = [] } = await response.json()
    box.innerHTML = ''
    for (const provider of providers) {
      const row = document.createElement('div')
      row.className = 'provider'
      const name = document.createElement('span')
      name.className = 'name'
      name.textContent = provider.label ?? provider.id
      const flag = document.createElement('span')
      flag.className = `flag ${provider.configured ? 'ok' : 'bad'}`
      flag.textContent = provider.configured ? 'configurado' : 'sem chave'
      const test = document.createElement('button')
      test.type = 'button'
      test.textContent = 'testar'
      test.addEventListener('click', async () => {
        test.disabled = true
        test.textContent = 'testando…'
        try {
          const result = await (await gatewayFetch('/diagnose', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: provider.id }),
          })).json()
          flag.className = `flag ${result.ok ? 'ok' : 'bad'}`
          flag.textContent = result.ok ? 'ok (auth, streaming, cancel)' : (result.checks?.find((check) => !check.ok)?.detail ?? 'falhou').slice(0, 40)
        } catch (error) {
          flag.className = 'flag bad'
          flag.textContent = String(error.message).slice(0, 40)
        } finally {
          test.disabled = false
          test.textContent = 'testar'
        }
      })
      const diagnose = document.createElement('button')
      diagnose.type = 'button'
      diagnose.textContent = 'diagnóstico'
      diagnose.addEventListener('click', () => {
        flag.className = 'flag'
        flag.textContent = 'veja o console do gateway'
        gatewayFetch('/diagnose', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider: provider.id }) })
          .then((response) => response.json())
          .then((result) => { console.log('[dz23] diag', provider.id, result) })
          .catch(() => {})
      })
      row.append(name, flag, test, diagnose)
      box.appendChild(row)
    }
    const configured = providers.filter((provider) => provider.configured)
    $('globalState').textContent = `gateway on-line · ${configured.length} provedor(es)`
    const providerSelect = $('providerSelect')
    providerSelect.innerHTML = ''
    for (const provider of (configured.length ? configured : providers)) {
      const option = document.createElement('option')
      option.value = provider.id
      option.textContent = provider.label ?? provider.id
      providerSelect.appendChild(option)
    }
    providerSelect.value = config.ai.provider || configured[0]?.id || ''
    renderModels(providers)
  } catch (error) {
    box.innerHTML = `<span class="status bad">gateway indisponível — ${String(error.message).slice(0, 60)}</span>`
    $('globalState').textContent = 'gateway off-line'
  }
}

function renderModels (providers) {
  const providerSelect = $('providerSelect')
  const modelSelect = $('modelSelect')
  const provider = providers.find((item) => item.id === providerSelect.value)
  const models = config.ai.modelsByProvider?.[providerSelect.value] ?? provider?.models ?? []
  modelSelect.innerHTML = ''
  for (const model of models) {
    const option = document.createElement('option')
    option.value = model
    option.textContent = model
    modelSelect.appendChild(option)
  }
  if (!models.length) {
    const option = document.createElement('option')
    option.value = ''
    option.textContent = 'sem modelos listados'
    modelSelect.appendChild(option)
  }
  modelSelect.value = config.ai.model && models.includes(config.ai.model) ? config.ai.model : (models[0] ?? '')
}

async function save () {
  const provider = $('providerSelect').value
  const model = $('modelSelect').value
  config = await bridge.save({
    gateway: { url: $('gatewayUrl').value.trim() || config.gateway.url, token: $('gatewayToken').value.trim() },
    ai: {
      provider,
      model,
      modelsByProvider: { ...config.ai.modelsByProvider, ...(provider && model ? { [provider]: [model] } : {}) },
    },
    user: $('user').value.trim() || 'local',
  })
  state.label('salvo no registro compartilhado', 'ok')
  $('diagToken').textContent = config.gateway.token ? 'pareado (guardado em chrome.storage.local)' : 'sem token'
  await refreshProviders()
}

$('save').addEventListener('click', () => { save().catch((error) => state.label(`falhou: ${error.message}`, 'bad')) })

$('test').addEventListener('click', async () => {
  state.label('testando…')
  try {
    const health = await (await gatewayFetch('/health')).json()
    if (health.status !== 'ok')
      throw new Error('health inesperado')
    const token = $('gatewayToken').value.trim()
    if (!token) {
      state.label('gateway ok · falta o token', 'bad')
      return
    }
    const providers = await (await gatewayFetch('/providers')).json()
    const configured = providers.providers.filter((provider) => provider.configured)
    state.label(`gateway ok · ${configured.length} provedor(es): ${configured.map((provider) => provider.id).join(', ') || 'nenhum'}`, 'ok')
  } catch (error) {
    state.label(`falhou: ${String(error.message).slice(0, 70)}`, 'bad')
  }
})

$('openNative').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'dz23:gateway:ensure' }, (reply) => {
    if (chrome.runtime.lastError || !reply?.ok) {
      state.label(`host nativo indisponível: ${reply?.reason ?? chrome.runtime.lastError?.message ?? 'sem resposta'}`, 'bad')
      return
    }
    state.label('gateway iniciado pelo host nativo', 'ok')
    refreshProviders()
  })
})

// §3.2: a memória aparece na tela única. Só leitura + limpar (destrutivo pede confirmação).
const MEMORY_PREFIX = 'dz23.memory.v'

function memoryEntries () {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(null, (items) => {
        const entries = Object.entries(items ?? {})
          .filter(([key]) => key.startsWith(MEMORY_PREFIX))
          .map(([key, value]) => {
            const [, user = '', strategy = ''] = key.split(':')
            const notes = Array.isArray(value?.notes) ? value.notes : []
            return { key, user, strategy, notes }
          })
        resolve(entries)
      })
    } catch {
      resolve([])
    }
  })
}

async function renderMemory () {
  const board = $('memoryBoard')
  const status = $('memoryStatus')
  if (!board)
    return
  board.innerHTML = ''
  const entries = await memoryEntries()
  if (!entries.length) {
    board.appendChild(el('p', 'hint', 'nenhuma nota registrada ainda'))
    status.textContent = '0 namespace(s)'
    return
  }
  for (const entry of entries) {
    const row = el('p', 'board-row', `${entry.user || 'padrão'} · ${entry.strategy || 'sem estratégia'} · ${entry.notes.length} nota(s)`)
    const clear = el('button', '', 'Limpar')
    clear.type = 'button'
    clear.addEventListener('click', () => {
      if (!window.confirm(`Apagar ${entry.notes.length} nota(s) de ${entry.user}/${entry.strategy}?`))
        return
      chrome.storage.local.remove(entry.key, async () => {
        status.textContent = 'memória apagada'
        await renderMemory()
      })
    })
    row.appendChild(document.createTextNode(' '))
    row.appendChild(clear)
    board.appendChild(row)
  }
  status.textContent = `${entries.length} namespace(s)`
}

// Uso real do gateway: latência e falhas por provedor. Sem chamada, a tabela diz isso em vez de mostrar zeros.
async function renderUsage () {
  const box = $('usageTable')
  if (!box)
    return
  box.innerHTML = ''
  let usage
  try {
    usage = await (await gatewayFetch('/usage')).json()
  } catch (error) {
    box.appendChild(el('p', 'hint', `sem leitura de uso: ${String(error?.message ?? error).slice(0, 60)}`))
    return
  }
  const providers = Object.entries(usage?.providers ?? {})
  if (!providers.length) {
    box.appendChild(el('p', 'hint', 'nenhuma chamada registrada desde que o gateway subiu'))
    return
  }
  const table = document.createElement('table')
  table.className = 'usage'
  const head = document.createElement('tr')
  for (const label of ['provedor', 'chamadas', 'falhas', 'latência média', 'tokens'])
    head.appendChild(el('th', '', label))
  table.appendChild(head)
  for (const [id, row] of providers) {
    const tr = document.createElement('tr')
    tr.appendChild(el('td', '', id))
    tr.appendChild(el('td', '', String(row.attempts ?? 0)))
    tr.appendChild(el('td', row.failed ? 'bad' : '', String(row.failed ?? 0)))
    tr.appendChild(el('td', '', row.averageMs === null || row.averageMs === undefined ? '—' : `${row.averageMs} ms`))
    tr.appendChild(el('td', '', String((row.inputTokens ?? 0) + (row.outputTokens ?? 0))))
    table.appendChild(tr)
  }
  box.appendChild(table)
  if (usage?.last?.at)
    box.appendChild(el('p', 'hint', `última chamada: ${usage.last.provider} · ${usage.last.ok ? 'ok' : usage.last.code} · janela ${usage.window}/${usage.limit}`))
}

$('diagnose').addEventListener('click', async () => {
  $('diagStatus').textContent = 'rodando…'
  try {
    const health = await (await gatewayFetch('/health')).json()
    $('diagStatus').textContent = `health ok · protocol ${health.protocol} · ${health.configured} configurado(s) de ${health.providers}`
    $('diagStatus').className = 'status ok'
    void renderUsage()
  } catch (error) {
    $('diagStatus').textContent = `health falhou: ${String(error.message).slice(0, 60)}`
    $('diagStatus').className = 'status bad'
  }
})

$('refreshMemory')?.addEventListener('click', () => { void renderMemory() })

$('providerSelect').addEventListener('change', async () => {
  const response = await gatewayFetch('/providers').catch(() => null)
  if (response?.ok)
    renderModels((await response.json()).providers ?? [])
})

loadConfig()
  .then(() => {
    void renderMemory()
    const token = $('gatewayToken')?.value?.trim?.() ?? ''
    if (token)
      void renderUsage()
  })
  .catch((error) => {
    $('globalState').textContent = `falha ao carregar: ${String(error.message).slice(0, 60)}`
  })

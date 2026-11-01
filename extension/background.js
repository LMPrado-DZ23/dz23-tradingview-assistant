// What Remix does that we lacked: after the extension is reloaded, tabs opened before keep running no content
// script, so the panel shows "Sem gráfico ativo" until the page is refreshed. This worker probes the tab and
// re-injects the bridge when nobody answers.
const BRIDGE = 'content_scripts/chartBridge.js'

function ping (tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'dz23:chart:ping' }, (reply) => {
      if (chrome.runtime.lastError)
        return resolve(null)
      resolve(reply ?? null)
    })
  })
}

async function ensure (tabId) {
  if (!Number.isInteger(tabId))
    return { ok: false, reason: 'no tab' }
  if (await ping(tabId))
    return { ok: true, injected: false }
  const injected = await new Promise((resolve) => {
    chrome.scripting.executeScript({ target: { tabId }, files: [BRIDGE] }, (results) => {
      resolve(chrome.runtime.lastError ? null : (results ?? []))
    })
  })
  const reply = injected ? await ping(tabId) : null
  return { ok: Boolean(reply), injected: Boolean(injected) }
}

const NATIVE_HOST = 'com.dz23.gateway'

// Talks to the native host (native-host/host.mjs). A missing host is a normal state, not an exception.
function callNativeHost (type, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    let port
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST)
    } catch (error) {
      return resolve({ ok: false, reason: 'host nativo não instalado', detail: String(error?.message ?? error) })
    }
    let settled = false
    const finish = (value) => {
      if (settled)
        return
      settled = true
      try { port.disconnect() } catch { /* already gone */ }
      resolve(value)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'tempo esgotado falando com o host nativo' }), timeoutMs)
    port.onMessage.addListener((message) => {
      clearTimeout(timer)
      finish({ ok: Boolean(message?.ok ?? message?.running), ...message })
    })
    port.onDisconnect.addListener(() => {
      clearTimeout(timer)
      const error = chrome.runtime.lastError?.message
      finish({ ok: false, reason: error ?? 'host nativo desconectou' })
    })
    try {
      port.postMessage({ id: 'extension', type })
    } catch (error) {
      clearTimeout(timer)
      finish({ ok: false, reason: String(error?.message ?? error) })
    }
  })
}

// Only TradingView chart URLs are accepted: the worker never navigates a tab anywhere else.
function isChartUrl (url) {
  try {
    const parsed = new URL(String(url))
    return parsed.protocol === 'https:' && /(^|\.)tradingview\.com$/.test(parsed.hostname) && parsed.pathname.startsWith('/chart/')
  } catch {
    return false
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === 'dz23:chart:apply') {
    if (!isChartUrl(message.url))
      return respond({ ok: false, reason: 'url recusada: só gráficos do tradingview.com' })
    chrome.tabs.update(message.tabId, { url: message.url }, (tab) => {
      if (chrome.runtime.lastError)
        return respond({ ok: false, reason: chrome.runtime.lastError.message })
      respond({ ok: true, url: tab?.url ?? message.url })
    })
    return true
  }
  // O diálogo legado avisa "sem estratégia no gráfico". Em vez de só explicar o beco sem saída, ele oferece o
  // laboratório local do DZ23, que testa sobre os candles e não depende do painel do TradingView.
  if (message?.type === 'dz23:research:open') {
    chrome.tabs.create({ url: chrome.runtime.getURL('research/index.html') }, (tab) => {
      if (chrome.runtime.lastError)
        return respond({ ok: false, reason: chrome.runtime.lastError.message })
      respond({ ok: true, tabId: tab?.id ?? null })
    })
    return true
  }
  if (message?.type === 'dz23:gateway:token') {
  callNativeHost('token')
  return true
}
if (message?.type === 'dz23:gateway:ensure' || message?.type === 'dz23:gateway:status') {
    callNativeHost(message.type === 'dz23:gateway:ensure' ? 'start' : 'status')
      .then(respond)
      .catch((error) => respond({ ok: false, reason: String(error?.message ?? error) }))
    return true
  }
  if (message?.type !== 'dz23:chart:ensure')
    return false
  ensure(message.tabId)
    .then(respond)
    .catch((error) => respond({ ok: false, reason: String(error?.message ?? error) }))
  return true
})

// The side panel is opened from the popup button today; opening it on the icon click is a product decision, so the
// behaviour is wired but off unless the owner removes the popup from the manifest.
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false })
  } catch {
    /* no side panel support in this Chrome */
  }
})

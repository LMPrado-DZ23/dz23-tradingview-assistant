// DZ23 — chart bridge: tells the copilot which chart this tab is showing.
//
// The selectors follow what the chart actually renders on tradingview.com (verified against the shipped TradingView
// Remix extension, which reads the same nodes): `[data-name="legend-source-item"]` holds the symbol,
// `[data-name="timeframes-menu"]` holds the interval, and every legend item after the first is an indicator.
// `/chart/<symbol>/` in the URL is the fallback while the legend is not painted. Visible DOM only, no private API.
//
// Protocol (chrome.runtime messages):
//   content -> extension: { type: 'dz23:chart', observation }
//   extension -> content: { type: 'dz23:chart:ping' }  answers with the same observation shape
(() => {
  const TARGET = 'dz23:chart'
  const SETTLE_MS = 350

  // Most specific first. The inner class name is hashed per chart build, so it is matched by prefix.
  const SYMBOL_SELECTORS = [
    '[data-name="legend-source-item"] [class*="titleLegendContainer"]',
    '.chart-markup-table .symbol-info',
    '[data-name="legend-source-item"] [class*="symbol"]',
    '[data-name="legend-source-item"]',
  ]
  const TIMEFRAME_SELECTORS = [
    '[data-name="timeframes-menu"] [class*="text"]',
    '[data-name="timeframes-menu"]',
    '[data-name="legend-interval"]',
    '[data-name="header-toolbar-intervals"] [aria-label]',
  ]
  const INDICATOR_SELECTORS = [
    '[data-name="legend-source-item"]:not(:first-child) [class*="titleLegendContainer"]',
    '[data-name="legend-source-item"]:not(:first-child)',
  ]
  const SYMBOL_PATTERN = /^[A-Z][A-Z0-9._-]{1,20}(:[A-Z][A-Z0-9._-]{1,20})?$/
  const NUMBER_AT_END = /^([A-Za-z][A-Za-z ()+_-]{0,30}?)\s*:?\s*(-?\d{1,3}(?:\.\d+)?)$/

  function textOf (selector) {
    try {
      const element = document.querySelector(selector)
      const text = element?.getAttribute?.('data-symbol') || element?.textContent || ''
      return text.trim().split('\n')[0].trim()
    } catch {
      return ''
    }
  }

  // "15m" -> 15, "1h" -> 60, "4h" -> 240, "1D" -> D. Unknown text returns null instead of guessing.
  function toResolution (text) {
    const raw = String(text ?? '').trim().toUpperCase()
    if (!raw)
      return null
    if (/^(D|W|M)$/.test(raw))
      return raw
    if (/^1(D|W|M)$/.test(raw))
      return raw.slice(1)
    const compact = raw.match(/^(\d{1,3})(M|H|D|W)?$/)
    if (!compact)
      return null
    const amount = Number(compact[1])
    const unit = compact[2]
    if (!unit)
      return String(amount)
    return unit === 'H' ? String(amount * 60) : String(amount)
  }

  // The URL carries the symbol before the legend paints: /chart/BTCUSDT/ or /chart/BINANCE:BTCUSDT/
  function fromUrl () {
    try {
      const match = window.location.pathname.match(/\/chart\/([^/?#]+)/)
      if (!match)
        return null
      const candidate = decodeURIComponent(match[1]).replace(/_/g, '').toUpperCase()
      return SYMBOL_PATTERN.test(candidate) ? candidate : null
    } catch {
      return null
    }
  }

  // "BTCUSDT 1h" / "BTCUSDT" / "BINANCE:BTCUSDT" — the first token that looks like a symbol
  function firstSymbolToken (text) {
    for (const token of String(text ?? '').toUpperCase().split(/[\s|·]+/)) {
      const clean = token.replace(/[(),]/g, '')
      if (SYMBOL_PATTERN.test(clean))
        return clean
    }
    return null
  }

  function fromTitle () {
    const title = document.title || ''
    const match = title.match(/([A-Z][A-Z0-9._-]{1,20}(?::[A-Z][A-Z0-9._-]{1,20})?)\s+([0-9]{1,3}[mhdDWM]?)\b/)
    return match ? { rawSymbol: match[1], resolution: match[2] } : {}
  }

  function readResolution () {
    for (const selector of TIMEFRAME_SELECTORS) {
      const resolution = toResolution(textOf(selector))
      if (resolution)
        return resolution
    }
    return null
  }

  function readSymbol () {
    for (const selector of SYMBOL_SELECTORS) {
      const symbol = firstSymbolToken(textOf(selector))
      if (symbol)
        return symbol
    }
    return fromUrl()
  }

  // Only what the legend shows as text, and only items after the first (the first is the symbol row)
  function readIndicators () {
    try {
      const found = []
      for (const selector of INDICATOR_SELECTORS) {
        for (const element of document.querySelectorAll(selector)) {
          if (found.length >= 10)
            break
          const text = (element.textContent || '').replace(/\s+/g, ' ').trim()
          const match = text.match(NUMBER_AT_END)
          if (match)
            found.push({ name: match[1].trim(), value: Number(match[2]) })
        }
        if (found.length)
          break
      }
      return found.slice(0, 10)
    } catch {
      return []
    }
  }

  function observe () {
    try {
      const fallback = fromTitle()
      const rawSymbol = readSymbol() ?? fallback.rawSymbol ?? null
      const resolution = readResolution() ?? toResolution(fallback.resolution) ?? null
      return {
        rawSymbol,
        resolution,
        source: rawSymbol ? 'page' : 'none',
        indicators: readIndicators(),
        url: location.href,
        at: new Date().toISOString(),
      }
    } catch (error) {
      return { rawSymbol: null, resolution: null, source: 'none', indicators: [], url: location?.href ?? null, at: new Date().toISOString(), error: String(error?.message ?? error) }
    }
  }

  function send (observation) {
    try {
      chrome.runtime.sendMessage({ type: TARGET, observation }, () => void chrome.runtime.lastError)
    } catch {
      /* the extension was reloaded: the next ping reconnects */
    }
  }

  let timer = null
  let lastKey = ''
  function schedule () {
    if (timer)
      return
    timer = setTimeout(() => {
      timer = null
      const observation = observe()
      // The key includes the indicators: adding RSI must refresh the context, not only changing the symbol
      const key = `${observation.rawSymbol}|${observation.resolution}|${JSON.stringify(observation.indicators)}`
      if (key === lastKey)
        return
      lastKey = key
      send(observation)
    }, SETTLE_MS)
  }

  try {
    const observer = new MutationObserver(schedule)
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-symbol', 'aria-label'] })
    document.addEventListener('visibilitychange', schedule)
  } catch {
    /* no observer in this page: the ping still answers */
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, respond) => {
      if (message?.type === `${TARGET}:ping`) {
        respond({ ok: true, observation: observe() })
        return true
      }
      return false
    })
  } catch {
    /* not running as a content script */
  }

  // First report as soon as the chart settles, then rely on mutations
  schedule()
})()

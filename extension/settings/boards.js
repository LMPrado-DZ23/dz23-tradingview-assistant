// Watchlists and alerts UI. Everything here writes to the shared record through the bridge; the market readings come
// from the same public candles module the panel uses, and a symbol without data is shown as such — never scored.
import { addSymbol, canAddList, compareLists, createList, describeRanking, rankOpportunities, removeSymbol } from '../lib/watchlist.js'
import { createAlert, editAlert, evaluateAlerts, pauseAlert, removeAlert, resumeAlert, summarizeAlerts } from '../lib/alerts.js'
import { fetchCandles } from '../lib/candles.js'
import { summarizeMarket } from '../lib/marketIntel.js'

const $ = (id) => document.getElementById(id)
const bridge = window.dz23ConfigBridge
let config = null
let lastRanking = null
let lastEvaluation = null

const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className)
    node.className = className
  if (text !== undefined)
    node.textContent = text
  return node
}

async function load () {
  config = await bridge.load()
  renderWatchlists()
  renderAlerts()
}

async function persist (patch, statusNode, okText) {
  config = await bridge.save(patch)
  if (statusNode) {
    statusNode.textContent = okText
    statusNode.className = 'status ok'
  }
  return config
}

/* ------------------------------------------------------------------ market */

// One reading per symbol: last close, previous close and the computed RSI. Failures are returned, not thrown.
async function readSymbols (symbols) {
  const readings = {}
  const failures = []
  for (const symbol of symbols) {
    try {
      const result = await fetchCandles({ context: { symbol, exchange: 'BINANCE', timeframe: '1h', resolution: '60' } })
      if (!result.ok) {
        failures.push({ symbol, reason: result.reason })
        continue
      }
      const candles = result.candles
      const last = candles.at(-1)
      const previous = candles.at(-2)
      const intel = summarizeMarket({ candles, context: { timeframe: '1h' }, source: result.source })
      readings[symbol] = {
        price: last.close,
        rsi: intel.rsi,
        changePct: previous && previous.close ? ((last.close - previous.close) / previous.close) * 100 : null,
        intel,
        source: result.source,
      }
    } catch (error) {
      failures.push({ symbol, reason: String(error?.message ?? error) })
    }
  }
  return { readings, failures }
}

/* --------------------------------------------------------------- watchlists */

function renderWatchlists () {
  const box = $('watchlistCards')
  if (!box)
    return
  box.innerHTML = ''
  const lists = config.watchlists?.lists ?? []
  if (!lists.length) {
    box.appendChild(el('p', 'hint', 'Nenhuma lista ainda. Crie uma abaixo com os símbolos separados por vírgula.'))
  }
  for (const list of lists) {
    const card = el('div', 'board-card')
    const head = el('div', 'board-head')
    head.appendChild(el('strong', '', list.name))
    head.appendChild(el('span', 'pill', `${list.symbols.length} símbolo(s)`))
    const remove = el('button', 'board-danger', 'excluir lista')
    remove.type = 'button'
    remove.addEventListener('click', async () => {
      const next = lists.filter((item) => item.id !== list.id)
      await persist({ watchlists: { lists: next } }, $('watchlistStatus'), 'lista removida')
      renderWatchlists()
    })
    head.appendChild(remove)
    card.appendChild(head)

    const chips = el('div', 'board-chips')
    for (const symbol of list.symbols) {
      const chip = el('span', 'chip-symbol', symbol)
      const drop = el('button', 'chip-drop', '×')
      drop.type = 'button'
      drop.title = `remover ${symbol}`
      drop.addEventListener('click', async () => {
        const result = removeSymbol(lists, list.id, symbol)
        if (!result.ok) {
          $('watchlistStatus').textContent = result.reason
          $('watchlistStatus').className = 'status bad'
          return
        }
        await persist({ watchlists: { lists: result.lists } }, $('watchlistStatus'), `${symbol} removido`)
        renderWatchlists()
      })
      chip.appendChild(drop)
      chips.appendChild(chip)
    }
    card.appendChild(chips)

    const addRow = el('div', 'row')
    const input = el('input')
    input.placeholder = 'adicionar símbolo'
    input.autocomplete = 'off'
    const add = el('button', '', 'Adicionar')
    add.type = 'button'
    add.addEventListener('click', async () => {
      const result = addSymbol(lists, list.id, input.value)
      if (!result.ok) {
        $('watchlistStatus').textContent = result.reason
        $('watchlistStatus').className = 'status bad'
        return
      }
      await persist({ watchlists: { lists: result.lists } }, $('watchlistStatus'), `${result.symbol} adicionado`)
      renderWatchlists()
    })
    addRow.append(input, add)
    card.appendChild(addRow)
    box.appendChild(card)
  }

  // comparação entre listas
  const compareBox = $('watchlistCompare')
  if (compareBox) {
    compareBox.innerHTML = ''
    if (lists.length >= 2) {
      const left = el('select')
      const right = el('select')
      for (const list of lists) {
        for (const [select, fallback] of [[left, 0], [right, 1]]) {
          const option = el('option', '', list.name)
          option.value = list.id
          if (list === lists[fallback])
            option.selected = true
          select.appendChild(option)
        }
      }
      const button = el('button', '', 'Comparar')
      button.type = 'button'
      const out = el('div', 'board-result')
      button.addEventListener('click', () => {
        const a = lists.find((item) => item.id === left.value)?.symbols ?? []
        const b = lists.find((item) => item.id === right.value)?.symbols ?? []
        const diff = compareLists(a, b)
        out.innerHTML = ''
        out.appendChild(el('p', '', `só na primeira: ${diff.onlyLeft.join(', ') || '—'}`))
        out.appendChild(el('p', '', `só na segunda: ${diff.onlyRight.join(', ') || '—'}`))
        out.appendChild(el('p', '', `em ambas: ${diff.both.join(', ') || '—'}`))
      })
      compareBox.append(left, right, button, out)
    }
  }
}

/* ------------------------------------------------------------------ alerts */

function renderAlerts () {
  const box = $('alertCards')
  if (!box)
    return
  box.innerHTML = ''
  const rules = config.alerts?.rules ?? []
  if (!rules.length)
    box.appendChild(el('p', 'hint', 'Nenhum alerta. Crie um abaixo; ele dispara uma vez por cruzamento.'))
  for (const rule of rules) {
    const row = el('div', 'board-card')
    const head = el('div', 'board-head')
    head.appendChild(el('strong', '', `${rule.symbol} ${rule.type.replace('_', ' ')} ${rule.value}`))
    head.appendChild(el('span', `pill ${rule.state === 'fired' ? 'pill-hot' : ''}`, rule.state))
    const edit = el('button', '', 'editar')
    edit.type = 'button'
    edit.addEventListener('click', () => openEditor(row, rule))
    const pause = el('button', '', rule.state === 'paused' ? 'retomar' : 'pausar')
    pause.type = 'button'
    pause.addEventListener('click', async () => {
      const result = rule.state === 'paused' ? resumeAlert(rules, rule.id) : pauseAlert(rules, rule.id)
      await persist({ alerts: { rules: result.alerts } }, $('alertStatus'), rule.state === 'paused' ? 'alerta retomado' : 'alerta pausado')
      renderAlerts()
    })
    const drop = el('button', 'board-danger', 'excluir')
    drop.type = 'button'
    drop.addEventListener('click', async () => {
      const result = removeAlert(rules, rule.id)
      await persist({ alerts: { rules: result.alerts } }, $('alertStatus'), 'alerta excluído')
      renderAlerts()
    })
    head.append(edit, pause, drop)
    row.appendChild(head)
    if (rule.lastFiredAt)
      row.appendChild(el('p', 'hint', `disparou em ${new Date(rule.lastFiredAt).toLocaleString('pt-BR')} (observado ${rule.lastValue})`))
    else if (rule.lastValue !== null && rule.lastValue !== undefined)
      row.appendChild(el('p', 'hint', `último valor observado: ${rule.lastValue}`))
    box.appendChild(row)
  }
}

// Editor inline de um alerta: mudar a condição re-arma o disparo (o módulo decide isso, não a UI).
function openEditor (card, rule) {
  card.innerHTML = ''
  const type = el('select')
  for (const [value, label] of [['price_above', 'preço acima de'], ['price_below', 'preço abaixo de'], ['rsi_above', 'RSI acima de'], ['rsi_below', 'RSI abaixo de'], ['pct_move', 'variação % acima de']]) {
    const option = el('option', '', label)
    option.value = value
    if (value === rule.type)
      option.selected = true
    type.appendChild(option)
  }
  const value = el('input')
  value.type = 'number'
  value.step = 'any'
  value.value = String(rule.value)
  const note = el('input')
  note.placeholder = 'nota'
  note.value = rule.note ?? ''
  const row = el('div', 'row')
  row.append(type, value, note)
  const actions = el('div', 'board-head')
  const save = el('button', '', 'salvar')
  save.type = 'button'
  const cancel = el('button', 'board-danger', 'cancelar')
  cancel.type = 'button'
  const status = el('span', 'status', '')
  save.addEventListener('click', async () => {
    const result = editAlert(config.alerts?.rules ?? [], rule.id, { type: type.value, value: value.value, note: note.value })
    if (!result.ok) {
      status.textContent = result.reason
      status.className = 'status bad'
      return
    }
    await persist({ alerts: { rules: result.alerts } }, $('alertStatus'), 'alerta editado')
    renderAlerts()
  })
  cancel.addEventListener('click', () => renderAlerts())
  actions.append(save, cancel, status)
  card.append(row, actions)
}

/* ------------------------------------------------------------------ wiring */

$('createList')?.addEventListener('click', async () => {
  const symbols = ($('newListSymbols').value ?? '').split(',').map((item) => item.trim()).filter(Boolean)
  const created = createList($('newListName').value, symbols)
  if (!created.ok) {
    $('watchlistStatus').textContent = created.reason
    $('watchlistStatus').className = 'status bad'
    return
  }
  const existing = config.watchlists?.lists ?? []
  const room = canAddList(existing)
  if (!room.ok) {
    $('watchlistStatus').textContent = room.reason
    $('watchlistStatus').className = 'status bad'
    return
  }
  const lists = [...existing, created.list]
  await persist({ watchlists: { lists } }, $('watchlistStatus'), `lista "${created.list.name}" criada`)
  $('newListName').value = ''
  $('newListSymbols').value = ''
  renderWatchlists()
})

$('rankWatchlist')?.addEventListener('click', async () => {
  const status = $('watchlistStatus')
  const lists = config.watchlists?.lists ?? []
  const symbols = [...new Set(lists.flatMap((list) => list.symbols))]
  if (!symbols.length) {
    status.textContent = 'nenhum símbolo nas listas'
    status.className = 'status bad'
    return
  }
  status.textContent = `lendo ${symbols.length} símbolo(s)…`
  status.className = 'status'
  const { readings } = await readSymbols(symbols)
  const entries = symbols.map((symbol) => ({
    symbol,
    price: readings[symbol]?.price,
    intel: readings[symbol]?.intel,
    source: readings[symbol]?.source,
    timeframe: '1h',
  }))
  lastRanking = rankOpportunities(entries)
  const out = $('rankingResult')
  out.innerHTML = ''
  // Uma descrição só: a mesma função que o CLI usa, em vez de uma cópia do formato na UI.
  for (const line of describeRanking(lastRanking).split('\n'))
    out.appendChild(el('p', line.startsWith('- ') ? 'board-row' : 'hint', line.replace(/^- /, '')))
  status.textContent = `${lastRanking.ranked.length} com dados, ${lastRanking.withoutData.length} sem dados`
  status.className = 'status ok'
})

$('createAlert')?.addEventListener('click', async () => {
  const created = createAlert({ symbol: $('alertSymbol').value, type: $('alertType').value, value: $('alertValue').value, note: $('alertNote').value })
  if (!created.ok) {
    $('alertStatus').textContent = created.reason
    $('alertStatus').className = 'status bad'
    return
  }
  const rules = [...(config.alerts?.rules ?? []), created.alert]
  await persist({ alerts: { rules } }, $('alertStatus'), `alerta criado para ${created.alert.symbol}`)
  $('alertSymbol').value = ''
  $('alertValue').value = ''
  $('alertNote').value = ''
  renderAlerts()
})

$('evaluateAlerts')?.addEventListener('click', async () => {
  const status = $('alertStatus')
  const rules = config.alerts?.rules ?? []
  if (!rules.length) {
    status.textContent = 'nenhum alerta para avaliar'
    status.className = 'status bad'
    return
  }
  const symbols = [...new Set(rules.map((rule) => rule.symbol))]
  status.textContent = `lendo ${symbols.length} símbolo(s)…`
  status.className = 'status'
  const { readings, failures } = await readSymbols(symbols)
  const snapshot = {}
  for (const [symbol, reading] of Object.entries(readings))
    snapshot[symbol] = { price: reading.price, rsi: reading.rsi, changePct: reading.changePct }
  lastEvaluation = evaluateAlerts(rules, snapshot)
  await persist({ alerts: { rules: lastEvaluation.alerts } }, null, '')
  const out = $('alertResult')
  out.innerHTML = ''
  for (const line of summarizeAlerts(lastEvaluation).split('\n'))
    out.appendChild(el('p', 'board-row', line))
  for (const failure of failures)
    out.appendChild(el('p', 'board-row board-muted', `${failure.symbol} · sem leitura: ${failure.reason}`))
  status.textContent = `${lastEvaluation.fired.length} disparado(s), ${lastEvaluation.pending.length} aguardando`
  status.className = lastEvaluation.fired.length ? 'status ok' : 'status'
  renderAlerts()
})

load().catch((error) => {
  const status = $('watchlistStatus')
  if (status) {
    status.textContent = `falha ao carregar: ${String(error?.message ?? error).slice(0, 80)}`
    status.className = 'status bad'
  }
})

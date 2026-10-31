// DZ23 Research — turns a backtest CSV into an experiment record, a Top-N table and a parameter heatmap.
// It imports the same engine the Node tests use: one implementation, no copy.
import { experimentFromBacktest } from '../quant/fromBacktest.mjs'
import { heatmap } from '../quant/fromBacktest.mjs'
import { serializeExperiment, summarizeExperiment, validateExperiment } from '../quant/contract.mjs'
import { formatPineReport, validatePine } from '../quant/pine.mjs'

const $ = (id) => document.getElementById(id)
const state = { rows: [], headers: [], metric: null, experiment: null, grid: null }

// CSV with quoted fields and doubled quotes; header names are kept exactly as exported (they are the report's).
function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index++) {
    const character = text[index]
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1 } else quoted = false
      } else field += character
    } else if (character === '"') quoted = true
    else if (character === ',') { row.push(field); field = '' }
    else if (character === '\n') { row.push(field); rows.push(row); row = []; field = '' }
    else if (character !== '\r') field += character
  }
  if (field || row.length) { row.push(field); rows.push(row) }
  return rows.filter((line) => line.some((value) => String(value).trim() !== ''))
}

const asValue = (raw) => {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  const number = Number(text)
  return Number.isFinite(number) && /^-?\d+(\.\d+)?$/.test(text) ? number : text
}

function rowsFromCsv (text) {
  const table = parseCsv(text)
  if (table.length < 2) throw new Error('o CSV precisa de cabeçalho e pelo menos uma linha de resultado')
  const headers = table[0].map((header) => String(header).trim())
  const rows = table.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, asValue(line[index])])))
  return { headers, rows }
}

function numericMetrics (headers, rows) {
  return headers.filter((header) => !header.startsWith('__') && header !== 'comment' &&
    rows.some((row) => typeof row[header] === 'number'))
}

function paramsOf (headers) {
  return headers.filter((header) => header.startsWith('__')).map((header) => header.slice(2))
}

function renderMetricSelect () {
  const metrics = numericMetrics(state.headers, state.rows)
  $('metric').innerHTML = ''
  for (const metric of metrics) {
    const option = document.createElement('option')
    option.value = metric
    option.textContent = metric
    $('metric').appendChild(option)
  }
  state.metric = metrics[0] ?? null
  $('metric').value = state.metric ?? ''
}

function makeCell (tag, value) {
  const cell = document.createElement(tag)
  cell.textContent = String(value ?? '')
  return cell
}

function renderTop (grid) {
  const shown = [...grid.points].sort((left, right) => right.value - left.value).slice(0, 15)
  const params = grid.params
  const table = document.createElement('table')
  const head = document.createElement('thead')
  const headerRow = document.createElement('tr')
  headerRow.appendChild(makeCell('th', '#'))
  for (const name of params) headerRow.appendChild(makeCell('th', name))
  headerRow.appendChild(makeCell('th', grid.metric))
  head.appendChild(headerRow)
  table.appendChild(head)
  const body = document.createElement('tbody')
  shown.forEach((point, index) => {
    const row = document.createElement('tr')
    row.appendChild(makeCell('td', index + 1))
    for (const name of params) row.appendChild(makeCell('td', point.params[name]))
    row.appendChild(makeCell('td', Math.round(point.value * 100) / 100))
    body.appendChild(row)
  })
  table.appendChild(body)
  $('table').replaceChildren(table)
  $('topN').hidden = false
}

function renderParamPickers (params) {
  for (const id of ['xParam', 'yParam']) {
    const select = $(id)
    select.innerHTML = ''
    for (const name of params) {
      const option = document.createElement('option')
      option.value = name
      option.textContent = name
      select.appendChild(option)
    }
  }
  $('xParam').value = params[0]
  $('yParam').value = params[1] ?? params[0]
}

function colour (value, min, max) {
  if (value === null) return 'transparent'
  const ratio = max > min ? (value - min) / (max - min) : 0.5
  const hue = 160 * ratio
  return `hsl(${hue} 62% 62%)`
}

function renderHeatmap () {
  const points = state.grid?.points ?? []
  const xParam = $('xParam').value
  const yParam = $('yParam').value
  if (!points.length || xParam === yParam) {
    $('heatmap').textContent = ''
    const message = document.createElement('p')
    message.className = 'muted'
    message.textContent = 'escolha dois parâmetros diferentes'
    $('heatmap').appendChild(message)
    return
  }
  const map = heatmap(points, { xParam, yParam })
  const values = map.cells.flat().filter((value) => value !== null)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const table = document.createElement('table')
  table.className = 'heat'
  const head = document.createElement('thead')
  const headerRow = document.createElement('tr')
  headerRow.appendChild(makeCell('th', `${yParam} \\ ${xParam}`))
  for (const value of map.xValues) headerRow.appendChild(makeCell('th', value))
  head.appendChild(headerRow)
  table.appendChild(head)
  const body = document.createElement('tbody')
  map.yValues.forEach((yValue, rowIndex) => {
    const row = document.createElement('tr')
    row.appendChild(makeCell('th', yValue))
    map.cells[rowIndex].forEach((value) => {
      const cell = makeCell('td', value === null ? '—' : Math.round(value * 100) / 100)
      cell.style.background = colour(value, min, max)
      row.appendChild(cell)
    })
    body.appendChild(row)
  })
  table.appendChild(body)
  $('heatmap').replaceChildren(table)
  $('heat').hidden = false
}

function renderWarnings (experiment) {
  const list = $('warnList')
  list.innerHTML = ''
  const items = [
    ...(experiment.warnings ?? []).map((warning) => ({ text: `${warning.code}: ${warning.message}`, kind: 'warn' })),
    ...(experiment.overfitting?.limitations ?? []).map((text) => ({ text, kind: 'muted' })),
  ]
  for (const item of items) {
    const li = document.createElement('li')
    li.textContent = item.text
    if (item.kind === 'warn') li.className = 'warn'
    list.appendChild(li)
  }
  $('warnings').hidden = items.length === 0
}

function setStatus (text, isError = false) {
  $('status').textContent = text
  $('status').className = isError ? 'bad' : ''
}

function analyse () {
  try {
    const { headers, rows } = rowsFromCsv($('csv').value)
    if (!rows.length) throw new Error('nenhuma linha de resultado no CSV')
    state.headers = headers
    state.rows = rows
    if (!$('metric').options.length || !headers.includes($('metric').value)) renderMetricSelect()
    const metric = $('metric').value || state.metric
    if (!metric) throw new Error('nenhuma coluna numérica de métrica encontrada')
    const testResults = { optParamName: metric, paramsNames: paramsOf(headers), perfomanceSummary: rows }
    const period = { from: new Date($('from').value).toISOString(), to: new Date($('to').value).toISOString() }
    const { experiment, grid, robustness } = experimentFromBacktest(testResults, {
      strategyId: $('strategy').value.trim(),
      strategyVersion: $('version').value.trim(),
      asset: $('asset').value.trim(),
      timeframe: $('timeframe').value.trim(),
      dataProvider: $('provider').value.trim(),
      period,
    })
    state.experiment = experiment
    state.grid = grid
    const validation = validateExperiment(experiment)
    const summary = summarizeExperiment(experiment)
    renderTop(grid)
    renderParamPickers(grid.params)
    renderHeatmap()
    renderWarnings(experiment)
    $('experiment').hidden = false
    $('summary').textContent = `${grid.points.length} combinações · métrica "${grid.metric}" · robustez ${robustnessScoreText(robustness)} · contrato ${validation.ok ? 'válido' : 'INVÁLIDO'} · OOS ${summary.outOfSampleVerdict}`
    setStatus(`${grid.points.length} combinações analisadas, ${grid.ignored} linha(s) ignorada(s) sem valor.`)
  } catch (error) {
    setStatus(`Falha ao analisar: ${error.message}`, true)
  }
}

function robustnessScoreText (robustness) {
  return robustness?.isIsolatedSpike ? 'pico isolado' : `platina de ${robustness?.plateauSize ?? 0} ponto(s)`
}

function download () {
  if (!state.experiment) return setStatus('analise um CSV antes de baixar', true)
  const blob = new Blob([serializeExperiment(state.experiment)], { type: 'application/json' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `${state.experiment.experiment_id}.json`
  link.click()
  URL.revokeObjectURL(link.href)
  setStatus('experimento exportado em JSON')
}

$('analyse').addEventListener('click', analyse)
$('clear').addEventListener('click', () => {
  $('csv').value = ''
  for (const id of ['experiment', 'topN', 'heat', 'warnings']) $(id).hidden = true
  setStatus('')
})
$('download').addEventListener('click', download)
$('file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file) return
  $('csv').value = await file.text()
  setStatus(`arquivo "${file.name}" carregado: clique em Analisar`)
})
for (const id of ['xParam', 'yParam', 'metric']) $(id).addEventListener('change', () => { if (id === 'metric') return analyse(); renderHeatmap() })

// Exposed for the automated UI check only
window.__dz23Research = { analyse, state, parseCsv }

/* ------------------------------------------------------------------ Pine Script */

const PINE_KEY = 'dz23.pine.last'

function pineRender (result) {
  const status = $('pineStatus')
  const list = $('pineFindings')
  if (!result) {
    status.textContent = ''
    status.className = 'status'
    list.innerHTML = ''
    return
  }
  status.textContent = formatPineReport(result).split('\n')[0]
  status.className = 'status ' + (result.ok ? 'ok' : 'bad')
  list.innerHTML = ''
  for (const finding of result.findings) {
    const row = document.createElement('div')
    row.className = 'finding ' + finding.level
    const where = document.createElement('span')
    where.className = 'finding-where'
    where.textContent = 'L' + finding.line + ' · ' + finding.code
    const text = document.createElement('span')
    text.textContent = finding.message
    row.append(where, text)
    list.appendChild(row)
  }
  if (!result.findings.length) {
    const empty = document.createElement('div')
    empty.className = 'finding info'
    empty.textContent = 'Nenhum achado: declaração, versão e sintaxe consistentes.'
    list.appendChild(empty)
  }
}

function pineRun () {
  const source = $('pineSource').value
  try {
    localStorage.setItem(PINE_KEY, source)
  } catch {
    /* modo privado: segue sem persistir */
  }
  const result = validatePine(source)
  pineRender(result)
  return result
}

$('pineValidate')?.addEventListener('click', () => pineRun())
$('pineClear')?.addEventListener('click', () => {
  $('pineSource').value = ''
  try { localStorage.removeItem(PINE_KEY) } catch { /* ignore */ }
  pineRender(null)
})
$('pineCopy')?.addEventListener('click', async () => {
  const result = validatePine($('pineSource').value)
  try {
    await navigator.clipboard.writeText(formatPineReport(result))
    $('pineStatus').textContent = 'relatório copiado'
  } catch {
    $('pineStatus').textContent = 'não foi possível copiar (permissão de área de transferência)'
  }
})
$('pineFile')?.addEventListener('change', async (event) => {
  const file = event.target.files?.[0]
  if (!file)
    return
  $('pineSource').value = await file.text()
  pineRun()
})
try {
  const saved = localStorage.getItem(PINE_KEY)
  if (saved)
    $('pineSource').value = saved
} catch {
  /* ignore */
}

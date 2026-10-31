/*
 @license Copyright 2021 akumidv (https://github.com/akumidv/)
 SPDX-License-Identifier: Apache-2.0
*/
'use strict';

// The popup does not load content_scripts/log.js, so it keeps the same console prefix locally
const LOG_PREFIX = '[tv-assistant]'


document.addEventListener('DOMContentLoaded', () => {
  i18n.apply()
  setMinMaxLabels()
  METRICS.populate(document.getElementById('optParamName'), METRICS.DEFAULT_OPT_PARAM)
  METRICS.populate(document.getElementById('optFilterParamName'), METRICS.DEFAULT_FILTER_PARAM)
  checkIsTVChart()
  setTabEvents()
  setPopupInputsByOptions()
  setClickEvents()
  setOptionsEvents()
  setWhatsNew()
});

const TAB_COUNT = 5
// Hash of the last "What's new" text the user closed: the notice shows again only when that text changes
const WHATS_NEW_SEEN_KEY = 'whatsNewSeenHash'
const CHANGELOG_SUBHEADING = /^###\s+/

function activateTab(tabId) {
  const activeId = Number.isInteger(tabId) && tabId >= 1 && tabId <= TAB_COUNT ? tabId : 1
  document.querySelectorAll('.tabs__links > a').forEach(link => {
    const isActive = Number(link.dataset.tab) === activeId
    link.classList.toggle('active', isActive)
    link.setAttribute('aria-selected', isActive ? 'true' : 'false')
  })
  document.querySelectorAll('.tabs > div').forEach(panel =>
    panel.classList.toggle('active', panel.id === `content-${activeId}`))
  document.querySelector('.content').scrollTop = 0
}

function setTabEvents() {
  document.querySelectorAll('.tabs__links > a').forEach(link => {
    link.addEventListener('click', () => activateTab(Number(link.dataset.tab)))
    // A tab is focusable but not a button: Enter and Space must activate it like a click
    link.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ')
        return
      event.preventDefault()
      activateTab(Number(link.dataset.tab))
    })
  })
}

// The Max/Min label of the min/max switch is drawn by the stylesheet (content: attr(...)), not by a text node
function setMinMaxLabels() {
  const label = document.querySelector('.checkbox-minmax b')
  if (!label)
    return
  label.dataset.max = i18n.t('popup_max')
  label.dataset.min = i18n.t('popup_min')
}

// The popup reads its own packaged file; no manifest permission is needed for that
async function setWhatsNew() {
  let changelogText
  try {
    const response = await fetch('../CHANGELOG.md')
    changelogText = await response.text()
  } catch (err) {
    console.error(LOG_PREFIX, 'Can not read CHANGELOG.md', err)
    return
  }
  const sections = splitChangelog(changelogText)
  if (!sections.length)
    return
  document.getElementById('helpChangelog').innerHTML = sections.map(section => renderChangelogSection(section)).join('')
  // The notice shows only the summary part of the release; the details stay in the Help tab
  const latest = getChangelogSummary(sections[0])
  const latestHash = hashText(latest.title + '\n' + latest.lines.join('\n'))
  chrome.storage.local.get(null, (stored) => {
    if (stored[WHATS_NEW_SEEN_KEY] === latestHash)
      return
    // Nothing stored at all is a fresh install: the notice is only for users who had the extension before
    if (!stored.hasOwnProperty(WHATS_NEW_SEEN_KEY) && Object.keys(stored).length === 0) {
      chrome.storage.local.set({[WHATS_NEW_SEEN_KEY]: latestHash})
      return
    }
    showWhatsNew(latest, latestHash)
  })
}

function showWhatsNew(latest, latestHash) {
  const bar = document.getElementById('whatsNewBar')
  const panel = document.getElementById('whatsNewPanel')
  document.getElementById('whatsNewOpen').textContent = i18n.t('popup_whats_new_open', [latest.title])
  document.getElementById('whatsNewText').innerHTML = renderChangelogSection(latest)
  bar.hidden = false
  function dismiss() {
    bar.hidden = true
    panel.hidden = true
    chrome.storage.local.set({[WHATS_NEW_SEEN_KEY]: latestHash})
  }
  document.getElementById('whatsNewOpen').addEventListener('click', () => { panel.hidden = false })
  document.getElementById('whatsNewDismiss').addEventListener('click', dismiss)
  document.getElementById('whatsNewClose').addEventListener('click', dismiss)
}

// Sections start with "## <version>"; the text before the first one is a note for the file editors
function splitChangelog(changelogText) {
  const sections = []
  for (const line of changelogText.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+)$/)
    if (heading)
      sections.push({title: heading[1].trim(), lines: []})
    else if (sections.length)
      sections[sections.length - 1].lines.push(line)
  }
  return sections
}

// A release section is a short summary, optionally followed by "### " parts (Details) for readers of the full log
function getChangelogSummary(section) {
  const detailsIdx = section.lines.findIndex(line => CHANGELOG_SUBHEADING.test(line))
  return detailsIdx < 0 ? section : {title: section.title, lines: section.lines.slice(0, detailsIdx)}
}

function hashText(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i++)
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(16)
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The Markdown subset CHANGELOG.md uses: "### " subheadings, "- " list items (indented lines continue them),
// paragraphs, **bold** and [text](https://link). A "### " part (Details) renders collapsed, so the Help tab shows the
// summaries and opens the details on a click.
function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank">$1</a>')
}

function renderChangelogSection(section) {
  const blocks = []
  for (const line of section.lines) {
    if (!line.trim())
      continue
    const heading = line.match(/^###\s+(.+)$/)
    const item = line.match(/^\s*-\s+(.*)$/)
    const last = blocks[blocks.length - 1]
    if (heading)
      blocks.push({type: 'h5', text: heading[1].trim()})
    else if (item)
      blocks.push({type: 'li', text: item[1]})
    else if (last && /^\s/.test(line))
      last.text += ' ' + line.trim()
    else
      blocks.push({type: 'p', text: line.trim()})
  }
  let html = `<h4>${escapeHtml(section.title)}</h4>`
  let isListOpen = false
  let isPartOpen = false
  for (const block of blocks) {
    if (block.type !== 'li' && isListOpen)
      html += '</ul>'
    if (block.type === 'h5') {
      html += (isPartOpen ? '</details>' : '') + `<details><summary>${renderInlineMarkdown(block.text)}</summary>`
      isPartOpen = true
      isListOpen = false
      continue
    }
    if (block.type === 'li' && !isListOpen)
      html += '<ul>'
    isListOpen = block.type === 'li'
    html += `<${block.type}>${renderInlineMarkdown(block.text)}</${block.type}>`
  }
  return html + (isListOpen ? '</ul>' : '') + (isPartOpen ? '</details>' : '')
}


function setOptionsEvents() {
  for(let elId of ['optMinmax', 'optParamName', 'optMethod', 'optFilterOff', 'optFilterMore', 'optFilterLess',
    'optFilterValue', 'optFilterParamName', 'randomDelay', 'shouldTestTF', 'shouldSkipInitBestResult', 'parseExtraReportTabs', 'setParamsByApi',
    'shouldSkipWaitingForDownload']) {
    function saveOptListener() {
      saveOptions(elId)
    }
    document.getElementById(elId).addEventListener('click', saveOptListener)
  }
  for(let elId of ['deepStartDate', 'backtestDelay', 'dataLoadingTime', 'listOfTF']) {
    function saveOptListener() {
      saveOptions(elId)
    }
    // deepStartDate is commented out in the popup for now
    if (document.getElementById(elId))
      document.getElementById(elId).addEventListener('blur', saveOptListener)
  }
}

function setClickEvents() {
  for(let elId of ['uploadSignals', 'testStrategy', 'previewStrategyTestResults', 'downloadStrategyTestResults', 'getStrategyTemplate', 'uploadStrategyTestParameters', 'clearAll', 'show3DChart']) {
    function signalListener() {
      sendSignalToActiveTab(elId)
    }
    if (document.getElementById(elId))
      document.getElementById(elId).addEventListener('click', signalListener);
    else
      console.error(LOG_PREFIX, `Can not find id ${elId}`)
  }
  const openResearch = document.getElementById('openResearch')
  if (openResearch)
    openResearch.addEventListener('click', () => chrome.tabs.create({ url: '../research/index.html' }))

  // The copilot lives in the side panel: opening it is a user gesture, which the side panel API requires
  const openCopilot = document.getElementById('openCopilot')
  if (openCopilot)
    openCopilot.addEventListener('click', () => {
      if (chrome.sidePanel?.open) {
        chrome.windows.getCurrent((windowInfo) => {
          chrome.sidePanel.open({ windowId: windowInfo.id }).catch(() => {
            chrome.tabs.create({ url: '../copilot/index.html' })
          })
        })
      } else {
        chrome.tabs.create({ url: '../copilot/index.html' })
      }
    })

  document.getElementById('closeMsg').addEventListener('click', function () {
    document.getElementById('shim').style.display = 'none'
    document.getElementById('msgbx').style.display = 'none';
  });
}

function checkIsTVChart() {
  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    // A page without a URL (an internal browser page, a discarded tab) is not a TradingView chart either
    const url = (tabs[0] && tabs[0].url) || ''
    let message = null
    if(!url.includes('tradingview.com'))
      message = i18n.t('popup_error_not_tv_html')
    // The English-version notice only makes sense on a TradingView page in another language
    else if(!url.includes('www.tradingview.com') && !url.includes('en.tradingview.com'))
      message = i18n.t('popup_tv_english_html')
    if (message) {
      for(let elId of ['warningSignals', 'warningBacktest', 'warningResults']) {
        if (document.getElementById(elId))
          document.getElementById(elId).innerHTML = message
      }
      const rootElement = document.querySelector(':root')
      if (rootElement) rootElement.style.setProperty('--warningVisible', 'block')
    }
  });
}


function setPopupInputsByOptions() {
  // The bridge seeds iondvOptions from the shared config; wait for it so a fresh install restores correctly
  Promise.resolve(window.dz23PopupConfig?.ready).catch(() => {}).then(() => chrome.storage.local.get('iondvOptions', (getResults) => {
    let tabId = 1
    if (getResults.hasOwnProperty('iondvOptions')) {
      const iondvOptions = getResults['iondvOptions']
      console.debug(LOG_PREFIX, 'iondvOptions', iondvOptions)
      tabId = iondvOptions['tabId'] ? iondvOptions['tabId'] : 1
      if (document.getElementById('optMinmax') && iondvOptions.hasOwnProperty('isMaximizing'))
        document.getElementById('optMinmax').checked = iondvOptions.isMaximizing
      if (document.getElementById('optParamName') && iondvOptions.hasOwnProperty('optParamName')) {
        const saved = iondvOptions.optParamName
        document.getElementById('optParamName').value = METRICS.isValid(saved) ? saved : METRICS.DEFAULT_OPT_PARAM
      }
      if (document.getElementById('optMethod') && iondvOptions.hasOwnProperty('optMethod'))
        document.getElementById('optMethod').value = iondvOptions.optMethod

      if (iondvOptions.hasOwnProperty('optFilterAscending') && document.getElementById('optFilterMore') &&
        document.getElementById('optFilterLess') && document.getElementById('optFilterOff')) {
        if (iondvOptions.optFilterAscending === true) {
          document.getElementById('optFilterOff').checked = false
          document.getElementById('optFilterMore').checked = true
          document.getElementById('optFilterLess').checked = false
        } else if (iondvOptions.optFilterAscending === false) {
          document.getElementById('optFilterOff').checked = false
          document.getElementById('optFilterMore').checked = false
          document.getElementById('optFilterLess').checked = true
        } else {
          document.getElementById('optFilterOff').checked = true
          document.getElementById('optFilterMore').checked = false
          document.getElementById('optFilterLess').checked = false
        }
      }
      if (document.getElementById('optFilterValue') && iondvOptions.hasOwnProperty('optFilterValue'))
        document.getElementById('optFilterValue').value = iondvOptions.optFilterValue
      if (document.getElementById('optFilterParamName') && iondvOptions.hasOwnProperty('optFilterParamName')) {
        const saved = iondvOptions.optFilterParamName
        document.getElementById('optFilterParamName').value = METRICS.isValid(saved) ? saved : METRICS.DEFAULT_FILTER_PARAM
      }

      if(document.getElementById('deepStartDate') && iondvOptions.hasOwnProperty('deepStartDate'))
        document.getElementById('deepStartDate').value = iondvOptions.deepStartDate
      if(document.getElementById('dataLoadingTime') && iondvOptions.hasOwnProperty('dataLoadingTime')) {
        document.getElementById('dataLoadingTime').value = iondvOptions.dataLoadingTime !== null ? iondvOptions.dataLoadingTime : 30
      }
      if(document.getElementById('backtestDelay') && iondvOptions.hasOwnProperty('backtestDelay')) {
        if (iondvOptions.backtestDelay !== null)
          document.getElementById('backtestDelay').value = iondvOptions.backtestDelay
      }
      if(document.getElementById('randomDelay') && iondvOptions.hasOwnProperty('randomDelay')) {
        document.getElementById('randomDelay').checked = Boolean(iondvOptions.randomDelay)
      }
      if(document.getElementById('shouldTestTF') && iondvOptions.hasOwnProperty('shouldTestTF')) {
        document.getElementById('shouldTestTF').checked = Boolean(iondvOptions.shouldTestTF)
      }
      if(document.getElementById('shouldSkipInitBestResult') && iondvOptions.hasOwnProperty('shouldSkipInitBestResult')) {
        document.getElementById('shouldSkipInitBestResult').checked = Boolean(iondvOptions.shouldSkipInitBestResult)
      }
      if(document.getElementById('parseExtraReportTabs') && iondvOptions.hasOwnProperty('parseExtraReportTabs')) {
        document.getElementById('parseExtraReportTabs').checked = Boolean(iondvOptions.parseExtraReportTabs)
      }
      if(document.getElementById('setParamsByApi') && iondvOptions.hasOwnProperty('setParamsByApi')) {
        document.getElementById('setParamsByApi').checked = Boolean(iondvOptions.setParamsByApi)
      }
      if(document.getElementById('shouldSkipWaitingForDownload') && iondvOptions.hasOwnProperty('shouldSkipWaitingForDownload')) {
        document.getElementById('shouldSkipWaitingForDownload').checked = Boolean(iondvOptions.shouldSkipWaitingForDownload)
      }
      if(document.getElementById('listOfTF') && iondvOptions.hasOwnProperty('listOfTF')) {
        if (iondvOptions.listOfTF !== null)
          document.getElementById('listOfTF').value = iondvOptions.listOfTF
      }
    }
    activateTab(tabId) // Saved or first tab
  }))
}

function getOptions(signal) {
  const iondvOptions = {}
  iondvOptions.isMaximizing = document.getElementById('optMinmax').checked
  iondvOptions.optParamName = document.getElementById('optParamName').value || METRICS.DEFAULT_OPT_PARAM
  iondvOptions.optMethod = document.getElementById('optMethod').value || 'random'

  iondvOptions.optFilterAscending  = document.getElementById('optFilterMore').checked ? true : document.getElementById('optFilterLess').checked ? false : null
  iondvOptions.optFilterValue = document.getElementById('optFilterValue').value || '50'
  iondvOptions.optFilterParamName = document.getElementById('optFilterParamName').value || METRICS.DEFAULT_FILTER_PARAM
  const deepStartDateEl = document.getElementById('deepStartDate')
  if (deepStartDateEl) {
    if (deepStartDateEl.value === '' || (deepStartDateEl.value && deepStartDateEl.value.match(/^20\d{2}-[0-1][0-9]-[0-3][0-9]/))) {
      deepStartDateEl.style.removeProperty('color')
      iondvOptions.deepStartDate = deepStartDateEl.value
    } else {
      deepStartDateEl.style.setProperty('color', 'red')
      iondvOptions.deepStartDate = null
    }
  }
  if(document.getElementById('dataLoadingTime')) {
    const dataLoadingTime =  document.getElementById('dataLoadingTime').value
    iondvOptions.dataLoadingTime = dataLoadingTime === '' ? null : isNaN(parseInt(dataLoadingTime)) ? 45 : Math.abs(parseInt(dataLoadingTime))
  }
  if(document.getElementById('backtestDelay')) {
    const delayValue =  document.getElementById('backtestDelay').value
    iondvOptions.backtestDelay = delayValue === '' ? null : isNaN(parseFloat(delayValue)) ? 0.5 : Math.abs(parseFloat(delayValue))
  }
  iondvOptions.randomDelay = document.getElementById('randomDelay').checked
  iondvOptions.shouldTestTF = document.getElementById('shouldTestTF').checked
  iondvOptions.shouldSkipInitBestResult = document.getElementById('shouldSkipInitBestResult').checked
  iondvOptions.shouldSkipWaitingForDownload = document.getElementById('shouldSkipWaitingForDownload').checked
  iondvOptions.parseExtraReportTabs = document.getElementById('parseExtraReportTabs').checked
  iondvOptions.setParamsByApi = document.getElementById('setParamsByApi').checked

  if(document.getElementById('listOfTF')) {
    const listOfTF =  document.getElementById('listOfTF').value
    iondvOptions.listOfTF = listOfTF === '' ? null : listOfTF
  }

  iondvOptions.tabId = (signal === 'uploadSignals') ? 3 : 1
  return iondvOptions
}

// Persistência das opções do popup: fonte única é o registro compartilhado (dz23.config.v1); a ponte espelha
// em iondvOptions para os content scripts antigos. Sem a ponte (página isolada), grava direto como antes.
function persistOptions(iondvOptions) {
  const bridge = window.dz23PopupConfig
  if (bridge && typeof bridge.saveOptions === 'function') {
    void bridge.saveOptions(iondvOptions).catch(() => {
      chrome.storage.local.set({'iondvOptions': iondvOptions})
    })
    return
  }
  chrome.storage.local.set({'iondvOptions': iondvOptions})
}

function saveOptions(signal) {
  const iondvOptions = getOptions(signal)
  persistOptions(iondvOptions)
  console.debug(LOG_PREFIX, 'Saved options', iondvOptions)
}

function sendSignalToActiveTab(signal) {
  let iondvOptions = null
  if(signal !== 'clearAll') {
    iondvOptions = getOptions(signal)
    persistOptions(iondvOptions)
  }

  chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
    const url = (tabs[0] && tabs[0].url) || ''
    if(!url.includes('tradingview.com')) {
      document.getElementById('msg-text').innerHTML = i18n.t('popup_error_not_tv_html')
      document.getElementById('shim').style.display = 'block'
      document.getElementById('msgbx').style.display = 'block'
      return
    }
    const message = {action: signal}
    if(iondvOptions)
      message.options = iondvOptions
    chrome.tabs.sendMessage(tabs[0].id, message, function() {window.close()});
  });
}
// The single settings screen, opened from the popup (same record, same rules)
document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('openSettingsPage')
  if (!button)
    return
  button.addEventListener('click', () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage()
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('settings/index.html') })
    }
    window.close()
  })
})

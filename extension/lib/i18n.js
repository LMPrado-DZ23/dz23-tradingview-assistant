/*
 @license Copyright 2021 akumidv (https://github.com/akumidv/)
 SPDX-License-Identifier: Apache-2.0
*/
'use strict'

// One localization entry point for the popup and the content scripts.
// Catalogs live in extension/_locales/<locale>/messages.json (chrome.i18n, default locale "en"), so the same
// build ships every supported language and the browser UI language picks one. Message keys use only
// [A-Za-z0-9_@], which chrome.i18n requires.
//
// A message may carry positional placeholders {0}, {1} ...; t() fills them from its second argument, so a
// translation can reorder the values without touching the caller. chrome.i18n placeholders are not used:
// they would need a per-message declaration for every interpolated text here.
const i18n = (() => {
  const reportedKeys = new Set()

  function catalogMessage (key) {
    try {
      return chrome.i18n.getMessage(key) || ''
    } catch (err) {
      return ''
    }
  }

  function fillPlaceholders (text, substitutions) {
    if (substitutions === undefined || substitutions === null)
      return text
    const values = Array.isArray(substitutions) ? substitutions : [substitutions]
    return values.reduce((text, value, index) => text.split(`{${index}}`).join(String(value)), text)
  }

  // A message for display. A missing key stays visible as the key itself and is reported once in the console:
  // chrome.i18n already falls back to the default locale, so this only happens when the key does not exist.
  function t (key, substitutions) {
    const text = catalogMessage(key)
    if (text)
      return fillPlaceholders(text, substitutions)
    if (!reportedKeys.has(key)) {
      reportedKeys.add(key)
      console.warn('[tv-assistant] missing localization message:', key)
    }
    return key
  }

  function uiLanguage () {
    try {
      return chrome.i18n.getUILanguage() || 'en'
    } catch (err) {
      return 'en'
    }
  }

  // Static markup of an extension page: a data-i18n* attribute names the message key of that slot
  function apply (root) {
    const scope = root || document
    const slots = [
      ['[data-i18n]', (el) => { el.textContent = t(el.getAttribute('data-i18n')) }],
      ['[data-i18n-html]', (el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')) }],
      ['[data-i18n-title]', (el) => { el.title = t(el.getAttribute('data-i18n-title')) }],
      ['[data-i18n-placeholder]', (el) => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')) }],
      ['[data-i18n-aria-label]', (el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria-label'))) }],
    ]
    for (const [selector, applyToElement] of slots)
      for (const el of scope.querySelectorAll(selector))
        applyToElement(el)
    if (document.documentElement)
      document.documentElement.lang = uiLanguage()
  }

  return { t, apply, uiLanguage, has: (key) => Boolean(catalogMessage(key)) }
})()

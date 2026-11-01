// Loads this extension's plain scripts into one `vm` context, the way the browser loads them into the isolated
// world of a page: no bundler, no DOM, only the globals the scripts actually touch. A test names the files it
// needs and receives the objects they define.
//
//   const ext = loadExtension(['content_scripts/storage.js'])
//   const { storage } = ext.api('storage')
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const EXTENSION_DIR = join(here, '../../../extension')
export const PAGE_ORIGIN = 'https://www.tradingview.com'

export function readCatalog (locale = 'en') {
  return JSON.parse(readFileSync(join(EXTENSION_DIR, `_locales/${locale}/messages.json`), 'utf8'))
}

// Deterministic 16-bit stream, so a test that exercises a random search is repeatable
function seededCrypto (seed = 1) {
  let state = seed >>> 0
  const nextFloat = () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    getRandomValues: (array) => {
      for (let i = 0; i < array.length; i++)
        array[i] = Math.floor(nextFloat() * 65536)
      return array
    },
  }
}

function fakeStorageArea (initial = {}) {
  const data = { ...initial }
  const area = {
    data,
    get (keys, callback) {
      let result = {}
      if (keys === null || keys === undefined)
        result = { ...data }
      else if (typeof keys === 'string')
        result = keys in data ? { [keys]: data[keys] } : {}
      else if (Array.isArray(keys))
        for (const key of keys) if (key in data) result[key] = data[key]
      else
        for (const key of Object.keys(keys ?? {})) result[key] = key in data ? data[key] : keys[key]
      callback(result)
    },
    set (items, callback) { Object.assign(data, items); callback?.() },
    remove (keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]
      callback?.()
    },
  }
  return area
}

function fakeElement (tagName = 'div') {
  return {
    tagName,
    children: [],
    style: {},
    dataset: {},
    attributes: {},
    textContent: '',
    innerHTML: '',
    src: '',
    onload: null,
    onerror: null,
    setAttribute (name, value) { this.attributes[name] = value },
    getAttribute (name) { return this.attributes[name] ?? null },
    appendChild (child) { this.children.push(child); return child },
    insertBefore (child) { this.children.unshift(child); return child },
    removeChild (child) { this.children = this.children.filter((item) => item !== child); return child },
    addEventListener () {},
    removeEventListener () {},
    querySelector () { return null },
    querySelectorAll () { return [] },
    focus () {},
    click () {},
    dispatchEvent () { return true },
  }
}

function fakeDocument (state) {
  const documentElement = fakeElement('html')
  // The extension appends both a <style> and its injected scripts to <html>: only the scripts are recorded
  const appendToRoot = documentElement.appendChild
  documentElement.appendChild = function (element) {
    if (element && element.tagName === 'script')
      state.push(element)
    return appendToRoot.call(this, element)
  }
  return {
    documentElement,
    body: fakeElement('body'),
    createElement: (tagName) => fakeElement(tagName),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    addEventListener () {},
    removeEventListener () {},
    // Record what the page-context script asked the browser to load
  }
}

/**
 * Run extension files in one context.
 * options.locale      catalog used by chrome.i18n (default "en")
 * options.storage     initial chrome.storage.local content
 * options.seed        seed for crypto.getRandomValues
 */
export function loadExtension (files, options = {}) {
  const catalog = readCatalog(options.locale ?? 'en')
  const logs = []
  const pageMessages = []
  const windowListeners = []
  const injectedScripts = []
  const storageArea = fakeStorageArea(options.storage)

  const quiet = (level) => (...args) => logs.push({ level, args })
  const consoleStub = {
    log: quiet('log'), debug: quiet('debug'), info: quiet('info'), warn: quiet('warn'), error: quiet('error'),
  }

  class FakeFileReader {
    addEventListener (type, handler) {
      if (type === 'load') this._onLoad = handler
    }
    // The tests hand a plain { name, content } object instead of a File
    readAsText (file) {
      const result = { target: { result: file.content ?? '' } }
      setImmediate(() => this._onLoad?.(result))
    }
  }

  const sandbox = {
    console: consoleStub,
    document: fakeDocument(injectedScripts),
    crypto: seededCrypto(options.seed ?? 1),
    setTimeout, clearTimeout, setImmediate,
    // The extension polls with setInterval at load; a real timer would keep the test runner alive
    setInterval: () => 0,
    clearInterval: () => {},
    queueMicrotask,
    Event: class Event { constructor (type) { this.type = type } },
    PointerEvent: class PointerEvent { constructor (type) { this.type = type } },
    MouseEvent: class MouseEvent { constructor (type) { this.type = type } },
    // page.js reads the native value setter of an input to bypass React's value tracking
    HTMLInputElement: { prototype: { _value: '', get value () { return this._value }, set value (next) { this._value = next } } },
    FileReader: FakeFileReader,
    URL: { createObjectURL: () => 'blob:fake', revokeObjectURL: () => {} },
    chrome: {
      i18n: {
        getMessage: (key) => (catalog[key] ? catalog[key].message : ''),
        getUILanguage: () => 'en-US',
      },
      runtime: {
        getURL: (path) => `chrome-extension://fake/${path}`,
        getManifest: () => ({ version: '2.15.0', name: 'test' }),
        onMessage: { addListener: () => {} },
        // os content scripts pedem coisas ao background (abrir o Research, parear o gateway); sem isto a ação do
        // diálogo não teria como ser testada
        sendMessage: (message) => { if (message) pageMessages.push({ toBackground: message }) },
        // background.js registra o comportamento do painel no onInstalled; sem isto qualquer teste que carregue o
        // background morre em "cannot read properties of undefined"
        onInstalled: { addListener: () => {}, removeListener: () => {} },
      },
      // o service worker usa sidePanel só no onInstalled e dentro de try/catch
      sidePanel: { setPanelBehavior: () => Promise.resolve(), open: () => Promise.resolve() },
      storage: { local: storageArea, sync: fakeStorageArea() },
      tabs: { query: (query, callback) => callback([{ url: `${PAGE_ORIGIN}/chart/abc/` }]), sendMessage: () => {} },
    },
    addEventListener (type, handler) {
      if (type === 'message') windowListeners.push(handler)
    },
    removeEventListener () {},
    postMessage (message) { pageMessages.push(message) },
    location: { origin: PAGE_ORIGIN, href: `${PAGE_ORIGIN}/chart/abc/` },
  }

  const context = createContext(sandbox, { name: 'tv-assistant-extension' })
  // `window` and `self` are the global object itself, as in a page
  runInContext('globalThis.window = globalThis; globalThis.self = globalThis;', context, { filename: 'bootstrap.js' })

  // Every content script expects the localization helper and the logger to exist first; page-context.js runs in
  // the page world instead, with its own LOG_PREFIX, so it is loaded with defaults: false
  const always = options.defaults === false ? [] : ['lib/i18n.js', 'content_scripts/log.js']
  for (const file of [...always, ...files]) {
    const source = readFileSync(join(EXTENSION_DIR, file), 'utf8')
    try {
      runInContext(source, context, { filename: file })
    } catch (err) {
      err.message = `${file}: ${err.message}`
      throw err
    }
  }

  return {
    context,
    logs,
    pageMessages,
    windowListeners,
    injectedScripts,
    storageArea,
    /** Lexical (`const`) bindings are not properties of the global object: read them from a script */
    api (names) {
      const expression = `({ ${[].concat(names).join(', ')} })`
      return runInContext(expression, context, { filename: 'api.js' })
    },
    evaluate (expression) {
      return runInContext(expression, context, { filename: 'eval.js' })
    },
    /** Load one more file after the context is already running (e.g. a script that must start last) */
    runFile (file) {
      runInContext(readFileSync(join(EXTENSION_DIR, file), 'utf8'), context, { filename: file })
    },
    // Listeners are async: settle them so a test can assert a rejection instead of crashing the run
    dispatchWindowMessage (event) {
      return Promise.allSettled(windowListeners.map((listener) => listener(event)))
    },
  }
}


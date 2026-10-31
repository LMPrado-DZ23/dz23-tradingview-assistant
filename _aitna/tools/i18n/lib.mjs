// Pure localization helpers for the extension catalogs, shared by the CLI and its tests.
// A catalog is extension/_locales/<locale>/messages.json: { "<key>": { "message": "<text>" } }.
// Message keys must satisfy chrome.i18n: letters, digits, "_" and "@" only.

const KEY_PATTERN = /^[a-zA-Z0-9_@]+$/
const PLACEHOLDER_PATTERN = /\{(\d+)\}/g
// "$" is reserved by chrome.i18n for placeholder expansion; a message that uses it cannot be trusted to display
const RESERVED_CHARACTER = '$'

// Where a message key is referenced: i18n.t('key') in scripts, data-i18n*="key" in pages, __MSG_key__ in a manifest
const USAGE_PATTERNS = [
  /i18n\.t\(\s*'([^']+)'/g,
  /i18n\.t\(\s*"([^"]+)"/g,
  /data-i18n(?:-[a-z-]+)?="([^"]+)"/g,
  /__MSG_([A-Za-z0-9_@]+)__/g,
  // A key may be chosen at runtime (i18n.t(condition ? 'a' : 'b')), so every quoted literal that carries a
  // catalog namespace prefix counts as a reference too
  /'((?:ext|popup|ui|metrics|action|file|tv|tvchart|backtest|controller|model)_[a-z0-9_]+)'/g,
]

export const SKIP_SOURCE_FILES = new Set(['plotly.min.js', 'i18n.js'])

function problem (level, code, message) {
  return { level, code, message }
}

// Every message key referenced by one source file, in first-seen order
export function extractKeys (source) {
  const keys = []
  for (const pattern of USAGE_PATTERNS) {
    pattern.lastIndex = 0
    for (const match of source.matchAll(pattern)) {
      if (!keys.includes(match[1]))
        keys.push(match[1])
    }
  }
  return keys
}

// Positional placeholders of a message, sorted, so two translations can be compared
export function placeholdersOf (message) {
  const found = new Set()
  for (const match of String(message).matchAll(PLACEHOLDER_PATTERN))
    found.add(Number(match[1]))
  return [...found].sort((left, right) => left - right)
}

// A catalog file body (already parsed JSON) as key -> message
export function toCatalogMap (catalogJson) {
  const catalog = new Map()
  for (const [key, value] of Object.entries(catalogJson || {}))
    catalog.set(key, value && typeof value.message === 'string' ? value.message : '')
  return catalog
}

export function formatCatalog (catalog) {
  const lines = [...catalog]
    .map(([key, message]) => `  ${JSON.stringify(key)}: { "message": ${JSON.stringify(message)} }`)
  return `{\n${lines.join(',\n')}\n}\n`
}

// A catalog must be usable on its own: valid key names, a non-empty message, no reserved characters
export function checkCatalogEntries (catalog, locale) {
  const problems = []
  for (const [key, message] of catalog) {
    if (!KEY_PATTERN.test(key))
      problems.push(problem('error', 'key_charset', `${locale}: "${key}" has characters chrome.i18n does not allow (use letters, digits, _ or @)`))
    if (!message.trim())
      problems.push(problem('error', 'empty_message', `${locale}: "${key}" has an empty message`))
    if (message.includes(RESERVED_CHARACTER))
      problems.push(problem('error', 'reserved_character', `${locale}: "${key}" contains "$", which chrome.i18n reserves for placeholders`))
  }
  return problems
}

// Translations must cover the reference locale exactly and keep its positional placeholders
export function checkTranslationParity (catalogs, referenceLocale = 'en') {
  const problems = []
  // Callers pass either a Map<locale, Map<key, message>> (the CLI) or a plain object (tests, fixtures)
  const byLocale = catalogs instanceof Map ? catalogs : new Map(Object.entries(catalogs))
  const reference = byLocale.get(referenceLocale)
  if (!reference) {
    problems.push(problem('error', 'reference_missing', `the reference catalog "${referenceLocale}" is missing`))
    return problems
  }
  for (const [locale, catalog] of byLocale) {
    if (locale === referenceLocale)
      continue
    for (const key of reference.keys()) {
      if (!catalog.has(key)) {
        problems.push(problem('error', 'missing_translation', `${locale}: message "${key}" is missing`))
        continue
      }
      const expected = placeholdersOf(reference.get(key))
      const actual = placeholdersOf(catalog.get(key))
      if (expected.join(',') !== actual.join(',')) {
        problems.push(problem('error', 'placeholder_mismatch',
          `${locale}: "${key}" uses placeholders {${actual.join('},{')}} but ${referenceLocale} uses {${expected.join('},{')}}`))
      }
    }
    for (const key of catalog.keys())
      if (!reference.has(key))
        problems.push(problem('error', 'unknown_key', `${locale}: "${key}" does not exist in ${referenceLocale}`))
  }
  return problems
}

// Every referenced key must exist; a catalog entry nobody references is dead weight
export function checkUsage (usage, referenceCatalog) {
  const problems = []
  const referenced = new Set()
  for (const { key, file } of usage) {
    referenced.add(key)
    if (!referenceCatalog.has(key))
      problems.push(problem('error', 'missing_key', `${file}: references "${key}", which is not in the reference catalog`))
  }
  for (const key of referenceCatalog.keys())
    if (!referenced.has(key))
      problems.push(problem('warning', 'orphan_key', `"${key}" is in the catalog but no file references it`))
  return problems
}

export function summarize (problems) {
  return {
    errors: problems.filter(item => item.level === 'error').length,
    warnings: problems.filter(item => item.level === 'warning').length,
  }
}

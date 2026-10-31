// ESLint flat config for the extension.
//
// The extension is plain browser JavaScript loaded by the manifest: no modules, no build. Every content script
// shares one isolated-world scope, so the objects defined in one file (log, tv, backtest...) are globals for the
// next one. They are declared here instead of being imported.
//
// The rules are the ones that catch a real defect in this code base: an undefined identifier, an assignment that
// silently creates a global, a duplicate key. Style is not policed.
const extensionObjects = {
  // content_scripts/log.js
  LOG_PREFIX: 'readonly',
  log: 'readonly',
  UiChangedError: 'readonly',
  UserActionError: 'readonly',
  // lib/i18n.js
  i18n: 'readonly',
  // content_scripts/selector.js
  SEL: 'readonly',
  selStatus: 'readonly',
  // content_scripts
  page: 'readonly',
  ui: 'readonly',
  tv: 'readonly',
  tvChart: 'readonly',
  file: 'readonly',
  storage: 'readonly',
  signal: 'readonly',
  model: 'readonly',
  backtest: 'readonly',
  action: 'readonly',
  // content_scripts/action.js and page-context.js each define their own `message`
  message: 'readonly',
  // popup/metrics-options.js
  METRICS: 'readonly',
  // provided by the page world where page-context.js runs
  Plotly: 'readonly',
  // helper of backtest.js, used by tv.js and available once every content script has loaded
  randomInteger: 'readonly',
  // content_scripts/tv.js, used by action.js to pair a page request with its answer
  tvPageMessageData: 'readonly',
}

const browserGlobals = {
  window: 'readonly',
  self: 'readonly',
  document: 'readonly',
  location: 'readonly',
  navigator: 'readonly',
  console: 'readonly',
  chrome: 'readonly',
  crypto: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  FileReader: 'readonly',
  Event: 'readonly',
  CustomEvent: 'readonly',
  PointerEvent: 'readonly',
  MouseEvent: 'readonly',
  KeyboardEvent: 'readonly',
  WheelEvent: 'readonly',
  MutationObserver: 'readonly',
  HTMLInputElement: 'readonly',
  getComputedStyle: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
}

// The shared objects are declared once per file and used by the other files of the same content-script scope,
// so declaring them must not be reported as unused.
const sharedObjectNames = '^(log|i18n|SEL|selStatus|METRICS|UiChangedError|UserActionError|tvPageMessageData)$'

// no-redeclare is off on purpose: the files declare the shared objects (tv, backtest...) that are also listed as
// globals for the other files. A write to an undeclared name is still an error through no-undef.
const rules = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': 'error',
  'no-self-assign': 'error',
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none', varsIgnorePattern: sharedObjectNames }],
}

const nodeGlobals = {
  console: 'readonly',
  process: 'readonly',
  Buffer: 'readonly',
  fetch: 'readonly',
  AbortSignal: 'readonly',
  WebSocket: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  AbortController: 'readonly',
  TextDecoder: 'readonly',
  setImmediate: 'readonly',
  queueMicrotask: 'readonly',
}

export default [
  {
    files: ['extension/**/*.js'],
    // Vendored library, loaded as is
    ignores: ['extension/lib/plotly.min.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: { ...browserGlobals, ...extensionObjects },
    },
    rules,
  },
  {
    // The CSV reader assigns the match result inside the condition on purpose: `if (m = text.match(...))`
    files: ['extension/content_scripts/file.js'],
    rules: { 'no-cond-assign': 'off' },
  },
  {
    // The gateway is a Node service: standard library only, no bundler
    files: ['gateway/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...nodeGlobals, TextDecoder: 'readonly', TextEncoder: 'readonly', AbortController: 'readonly', URLSearchParams: 'readonly', URL: 'readonly', btoa: 'readonly', atob: 'readonly', crypto: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    // The copilot is a plain browser page (ES module), loaded by the side panel
    // ES modules loaded by the copilot and research pages, plus the pure chart-context library
    files: ['extension/quant/compareStrategies.mjs', 'extension/quant/pine.mjs', 'extension/quant/pineGen.mjs', 'extension/quant/pineExplain.mjs', 'extension/copilot/**/*.js', 'extension/lib/chartContext.js', 'extension/lib/candles.js', 'extension/lib/indicators.js', 'extension/lib/config.js', 'extension/lib/chartActions.js', 'extension/lib/marketIntel.js', 'extension/lib/agents.js', 'extension/lib/watchlist.js', 'extension/lib/alerts.js', 'extension/lib/compare.js', 'extension/lib/compareAssets.js', 'extension/settings/boards.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...browserGlobals, localStorage: 'readonly', AbortController: 'readonly', TextDecoder: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    // The research page is a browser ES module and imports the shared quantitative engine.
    files: ['extension/research/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...browserGlobals, Blob: 'readonly', localStorage: 'readonly' },
    },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    // The research engine is a Node library: pure functions, no I/O
    files: ['extension/quant/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...nodeGlobals },
    },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    // The ingest service is a Node service that imports the contract
    files: ['dz23/**/*.mjs'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: { ...nodeGlobals } },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    // MCP client: Node library + CLI (WebCrypto, fetch and URLSearchParams are standard there)
    files: ['mcp/**/*.mjs', '_aitna/tools/extension-tests/mcp-tradingview.test.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...nodeGlobals,
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        AbortController: 'readonly',
        URLSearchParams: 'readonly',
        URL: 'readonly',
        btoa: 'readonly',
        atob: 'readonly',
        crypto: 'readonly',
      },
    },
    rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-unused-vars': ['warn', { args: 'none' }] },
  },
  {
    files: ['_aitna/tools/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: nodeGlobals,
    },
    rules: {
      'no-undef': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['warn', { args: 'none' }],
    },
  },
]

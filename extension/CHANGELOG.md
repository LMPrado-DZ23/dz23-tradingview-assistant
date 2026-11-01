# Changelog

Newest version first. Each version starts with a summary for users, shown once after an update as the popup
"What's new" notice; a "Details" part after it holds what the summary and git can not tell. The Help tab shows
the whole file. Format and rendering rules: [_aitna/skills/changelog](../_aitna/skills/changelog/SKILL.md).

## 2.17.0

### Added
- Automatic gateway pairing in development: the copilot fetches the local token from `GET /token` on boot, so a
  fresh install (or cleared storage) reconnects without pasting anything. Production gateways answer 404.
- `npm run gateway:dev`: one command that reuses the token in `~/.dz23/gateway-token`, loads
  `~/.dz23/providers.env` when present and starts the gateway on 127.0.0.1:8777.
- Candle provenance in the system prompt (`Fonte dos candles: BINANCE`), with the OHLCV summary the model reads.
- A test file was silently outside the gate: `gateway/core.test.mjs` never ran — the gate listed three of the four
  gateway files by hand, so "42 tests, all green" was true and meaningless while a fourth file had been failing since
  the role-validation change. Hand-written file lists drift from disk; the gateway, dz23 and mcp steps now take globs
  (`gateway/*.test.mjs`) and `npm run audit:test-files` fails when any of the **59** test files is not matched by a gate
  pattern. Proven by restoring the old three-file list: three files reported FORA. The stale assertion itself was
  corrected to the current contract instead of deleted.

- Permissions are checked against usage (`npm run audit:permissions`, in the gate): §10 forbids asking for generic
  permissions you do not need, and a store reviewer agrees. Seven permissions and two host origins must each show evidence
  in the code — or an explicit justification when they are implicit by nature (`unlimitedStorage` lifts the storage quota;
  `activeTab` is granted by the click that opens the panel). It fails on an unused permission, an unused host origin, and
  on `cookies` by principle. Proven by declaring `notifications` and `cookies`: three findings, then clean again.
  Two of my own audits of this were wrong first — shell globs returned false negatives for `scripting` and
  `nativeMessaging`, which *are* used.

- Each dead end got the exit it deserves, not the same one: a transient failure (panel did not render, Plotly did not load)
  is fixed by **retrying**, while a missing TradingView feature is bypassed by the **local lab**. `ui.retryAction(run)` now
  powers the four transient dialogs and `ui.researchAction()` the four that need the other tool; the messages were
  rewritten to name the button next to them. The four remaining dialogs have **no button on purpose** — the fix is outside
  the extension (pick a strategy, change the ticker) — and `docs/DIALOGOS.md` records why, with a test that fails if the
  doc ever cites a translation key that does not exist.

- Same way out on the other dead ends: the fix covered one dialog; `checkAndOpenStrategy` had two more that also stopped
  at "cannot open the strategy parameters". The action now lives in one place — `ui.researchAction()` returns the label
  and the message — and all three call sites use it. `showErrorPopup` accepts an action too. Two tests cover the shared
  action (label present, message `dz23:research:open` sent) and the error popup gaining the button, so the three call
  sites cannot drift apart.

- The dead end now offers a way out: the legacy dialog said "no strategy on the chart" and stopped there. It now carries
  an **"Open DZ23 Research"** button that opens the local lab, which backtests on the chart candles and needs no
  TradingView panel. `alertPopup` gained an optional action (button + callback); the background answers
  `dz23:research:open`. Four tests drive the dialog in the extension context (button only with an action, right label,
  click runs and closes, a throwing action does not freeze the dialog) and two cover the message, including that an
  unrelated type opens nothing. The test harness was missing `chrome.runtime.onInstalled` and `sidePanel`, so no test
  could load the service worker before — that gap is closed too.

- Replay of a running requestId is refused: two requests with the same id coexisted in the registry, so `POST /cancel`
  aborted only the second — the first kept streaming and had **no way to be cancelled**. §3.5 asks for replay
  protection; the duplicate is now a 400 "already running" that says why, and a test proves the duplicate is rejected
  *and* that the original is still cancellable (deterministic via the stall provider, not a timing race). Verified
  first that the rate limiter really answers 429 with `retry-after` — my grep had missed that test, so my own
  duplicate test was deleted instead of kept.

- Install manual written from executed commands (`docs/INSTALACAO.md`): every step was run here first — `gateway:dev`
  answered `status=ok, providers=9` and exited cleanly with its job, `host:install --dry-run` showed the ID derived from
  the manifest key, `test:e2e` finished **exit 0** against real Chrome. Corrections that came out of running them: the
  delivery doc told the reader to pass `--extension-id`, which is unnecessary and, with a wrong value, makes the host
  silently refuse the real extension — the doc now says not to. Prerequisites, the fixed-ID consequence and a symptom table
  moved into one file instead of being scattered.

- Secrets cannot be committed (`npm run audit:secrets`, in the gate): the first commit was checked by hand, and a manual
  check does not repeat itself. The audit fails when a forbidden path is tracked (gateway config, `.env`, key material,
  `node_modules`, `.zip`, the browser profile) or when tracked content matches a credential pattern — proven twice by
  injecting a fake `sk-…` key and a tracked `gateway/config.json`, both rejected, both removed, back to zero. Test fixtures
  are allowed only when the line says `probe`/`example`/`dummy`, so the allowlist stays short by design.

- DSR saturation is declared where it is read: round 74 proved the deflated Sharpe rounds to 1.000 for strong strategies,
  so "DSR 1.0" was inviting a confidence the statistic cannot support. `overfittingReport` now adds a **limitation** (not a
  warning — a healthy case must not look alarming) saying a saturated DSR cannot tell an excellent strategy from a merely
  strong one, and points to PBO and the out-of-sample comparison; a borderline DSR (>= 0.95) says more trials would lower
  it. The panel already renders `overfitting.limitations`, so the sentence reaches the screen.

- The prompt block carries its provenance, and its gaps: the indicators were right, but what the model *reads* had never
  been pinned. Eight assertions now hold it: source, timeframe, candle count and last candle time are declared; the numbers
  in the text equal the computed ones; an unavailable indicator is **omitted** rather than printed as `null` or zero (no
  `null`/`NaN` leaks into the prompt); the limitation names which indicator and which minimum; a short series says
  "indisponíveis" with the minimum; and the block instructs the model to label interpretation as interpretation.

- Indicators pinned by hand: SMA, EMA (alpha 2/(n+1) from the SMA seed), RSI (100 on all-up, 0 on all-down, ~50 on
  zig-zag), ATR (constant true range equals it; a gap raises it), Bollinger (population sigma, checked to 1e-6 against
  10.5 ± 2·5.7663) and VWAP (constant price; equal and unequal volume weighting) all match arithmetic done outside the
  code, and every one returns `null` — never a number — when the series is too short. No defect found; the value is that
  a wrong RSI would have been repeated confidently by the model, and now it cannot drift silently.

- Overfitting statistics verified independently: the deflated Sharpe was checked against a **hand-computed** case
  (SR 1, n 100, N 2 → SR0 0.051980, z 7.70195), the normal quantile against known values (Φ⁻¹(0.975) = 1.96), and the
  deflation by property — DSR falls from 1.0000 to **0.9269** as trials go from 2 to 1000, which is the whole point of
  deflating. PBO reports **0** when one strategy dominates every block and stays mid-range for indistinguishable series.
  No defect found this time; the value was proving it rather than trusting it. Two of my expectations were wrong again
  (PBO returns `pbo`, not `value`, and throws below 2 trials) — the code was right both times.

- False zeros removed from the risk metrics: hand-computing the whole Strategy Lab (net profit, averages, ratios, Sharpe
  annualization, Calmar, recovery factor) confirmed every number except one. **Exposure reported `0%` with no reason** when
  no trade carried `durationMs`/`exposureMs` — which reads as "never in the market" when the truth is "unknown". It now
  returns `null` with the reason. Recovery factor (money) and Calmar (percentage) deliberately use different drawdown
  denominators, and a test now pins both so a future edit cannot quietly swap them.

- Repainting detection completed: the Pine validator survived fourteen hostile scripts (empty, unicode, null byte, 20k-term
  line, 1 MB file, unbalanced quotes) without throwing — but a hostile *and valid* script showed a hole. §7 asks for
  repaint detection, and `varip` plus `calc_on_every_tick=true` — two classic repaint sources — produced **zero findings**.
  Both are detected now, with the word inside a comment excluded so a note does not become a false positive.

- Hostile storage probe, and two silences fixed: the config store was attacked with garbage records (null, a number, a
  string, an array), a future version, wrong field types, a partial record, a 2 MB record and a storage that throws. It
  survived all of it — but two things happened **without telling anyone**: `watchlists.lists` and `alerts.rules` were
  corrected with no entry in `issues`, and a storage that throws was indistinguishable from "no config yet", so the panel
  fell back to defaults in silence — exactly the mute-panel complaint this project started from. Both now report, and a
  regression test walks every hostile input.

- Native host survives malformed frames, and now refuses absurd ones: the probe pattern reached the one component that can
  spawn a process. Three cases, all green — invalid JSON is refused and the host keeps answering, a truncated frame waits
  for the rest instead of crashing. The third case found a real weakness: a header promising **2 GB** made the host wait
  **forever**, silently blocking every later message. It now refuses with the limit in the message and exits, so Chrome
  restarts it on the next message instead of leaving a mute process attached to the browser.

- The API probe became a gate (`npm run probe:api`): the script that found the last two defects was a temp file, so the
  gauntlet is now permanent — **21 malformed requests** against a real gateway with its own fake upstream, asserting the
  status *and* the error code for each. It immediately found two more: an unknown route and `GET /chat` answered
  **400 bad_request**, which tells the client "your body is wrong" when the path is. A `not_found` code with 404 exists now,
  and the test that pinned the old behaviour was corrected rather than deleted.

- Payload validation tightened, found by an API probe: nine of ten malformed requests were already refused correctly, but
  `role: "hacker"` (or a missing role) was **silently coerced to `user`** — the caller's intent rewritten in flight, and a
  `tool` message would have become plain text. Roles are now validated against `system`, `user`, `assistant` with a clear
  error, plus a regression test that walks the bad values.

- Sofia against a real model, and a silent parameter fixed: phase 3 runs the three specialist roles through the local model
  — **3/3 verdicts satisfy the JSON contract**, all `baixa`, consensus with agreement 1.0. Getting there exposed a real
  API defect: `/chat` **ignored `stream: false`** and answered SSE, so a client asking for JSON received events and no
  error. The route now rejects the parameter with "always streams" (with a test), and the smoke consumes SSE like the
  panel does. Two of my own mistakes on the way: I flattened the verdict shape `crossValidate` expects, and my first test
  had a silent skip that would have hidden everything.

- Cancellation proven against a real model: `smoke:live` now has a second phase — start a long generation, wait for the
  first token, `POST /cancel`, and assert the stream stops with the `cancelled` event. Against a fake upstream this proves
  little because the answer ends instantly; against a slow local model it exercises the real abort path. Measured: 117
  characters received before cancelling, cancel accepted, stream cut, one event in the tail.

- Real model, real gateway (`npm run smoke:live`): every other test uses a fake upstream, because a paid call must not
  happen without authorization — a **local Ollama** is not a paid call, so the chain is now exercised end to end with a
  real model: gateway process, provider HTTP, streamed tokens, gateway events. Measured **19 s · 86 events · 230 chars**
  with qwen3:8b, answering from the RSI our own module computed (43,82) and separating fact from interpretation. It proves
  plumbing and streaming, not answer quality; without Ollama it declares a skip and exits 0, so absence never reads as a pass.

- Language declared per surface: the popup and legacy content scripts read 196 catalog keys in `en` and `pt_BR`, while the
  panel, settings and research pages were hardcoded Portuguese — in an English Chrome the product looked half translated,
  and `i18n:check` never asked whether a surface was localized **at all**. The three DZ23 surfaces are now declared pt-BR
  on purpose, and the check fails both when an undeclared surface appears without the catalog and when a declared one
  starts using it. Both directions were proven by injecting the violation and removing it.

- One command for the whole cycle: `npm run verify` chains the evidence gate, the package, the artifact check and the
  report-number check, so the next session reproduces the delivery with one line. Building it exposed a real mismatch:
  `release:pack` ran **without** `--offline --dev` and died on a "git working tree not clean" warning — a state this
  repository is in by design (no commits). Both release scripts now carry the flags the gate uses.
- Dependency advisory made precise instead of vague: the affected range is `minimatch <11.0.1`, eslint 10.x pins
  `^10.2.x` and **eslint 11 was never published** (latest 10.14.0), so it cannot be fixed today. The suggested "fix" is a
  downgrade to eslint 4.0.0, refused; dev-only, nothing ships. The risk row now states the condition that resolves it.

- Evidence is content-hashed: the staleness check compared the acceptance timestamp with file mtimes, and `audit:mutation`
  rewrites and restores modules — so the report looked stale forever after every mutation run. `accept` now records a
  **sha256 of the extension code** it proves, and the check compares hashes, which is the honest question ("does this
  evidence describe this code?"). The mutation harness also restores the original mtime, so a read-only audit leaves no
  trace at all.

- Report numbers verified against the artifact (`npm run audit:numbers`): the document is now checked, not trusted — ZIP
  entry count, manifest version, gate count, and whether `docs/ACEITACAO.json` is **older than the newest change under
  `extension/`** (a stale acceptance report is the quiet version of a false claim). On its first run it found the gate
  count off twice: the doc said 22, the gate had 26; then adding this very check made it 27 and it flagged itself.

- Numbers in the report re-measured: the delivery matrix claimed **97,8%** coverage; the script said **94,17%**. Not lost
  tests — the suite now imports the audit tools (`package`, `gate`, `mutation`, the dz23 sender) to prove they reject what
  they should, and those files count. Reporting 94,17% instead of excluding them is the honest choice, and `COBERTURA.md`
  explains the drop. Same sweep corrected the perf numbers (447,5 → **457,1 KB** eager; pages 51/65 ms → **58/66 ms**,
  91/167 → **96/172 KB**) and the accessibility count (6 → **7 passos**, 5 live regions).

- Docs match the product again: `CONFIGURACAO.md` described a settings screen with three sections while it has eight, and
  said nothing about what deliberately stays in the panel — §3.2 lists strategies, indicators and chart preferences among
  settings, and they are per-conversation. The section now carries the real table, the "what is not here and why" table,
  and the key both surfaces share. `TESTE-MANUAL.md` still told the user to copy the extension ID into the allowlist and
  paste a token; it now installs the host, relies on the fixed ID and pairs automatically, with four new checks
  (auto-pairing, offline guidance, memory section, usage table). `NATIVE-HOST.md` drops the required `--extension-id`.

- Memory on the single screen: §3.2 lists memory among what the one settings screen consolidates, and it lived only in
  the panel dialog. The screen now lists every namespace (user · strategy · note count) and clears one with a
  confirmation, reading the same keys the panel writes. The first version printed `smc · sem estratégia` because the key
  parse skipped one field too many — the E2E assertion caught it. Also verified, not assumed: the memory→prompt loop was
  **already** covered by the panel E2E, so the duplicate assertion I had written was removed instead of kept as noise.

- Export audit settled: `describeRanking` was reimplemented in the settings screen and now comes from the module (one
  format for the CLI and the UI); the remaining seven exports carry a **stated reason** in the audit instead of being
  listed as dead or quietly dropped — each one says what data or caller would be needed, which is the honest version of
  "not wired". `nowhere` is empty and the audit exits green with `problems: 0`.

- Overfitting report concluded: the CLI computed PBO, DSR, Monte Carlo and walk-forward separately and never built the
  report that ties them together. It now splits the return series chronologically (70/30), runs `overfittingReport` and
  prints the verdict with degradation and the module's own warnings — `Relatório de overfitting (collapsed): IS 0.2569 →
  OOS 0.0322 (87% de degradação)` plus `oos_collapsed`. Also deduplicated: the panel uses `findConversation` and
  `mostRecent` instead of its own inline equivalents, so deleting the active conversation now lands on the most recent
  one rather than whichever came first in the array.

- Provider env consolidated: the server read `providers.env` with a raw `readFileSync`, so a wrong path surfaced as
  `ENOENT`; it now uses the exported `loadProviderEnv`, which answers "could not read DZ23_PROVIDER_ENV at …". Two gateway
  tests cover the missing and the valid file. The last two unused exports are now named as justified library API in the
  audit itself (with reasons) instead of being silently dropped — and the auditor no longer counts its own allowlist text
  as a usage, which is how they had briefly disappeared from the report.

- Dead exports audited (`npm run audit:exports`): 218 exports separated by who uses them. Four announced capabilities had
  no product consumer — PBO/DSR, Monte Carlo, walk-forward and the candles-chart match — and two declared limits were
  never applied. All wired: `strat:compare --montecarlo --walkforward` computes both from the return series, the panel
  discards candles whose symbol/exchange/timeframe disagree with the chart, each indicator respects its own minimum
  (`INDICATOR_LIMITS`) instead of reporting MACD from 15 candles, and `canAddList` enforces `MAX_LISTS` where lists are
  created.

- PBO/DSR finally called: `extension/quant/overfitting.mjs` implements CSCV overfitting probability and the deflated Sharpe
  ratio, has tests, and **nothing imported it** — the delivery matrix claimed PBO/DSR on the strength of an unused module.
  `npm run strat:compare` now computes both when the input carries per-trial `returns` / `sharpe`+`observations`+`trials`,
  prints `PBO: N% (CSCV · combinations, blocks)` and the DSR, marks a high PBO as "compatible with luck", and states
  exactly which field is missing when it cannot compute. Four CLI tests, including the honest no-data path.

- Rollback rehearsed, not assumed: the backup check compiled every restored script and stopped there. It now restores
  the whole tree into a temporary directory and runs the suite that came **with the backup** — 49/49 tests pass on the
  restored copy. A rehearsal that runs **zero** tests is rejected (the empty-glob lesson, applied to rollback), and the
  child process gets a clean environment: nested `node --test` inside a test run silently skips files, which is exactly
  how this hid. Three tests prove a broken backup is refused.

- Security scan covers the runtime: it only walked `extension/` — the modules that actually handle tokens (`gateway`,
  `native-host`, `dz23`, `mcp`) were never scanned. Scope widened (71 code files, 9 rules, plus a rule against cleartext
  http in the runtime). The token-in-log rule was a name heuristic that both missed `console.log(token)` and flagged
  help text; it now strips string/template literals and keeps only `${...}`, calibrated against five real leak shapes and
  two legitimate ones — and the two security mutants live in `audit:mutation`, so the calibration cannot rot.

- Package inspected from inside (`npm run audit:package`): every check looked at the source tree, never at the artifact.
  The ZIP is now opened and validated — manifest parses, every referenced file exists inside it, no test/secret/credential
  travelled along, no empty entry, `key` present. Five tests make it fail on purpose-built broken packages, and one of
  them exposed that the release helper ignored `background.service_worker`, `side_panel` and `options_ui` — three files
  whose absence breaks the extension while every check stayed green. Helper fixed.

- Real launcher tested: every host test spawned `node host.mjs` directly, so the `.cmd` Chrome actually executes was
  never exercised — and Windows quoting is exactly where that file breaks. The new test runs `cmd.exe /c dz23-host.cmd`
  with the 4-byte framing and verifies the reply, the echoed id, the absolute node path and that an unknown type answers
  an error without dying.

- Stable extension ID: the manifest had no `key`, so the ID was derived from the install path — while the native host
  `allowed_origins` and the gateway allowlist hardcoded one ID. Move the folder and the host silently refuses the
  connection, killing the automatic pairing exactly where it matters. A public key is now pinned, the ID is
  `ejmflepgfmffgicdjdaigdfdcacehgma` everywhere, the installer derives it instead of asking, and a test asserts host,
  gateway and extension agree.

- Pairing in production: `/token` is dev-only, so outside dev the panel still asked the user to paste a token by hand —
  exactly what §3.4 forbids. The native host now answers a `token` request (stdio only, never in status/logs) and the
  panel falls back to it and stores the result in the shared record. The first-run hint said "paste the token in ⚙"; it
  now states the truth: automatic with the host, manual otherwise. E2E asserts the hint is hidden online and shown
  offline with actionable text.

- Mutation check (`npm run audit:mutation`): a suite that passes against a broken module proves nothing. Six critical
  behaviours are broken on purpose — chart action verification, config validation, alert fire-once, provider fallback,
  RSI, agent verdict contract — and the suite must FAIL each time. **6/6 mutants killed**, file restored with a hash
  comparison so a crash cannot leave the repo mutated.

- Every control acts (§13): `npm run audit:controls` extracts the interactive ids of the four pages, strips HTML
  comments and requires each control to be referenced by some script — a button with no listener is a promise the
  product does not keep. 73 controls, 0 orphans; the single commented-out legacy button is reported as information.

- Experiment sender: the ingest service accepted `POST /experiments` since it was written, and **nothing in the product
  sent one** — a receiver with no sender, breaking the research → agents hand-off. `npm run dz23:send` validates the file
  locally, posts it, reads the stored copy back and exits 0 only when the accepted hash equals the stored one. 5 tests
  against a real server; `docs/DZ23-INGEST.md` documents the flow.

- Popup options go through the record: the bridge already exposed `saveOptions` (writes `dz23.config.v1` **and** mirrors
  `iondvOptions`), but the popup never called it — it wrote the legacy key directly, leaving the shared record stale while
  the bridge could mirror the stale value back over the fresh choice. Both popup paths now use one persistence helper,
  with a declared fallback when the bridge is absent. Two structural tests lock it: no legacy write outside the helper,
  and the bridge never writes only one of the two keys.

- One acceptance authority: the acceptance report kept its own copy of the commands and drifted from the real sweep
  twice (a suite that moved, a wrong path). `npm run accept` now runs the single gate and maps its 22 verdicts to the 16
  §17 criteria, recording the gate, the test count and the time in `docs/ACEITACAO.json`. `docs/ACEITACAO.md` was
  rewritten to that structure instead of describing an older 14-row list.

- Gate with evidence (`npm run audit:gate`): the sweep became a program that demands proof from every command — a minimum
  number of tests per suite and an output marker per script. It caught its own first run: `lint` could not spawn npx
  without a shell, the gateway minimum was a wrong guess (42, not 50), contrast prints a plain summary and `npm audit`
  reports **4 moderate advisories** (eslint → minimatch, dev-only) that `--audit-level=high` correctly ignores but that
  were silently absent from my reports. Now 22 gates, 567 tests, all PASS, and the moderate advisories are documented
  instead of implied to be zero.

- Package hygiene (`npm run audit:orphans`): every file in the extension must be reachable from the manifest, an HTML tag,
  a static import, or a `getURL` reference — including consumers outside the extension (CLIs, gateway, mcp). It found the
  quant test files shipping inside the package; they moved to `_aitna/tools/extension-tests/`. Now 66 files, 60 references,
  0 orphans and 0 broken references, and the ZIP no longer carries tests.

- Settings reachable the standard way: the single settings screen existed but was not declared as the extension's
  options page, so Chrome's "Options" entry had nothing — it could only be opened from the popup gear or the panel
  link. `options_ui` now declares `settings/index.html` (`open_in_tab: true`) and both entry points call
  `chrome.runtime.openOptionsPage()` with the old tab creation as fallback. New `manifest-surfaces` test locks the doors:
  every surface has a declared entry and every file the manifest references exists.

- Usage is visible in the settings screen: the gateway recorded attempts, failures, average latency and tokens per provider
  since round 25, but nothing read it. The Diagnóstico section now shows a table from `GET /usage` (loaded on open when a
  token exists and refreshed by the diagnose button), with an explicit empty state and the note that restarting the
  gateway resets it. A third capability rescued from being dead code.

- Fallback reaches the panel: the gateway supported provider fallback with 13 tests, but the panel never asked for it —
  the capability was dead code in the product. `/chat` now sends `fallback: true` for the chat **and** for each Sofia
  specialist (the E2E immediately proved Sofia was left out), a `notice` event names the switch, and the finished message
  carries the answering provider from the gateway instead of echoing what was requested. The E2E runs with the default
  provider pointing at a 500 upstream and proves the swap through the `/usage` ledger: `openai failed=1 · openai-compatible ok=1`.

- Memory reaches the specialists: the strategy notes the user recorded already went into the chat prompt but not into
  Sofia's plan, so the same panel answered differently depending on the button. `planRun` now accepts `memoryNotes`,
  `agentPrompt` renders them labelled as user-provided context (not market fact), empty notes are dropped and only the
  10 most recent are kept — the same truncation the memory module already applied.

- Memory isolation locked by tests (`extension/copilot/memory.js` at 100% statements): the namespace contains user *and*
  strategy, so one user never sees another's notes or strategy list; a storage that refuses to write returns a reason
  instead of breaking the chat; corrupt entries are dropped; note count/length limits truncate; and the real browser
  path (default localStorage, including one that throws on access) is covered.

- Capital-based metrics tested by hand (annualized return, time exposure, Calmar) and config repair locked by tests:
  +21% over two years is 10.0% per year (not 10.5 — compounding, not division), exposure is 50% for half the period and
  reports overlap as-is, Calmar is null without a denominator. Config repair now has proof that an invalid `gateway`
  resets to defaults while preserving user and alert rules, and an invalid `ai` preserves gateway and token.
  `extension/lib/config.js` and `extension/quant/metrics.mjs` both reached 100% statements.
- Capital-based metrics tested by hand (annualized return, time exposure, Calmar) and config repair locked by tests:
  +21% over two years is 10.0% per year (compounding, not division), exposure is 50% for half the period and reports
  overlap as-is, Calmar is null without a denominator. Config repair now proves that an invalid gateway resets to
  defaults while preserving user and alert rules, and an invalid ai preserves gateway and token.
  extension/lib/config.js and extension/quant/metrics.mjs both reached 100% statements.
- Storage resilience (found by writing the uncovered-path tests): a storage that never calls its callback used to hang
  the panel boot forever — reads and writes now have an 800 ms deadline, the two legacy reads run in parallel and a
  timed-out storage skips the migration write with a visible issue (worst case 1.6 s instead of infinite). A config
  stored as JSON text was rejected as "not an object" and the user data discarded; it is now parsed, validated and
  rewritten as an object. `extension/lib/config.js` branches went from 73.6% to 83.5%.
- Coverage measurement (`npm run test:coverage`, c8 over the pure-module suite): 96.79% statements, 75.19% branches,
  85.13% functions, with thresholds 92/68/80 so a regression fails the command. The measurement exposed
  `montecarlo.mjs` at 31% — the module behind the Strategy Lab Monte Carlo claim — and 11 new tests took it to 100%,
  including the real bootstrap property (E[n draws] = n x mean) after my first assertion got it wrong.
- Performance budgets with real measurements (`npm run perf:check`, `npm run perf:pages`): eager JS 447.5 KB against a
  600 KB budget, content scripts 198.7 KB against 300 KB, and both real pages load in 51-65 ms transferring 91-167 KB.
  The 3.5 MB 3D chart library stays lazy and the check fails if any HTML references it or any eager module imports it
  statically. Documented in `docs/DESEMPENHO.md`.
- Acceptance report (`npm run accept`): every §17 criterion is a command that runs here, with the verdict recorded in
  `docs/ACEITACAO.json` (command + duration per line) and explained in `docs/ACEITACAO.md`. 14 internal checks PASS;
  2 EXTERNAL (paid MCP plan, the owner's Chrome reload) and 2 ABSENT (chart drawing, news/fundamentals) are declared
  instead of hidden. The runner calls node directly because `npm.cmd` needs a shell on Windows — the first version
  produced five false FAILs and was fixed.
- Candlestick patterns (doji, hammer, shooting star, marubozu, bullish/bearish engulfing, inside bar) detected from pure
  OHLC geometry, each with the rule that fired, inside the market summary and the prompt block, labelled "formato, não
  sinal". Specific rules are evaluated before doji, so a small-bodied hammer is not misread as indecision. 4 tests.
- Asset comparison in the panel: a second symbol field next to the timeframe comparison compares it with the chart asset
  on the same timeframe, refuses the same symbol on both sides and states the relative-strength rule. E2E covers both
  the table and the refusal.
- Asset comparison (`npm run compare-assets -- BTCUSDT ETHUSDT --tf 1h`): price, trend, RSI zone, ATR%, change, VWAP
  distance and relative volume side by side, a declared relative-strength rule, per-metric winners and a caveat when
  sources differ. Missing data is reported, never zero-filled. 9 tests; executed on real candles.
- Alert editing: changing type or threshold re-arms the alert (the old condition no longer describes what the user wants)
  while editing only the note keeps the state; validation stays in the module, not duplicated in the UI. Inline editor in
  the settings screen; 14 unit tests and 13 E2E steps.
- Provider fallback and usage ledger (`gateway/fallback.mjs`): `/chat` accepts `fallback` (true or an array); the gateway
  switches provider only when the failure is the provider's and no text was delivered yet (a partial answer is never
  duplicated), announces the switch with a `notice` event and records every attempt. New `GET /usage` reports per-provider
  attempts, failures, average latency and tokens over a bounded window. 11 unit + 2 HTTP integration tests.
- Backup and rollback rehearsal (`npm run backup`, `npm run backup:check`): a snapshot is copied (177 files, no
  node_modules), then the verifier restores it into a temp directory, compiles every restored script (51/51), checks
  the files the manifest references (18/18) and reports the delta against the working tree plus a concrete rollback plan.
  It accepts older layouts (a manifest without a background worker) instead of failing them.
- Security invariants as a build rule (`npm run security:check`, 8 rules over 60 files): no cookie access, minimal
  permissions (only `*.tradingview.com`), no `eval`/`Function`, no literal secret patterns, explicit CSP, no remote
  script, every network host declared, token kept out of logs. It found a missing CSP declaration, which is now set
  (`script-src 'self'; object-src 'self'`).
- Documentation consistency check (`npm run docs:check`): every `npm run <script>` and every cited file in README and
  docs/ must exist. It found 15 real contradictions (stale popup paths instead of `extension/content_scripts/`, a
  deleted bridge file, a non-existent `quant/FORMULAS.md`) and they were fixed — 12 documents, 77 commands, 48 file
  references, all real.
- Strategy comparison (`npm run strat:compare`): refuses unequal periods or cost assumptions (exit 1), ranks by one
  declared metric and quantifies selection bias with E[max of N standard normals] (≈0.56σ for 2, ≈1.54σ for 10) plus the
  metric spread. Reads versioned experiments or plain candidates; 11 tests. Documented in `docs/STRATEGY-LAB.md`.
- Pine explanation/documentation (`npm run pine:explain`): the validator findings are printed as facts and the model
  text as interpretation, with the four required sections (what it computes, inputs, repainting/look-ahead, what cannot
  be concluded). Live run on a real script; 7 contract tests. Exits 1 when the script does not validate.
- Accessibility pass (`npm run test:a11y`, 6 checks in headless Chrome): every visible button has an accessible name,
  every field has a label, status messages are live regions, Tab moves focus with a visible 2px ring, and sampled text
  contrast meets WCAG AA. Focus-visible styles and reduced-motion support added to both surfaces.
- Pine generation with validation (`npm run pine:gen`): the model answer is reduced to the Pine block, then the same
  linter decides — approved output is printed with its report, rejected output is printed with findings and exits 1.
  Prompt forbids look-ahead and demands v5 plus costs. Live run produced a valid v5 RSI approved with 0 warnings;
  8 contract tests. Without `--live` nothing is sent to a provider.
- Market Intelligence extended: RSI series, **divergence** between price and RSI (two pivots, four numbers cited, marked
  as fact) and multi-timeframe comparison (`npm run compare -- BTCUSDT 15m,1h,4h`) with trend alignment, relative ATR
  and divergences per timeframe. 9 new tests; comparison exercised on real candles.
- Market Intelligence extended: RSI series, divergence between price and RSI (two pivots, four numbers cited, marked as
  fact) and multi-timeframe comparison (`npm run compare -- BTCUSDT 15m,1h,4h`) with trend alignment, relative ATR and
  divergences per timeframe. 9 new tests; the comparison was exercised on real candles.
- TradingView official MCP adapter (`mcp/`): discovery of the real endpoints, public-client dynamic registration,
  PKCE S256, local loopback callback with state validation, token refresh and a JSON-RPC client that accepts JSON and
  SSE and turns a 401 into AuthRequired (no blind retry). 16 contract tests. The server itself refuses with
  "É necessário um plano pago" on this account, so authorization is recorded as BLOCKED_BY_EXTERNAL_DEPENDENCY.
- TradingView official MCP adapter (`mcp/`): real discovery (401 + resource metadata, authorization server), public-client
  dynamic registration, PKCE S256, loopback callback with state validation, token refresh, and a JSON-RPC client that
  accepts JSON and SSE and turns a 401 into AuthRequired without blind retry. 16 contract tests. The server refuses with
  "É necessário um plano pago" on a free account, so the authorization is recorded as BLOCKED_BY_EXTERNAL_DEPENDENCY
  in `docs/MCP-TRADINGVIEW.md`.
- Watchlists and DZ23 alerts in the settings screen: lists with add/remove/compare, a ranked opportunities view
  with a stated rule, and alert rules (price/RSI/percent) that fire once per crossing, honour a cooldown and are
  evaluated on demand. Scope is stated on screen: they are not TradingView alerts, which have no public API.
  `watchlist-alerts.test.mjs` (11) and the settings E2E (11 steps, alert really fires).
- Sofia in the panel: one button runs the specialists over the current chart with the metrics already computed,
  appends the cross-validated summary and its trace, and refuses to run without candle evidence. The E2E clicks it
  against a fake provider that answers the JSON contract.
- Agent orchestration (`extension/lib/agents.js` + `npm run agents`): deterministic plan by question, strict JSON
  contract per specialist, cross-validation that refuses to call a tie "consensus", one retry and a per-agent timeout,
  full trace. The prompt carries the computed **values** (a live run proved that names alone make every agent answer
  "inconclusivo"). 13 tests; `docs/AGENTES.md` records a real run against DeepSeek.
- Market Intelligence (`extension/lib/marketIntel.js`): SMA/EMA, RSI(14), ATR(14) with % of price, MACD(12,26,9),
  Bollinger(20,2), VWAP, swing structure (pivots need two neighbours), Fibonacci levels and a fixed trend rule — all
  computed from the same candles the prompt carries, with source, sample size, last candle time and explicit
  limitations. 13 tests with hand-checked series. The chart dialog now shows context, candles and metrics from one
  source, so the numbers never disagree.
- Chart actions (`extension/lib/chartActions.js`): symbol and timeframe changes built from the chart URL, applied by
  the worker (only tradingview.com/chart URLs) and **verified by re-reading the chart**, never by "the click was sent".
  12 tests; the E2E applies ETHUSDT/15m and asserts the confirmation text.
- Pine Script linter (`extension/quant/pine.mjs` + `npm run pine:check`): 17 findings covering declaration,
  version, syntax, look-ahead (`barmerge.lookahead_on`), future references (`close[-1]`), deprecated calls and a
  strategy that claims performance without costs or without an exit. 13 tests.
- One configuration service (`extension/lib/config.js`): `dz23.config.v1` in chrome.storage.local is the single
  source of truth for gateway, token, provider, model and user; both legacy shapes (`dz23.copilot.v2`,
  `iondvOptions`) are migrated once, idempotently, and kept. 14 tests cover migration, repair and the popup bridge.
- Native Messaging host (`native-host/`): starts the gateway on demand, detached so it survives Chrome closing the
  channel, and refuses to stop a gateway it did not start. `npm run host:install` registers it for one extension ID
  under HKCU (no elevation); provider keys are read from `~/.dz23/providers.env` or `HKCU\Environment`.
- `background.js`: probes the tab and re-injects the chart bridge after an extension reload.
- Tooling: `test:bridge` (real content script against a TradingView-shaped DOM) and
  `_aitna/tools/e2e/contrast-audit.mjs` (WCAG contrast per tab).

### Fixed
- Popup and copilot now share one visual identity (dark surface, teal accent, system type, DZ23 brand).
- Switch labels ("Mais"/"Menos") measured 1.58:1 on the dark surface; restyled to WCAG AA and no longer clipped.
- A failed answer was written into `#messages` and wiped by the next render: errors persist with a dismiss action.
- `[hidden]` was overridden by `display:flex`, stacking the empty state over the conversation (two scroll areas).
- Composer no longer shows a native scrollbar.
- Chart bridge: parses "15m"/"1h" timeframes, reads the interval from `[data-name="timeframes-menu"]`, falls back to
  `/chart/<symbol>/`, and includes indicators in the change key.

## 2.16.0
- **New:** DZ23 Copilot in the browser side panel: chat with the AI provider you configured, streaming answers,
  conversation history, stop, regenerate, copy, rating, and the trading context that is sent to the model shown
  before sending.
- **New:** local DZ23 AI Gateway (`npm run gateway`): keeps the provider credentials, and speaks OpenAI,
  Anthropic, Gemini and OpenAI-compatible endpoints, including Ollama (local and cloud) and OpenRouter. Token
  authentication, rate limit, timeout, cancellation, and no key in the browser or in a log.
- The popup gained an "Open copilot" button.

### Details
- The gateway binds `127.0.0.1` only, refuses to start without a token, accepts only `chrome-extension://` and
  `127.0.0.1`/`localhost` origins, and reports a provider without a key as *not configured*, never as connected.
- One normalized event stream for every provider (`start`, `delta`, `usage`, `done`, `cancelled`, `error`) so the
  panel does not depend on any single provider. A request that cannot be routed is refused before the stream
  starts.
- Providers, their credential variables and the configuration file are documented in `gateway/README.md`. The
  copilot never receives a key: it calls the local gateway with a token stored in the panel settings.
- No provider was tested against its live API in this environment (no credentials): the integration is
  implemented and tested against a simulated provider over real HTTP, and `/test` is the live check to run with
  your own key.

## 2.15.0- Portuguese (Brazil) interface: the popup, alerts, status messages and the parameters window follow the
  browser language. English is still the default, and any other language keeps the English text.
- **New:** the extension name and description are localized as well, in the browser's extension list and in the
  store listing.
- Faster chart page: the 3D chart library (3.6 MB) is downloaded only when the 3D chart is opened, not on
  every TradingView page.
- **Fixes:** the Annealing method ran its first cycle with a parameter set named "message"/"data"; a message
  from a look-alike domain could reach the bridge between the page and the extension; deleting a stored entry
  could look for the wrong key; the alert header was drawn with an invalid color; the "download results without
  waiting for OK" option was forgotten when it was the only change; a tab outside TradingView showed the wrong
  warning; the Max/Min label and long status toasts were cut for longer text; the CSV reader added an empty
  column to every parsed row.
- "Clear all" now asks for confirmation before deleting every stored result and parameter set.
- Tabs can be reached and switched with the keyboard, and buttons no longer clip a longer translated label.
- **New:** the extension logic has a test suite that runs without a browser (`npm run test:ext`) and a lint
  gate (`npm run lint`); both run on every push.

### Details
- Every user-facing text lives in `extension/_locales/<locale>/messages.json` and is read through `chrome.i18n`,
  so one build ships every language. `npm run i18n:check` fails when a text is used but missing, when a
  translation drops a placeholder, or when a text is no longer used.
- The tests load the real content scripts into a Node `vm` context with the page, storage and localization
  stubbed, so the optimization methods, the parameter ranges, the CSV reader and the message bridge are covered
  without a browser. The lint rules are the ones that catch a defect here: an undefined identifier, an implicit
  global, a duplicate key.
- TradingView report metric names, the exported CSV content and the per-test `comment` column stay in English:
  they mirror the English TradingView UI, and the run statistics match that column by exact text.
- Failures reported by the chart API (`page-context.js`) stay in English: that script runs in the page itself,
  where `chrome.i18n` does not exist.
- To add a language, copy `_locales/en/messages.json` to `_locales/<locale>/`, translate the values and keep the
  keys and the `{0}`, `{1}` placeholders.

## 2.14.0
- Supports the redesigned Strategy Tester (2026-10: metrics shown as cards).
- Faster and more reliable reading of results from TradingView report data; about 1 s less per test.
- **New:** option "Also parse the report tabs" (Options & Tools) for metrics missing from TradingView data.
- **New, experimental:** option to set strategy parameters through the TradingView chart API, faster than the
  strategy dialog. TradingView may change this API, and automated use may violate its terms: use at your own
  risk.
- Clearer error messages: what happened and what to do; when TradingView changed its UI, how to report it on
  GitHub and what to attach.
- **Fixes:** parameter sets with no trades, Min mode, metric value 0, ranges where "from" equals "to", empty
  report tabs, signals indicator.
- Popup: the header and tabs stay in place, long tabs scroll, and this "What's new" notice after updates.

### Details
- Results are read from TradingView's own strategy data; if that fails, the extension parses the report page
  for the rest of the test run and tries the data again on the next run.
- "Also parse the report tabs" matters only when results come from TradingView data: when the report page is
  parsed, all tabs are read anyway.
- The chart API option sets what it can and leaves the rest (e.g. a source taken from another indicator) to the
  settings dialog for that test. It uses a TradingView API that is not documented for this use, hence off by
  default and experimental.
- A parameter set with no trades is kept in the results as "No trades for these parameters" and filtered out,
  so it never becomes the best result.
- For a bug report: open the console (F12), filter by `[tv-assistant]` and enable the "Verbose" level to
  include the per-test detail.

## Auditoria de 2026-10-30 (v2.16.0)

Correções aplicadas e verificadas na mesma versão, sem quebrar o contrato de versão do release check.

- Anexos religados: `#attach`/`#files` sem listener (o botão não abria nada); `renderChips` usava `chips`
  inexistente e um `setAttribute` corrompido; o texto juntava anexos com `\\n\\n` literal.
- `setStatus` (função da página de pesquisa) trocado por `renderStatus('bad', ...)` no copiloto.
- `ctxMemory`/`ctxStrategy` como identificadores soltos no diálogo de contexto (ReferenceError).
- Memória passou a ser gravada em `(usuário, estratégia)` ao aplicar o contexto e entra no prompt.
- `index.html`: três blocos com a sequência literal `` `n `` no lugar de quebras de linha.
- `DZ23_GATEWAY_CONFIG` era ignorado pelo entry point; agora é lido.
- Lint: 0 erros / 0 avisos — `setInterval`, `clearInterval`, `AbortController`, `TextDecoder` nos globais de Node;
  remoção de código morto (`isSequential`, três duplicatas `optAnnealingGet*`, `lastSetResult`, imports sem uso).
- E2E no Chrome com gateway real e provedor fake local: 16 verificações (anexos, recusa de binário, contexto e
  memória após reload, streaming, cancelamento, markdown, mobile, histórico) — `npm run test:e2e`.

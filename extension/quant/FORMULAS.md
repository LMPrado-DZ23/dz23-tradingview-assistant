# Quant research — formulas and conventions

Version of this document: `1.0.0` (matches `metricVersion` in `metrics.mjs` and `researchVersion` in
`research.mjs`).

## Input

A trade is `{ pnl, durationMs?, exposureMs? }`. `pnl` is the **net** result in account currency: commission,
spread and slippage are expected to be subtracted by whoever produced the trade. The engine does not add costs
of its own; a `pnl` that is not a finite number is rejected, never treated as zero.

Conventions:

- **Sign:** profit is positive, loss is negative. A `pnl` of exactly 0 is a *breakeven* trade: it counts in the
  total, is neither a win nor a loss, and does not enter the win rate numerator.
- **Order:** a list of trades is chronological. Nothing in this engine sorts, shuffles or deduplicates it.
- **Missing data is `null` with a `reason`.** A percentage of an unknown capital, a ratio with no losing trades or
  a standard deviation of a single observation are `null`, not `0` and not `Infinity`.

## Metrics (`computeMetrics`)

| metric | formula | needs |
|---|---|---|
| `netProfit` | Σ pnl | ≥ 1 trade |
| `grossProfit` / `grossLoss` | Σ positive pnl / Σ negative pnl | ≥ 1 trade |
| `profitFactor` | grossProfit / abs(grossLoss) | at least one losing trade, else `null` |
| `winRate` | wins / trades × 100 | ≥ 1 trade |
| `expectancy` | netProfit / trades | ≥ 1 trade |
| `averageWin` / `averageLoss` | mean of positive / negative pnl | the respective side present |
| `averageWinLossRatio` | averageWin / abs(averageLoss) | both sides present |
| `maxDrawdown` | max (peak − equity) over the equity curve | ≥ 1 trade |
| `maxDrawdownPct` | max (peak − equity) / peak × 100 | a peak > 0 |
| `recoveryFactor` | netProfit / maxDrawdown | maxDrawdown > 0 |
| `sharpe` | mean(r) / s(r) × √periodsPerYear, s = sample std (n−1) | ≥ 2 observations, s > 0 |
| `sortino` | mean(r) / d(r) × √periodsPerYear, d = √(Σ min(r,0)² / n) | d > 0 |
| `annualizedReturnPct` | ((1 + netProfit/capital)^(1/years) − 1) × 100 | capital > 0, period > 0 |
| `calmar` | annualizedReturn / abs(maxDrawdownPct) | both available |
| `exposurePct` | Σ exposureMs / totalPeriodMs × 100 | totalPeriodMs > 0 |

`sharpe` and `sortino` are **per trade** unless `periodsPerYear` is given (then annualized by ×√periods). The
risk-free rate is a per-period constant, default 0. Percentiles use linear interpolation between neighbours.

## Split and walk-forward (`research.mjs`)

- `splitChronological(items, isRatio)`: the first `floor(n × isRatio)` items are in-sample, the rest is the
  holdout. No shuffle: a shuffle would put the future before the past.
- `walkForwardWindows(n, { trainSize, testSize, step, anchored })`: window *i* trains on
  `[start, start+trainSize)` and tests on the immediately following `[start+trainSize, start+trainSize+testSize)`.
  The test part never belongs to its own train part. `step` defaults to `testSize` (non-overlapping tests);
  `anchored` expands the training window from the first observation.

## In/out-of-sample comparison (`compareInOut`)

`ratio = oos / is` for a "higher is better" metric. Verdict:

| ratio | verdict | meaning |
|---|---|---|
| ≥ 0.70 | `stable` | the holdout keeps at least 70% of the in-sample result |
| 0.30 – 0.70 | `degraded` | the result depends on the period it was fitted on |
| < 0.30 | `collapsed` | treat the strategy as unvalidated |
| in-sample ≤ 0 | `unknown` | the ratio has no meaning; the reason is reported |

These thresholds are a **reporting convention**, not a statistical test.

## Parameter robustness (`parameterRobustness`)

The grid axes are the sorted distinct values of each parameter; a *neighbour* differs by exactly one step in one
dimension (a real grid adjacency, never a numeric coincidence).

- `stability` of a point = mean(neighbour values) / value. A plateau has stability near 1; a lone peak near 0.
- `isIsolatedSpike`: the best point's neighbours average below `thresholdRatio` (default 0.8) of it.
- `plateau`: the connected region, through neighbours, with value ≥ `thresholdRatio × best`. `plateauShare` is
  its fraction of the grid.
- `robustnessScore`: `min(1, 2 × plateauShare)`, halved when the best point is an isolated spike.

A robust choice is the best point **inside** a wide plateau, not the absolute best point.

## Monte Carlo (`runMonteCarlo`)

Resampling of the realized trades, with replacement: `blockSize = 1` resamples single trades (i.i.d. assumption);
`blockSize > 1` resamples consecutive blocks, which keeps part of the streak dependency. The simulation answers
"how differently could these same trades have been ordered?", not "what will the future be". A seeded PRNG makes
a report reproducible. `probabilityOfRuin` counts runs whose final equity falls to `initialCapital × ruinThreshold`
(threshold 0 by default) and, without capital, runs that end below zero.

## Limitations, stated on purpose

- No risk-free curve, no transaction costs, no slippage model: they must enter through `pnl`.
- Sharpe/Sortino assume the observation unit the caller declares; per-trade ratios are not annualized by default.
- Verdicts and scores are reporting conventions with documented thresholds; no p-value of any kind is claimed
  here. Overfitting tests (PBO, Deflated Sharpe Ratio) are a separate module.

## Overfitting (`overfitting.mjs`)

- **PBO by CSCV** (`probabilityOfBacktestOverfitting`): the sample is cut into `splits` contiguous blocks (even,
  8 by default); every half is used once as in-sample. For each partition the trial with the best in-sample mean is
  ranked out-of-sample against the other trials; PBO is the share of partitions where that rank is in the bottom
  half. Assumes the trials are comparable and roughly independent; correlated parameter sets make it optimistic.
  The combination count is capped (`maxCombinations`), which is reported as `capped`.
- **Deflated Sharpe Ratio** (`deflatedSharpeRatio`): `DSR = Φ(z)` with
  `z = (SR − SR0)·√(T−1) / √(1 − skew·SR + ((kurt−1)/4)·SR²)` and
  `SR0 = √V·((1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)))`, where `N` is the number of trials, `γ` the Euler–Mascheroni
  constant, `V` the variance of the trial Sharpes (default `1/T`, the variance under the null) and `kurt` the
  non-excess kurtosis. A high DSR means the winner is surprising given how many were tried; it is not a proof of
  skill.
- `overfittingReport` combines the IS/OOS ratio, the trial count, PBO and DSR into warnings with stable codes
  (`oos_collapsed`, `oos_degraded`, `many_trials`, `pbo_high`, `dsr_low`) and states its own limitations.

## Experiment contract (`contract.mjs`)

`schema_version` is `1.0.0`. One experiment carries: `experiment_id`, `strategy_id`, `strategy_version`, `asset`,
`timeframe`, `data_provider`, `data_license_reference`, `period {from,to}`, `parameters`, `metrics`, `costs`,
`in_sample`, `out_of_sample`, `robustness {score, plateauSize, isolatedSpike, dimensions}`, `overfitting`,
`warnings [{code,message}]`, `engine_version`, `created_at`.

`validateExperiment` returns **every** problem as `{ path, message }` instead of throwing on the first one, and in
strict mode refuses any non-finite number inside `metrics` (a NaN in a report is a bug, not a value).
`serializeExperiment` sorts keys, so the same experiment is byte-identical and can be hashed. `summarizeExperiment`
is the view an agent acts on: verdict, robustness score, warning count and whether the run is reproducible.

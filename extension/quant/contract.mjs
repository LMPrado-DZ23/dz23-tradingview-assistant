// DZ23 Quant Research — experiment contract (versioned JSON).
//
// One experiment is the unit the DZ23 agents consume: everything needed to reproduce a result and to see how
// trustworthy it is. The schema is versioned; `validateExperiment` is the only gate, and it reports every problem
// with its path instead of throwing on the first one.

export const EXPERIMENT_SCHEMA_VERSION = '1.0.0'

const REQUIRED_STRINGS = ['experiment_id', 'strategy_id', 'strategy_version', 'asset', 'timeframe', 'data_provider', 'data_license_reference', 'engine_version']
const VERDICTS = new Set(['stable', 'degraded', 'collapsed', 'unknown'])
const REQUIRED_NUMBERS = ['netProfit']

function isPlainObject (value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isDate (value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

export function createExperiment ({
  experimentId = null,
  strategyId,
  strategyVersion,
  asset,
  timeframe,
  dataProvider,
  dataLicenseReference = 'not declared',
  period = {},
  parameters = {},
  metrics = {},
  costs = {},
  inSample = null,
  outOfSample = null,
  robustness = null,
  overfitting = null,
  warnings = [],
  engineVersion = '1.0.0',
  createdAt = new Date().toISOString(),
} = {}) {
  return {
    schema_version: EXPERIMENT_SCHEMA_VERSION,
    experiment_id: experimentId ?? `exp_${Date.parse(createdAt)}_${Math.abs(hashString(`${strategyId}|${asset}|${timeframe}|${createdAt}`))}`,
    strategy_id: strategyId ?? '',
    strategy_version: strategyVersion ?? '',
    asset: asset ?? '',
    timeframe: timeframe ?? '',
    data_provider: dataProvider ?? '',
    data_license_reference: dataLicenseReference,
    period: { from: period.from ?? null, to: period.to ?? null },
    parameters: { ...parameters },
    metrics: { ...metrics },
    costs: { commissionPct: costs.commissionPct ?? null, slippagePct: costs.slippagePct ?? null, notes: costs.notes ?? '' },
    in_sample: inSample,
    out_of_sample: outOfSample,
    robustness: robustness ? { score: robustness.score ?? null, plateauSize: robustness.plateauSize ?? null, isolatedSpike: Boolean(robustness.isolatedSpike), dimensions: robustness.dimensions ?? [] } : null,
    overfitting: overfitting ?? null,
    warnings: [...warnings],
    engine_version: engineVersion,
    created_at: createdAt,
  }
}

function hashString (text) {
  let hash = 5381
  for (let index = 0; index < text.length; index++)
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  return hash
}

/**
 * Validates one experiment. Returns { ok, errors: [{ path, message }] }. `strict` (default) also refuses
 * numbers that are not finite, because a NaN in a report is a bug that must not travel to the agents.
 */
export function validateExperiment (experiment, { strict = true } = {}) {
  const errors = []
  const problem = (path, message) => errors.push({ path, message })

  if (!isPlainObject(experiment))
    return { ok: false, errors: [{ path: '', message: 'the experiment must be an object' }] }

  if (experiment.schema_version !== EXPERIMENT_SCHEMA_VERSION)
    problem('schema_version', `expected "${EXPERIMENT_SCHEMA_VERSION}", got ${JSON.stringify(experiment.schema_version)}`)

  for (const field of REQUIRED_STRINGS)
    if (typeof experiment[field] !== 'string' || !experiment[field].trim())
      problem(field, 'a non-empty string is required')

  if (!isPlainObject(experiment.period) || !isDate(experiment.period.from) || !isDate(experiment.period.to))
    problem('period', 'period.from and period.to must be ISO dates')
  else if (Date.parse(experiment.period.from) >= Date.parse(experiment.period.to))
    problem('period', 'period.from must be before period.to')

  if (!isPlainObject(experiment.parameters))
    problem('parameters', 'parameters must be an object')
  if (!isPlainObject(experiment.metrics))
    problem('metrics', 'metrics must be an object')
  for (const field of REQUIRED_NUMBERS)
    if (typeof experiment.metrics?.[field] !== 'number')
      problem(`metrics.${field}`, 'a number is required')

  if (strict) {
    const walk = (value, path) => {
      if (typeof value === 'number' && !Number.isFinite(value))
        problem(path, 'the number is not finite')
      else if (Array.isArray(value))
        value.forEach((item, index) => walk(item, `${path}[${index}]`))
      else if (isPlainObject(value))
        for (const [key, item] of Object.entries(value))
          walk(item, path ? `${path}.${key}` : key)
    }
    walk(experiment.metrics, 'metrics')
  }

  if (!isPlainObject(experiment.costs))
    problem('costs', 'costs must be an object, even when empty')

  for (const part of ['in_sample', 'out_of_sample']) {
    const value = experiment[part]
    if (value === null)
      continue
    if (!isPlainObject(value))
      problem(part, 'must be an object or null')
    else if (typeof value.metrics?.netProfit !== 'number')
      problem(`${part}.metrics.netProfit`, 'a number is required')
    else if (value.verdict !== undefined && !VERDICTS.has(value.verdict))
      problem(`${part}.verdict`, `one of ${[...VERDICTS].join(', ')} is required when present`)
  }

  if (experiment.robustness !== null && experiment.robustness !== undefined) {
    if (!isPlainObject(experiment.robustness))
      problem('robustness', 'must be an object or null')
    else {
      if (experiment.robustness.score !== null && typeof experiment.robustness.score !== 'number')
        problem('robustness.score', 'must be a number or null')
      if (typeof experiment.robustness.isolatedSpike !== 'boolean')
        problem('robustness.isolatedSpike', 'must be a boolean')
    }
  }

  if (experiment.overfitting !== null && experiment.overfitting !== undefined && !isPlainObject(experiment.overfitting))
    problem('overfitting', 'must be an object or null')

  if (!Array.isArray(experiment.warnings))
    problem('warnings', 'must be an array')
  else
    experiment.warnings.forEach((warning, index) => {
      if (!isPlainObject(warning) || typeof warning.code !== 'string' || typeof warning.message !== 'string')
        problem(`warnings[${index}]`, 'must be { code, message }')
    })

  if (!isDate(experiment.created_at))
    problem('created_at', 'must be an ISO date')

  return { ok: errors.length === 0, errors }
}

// Stable serialization: the same experiment always produces the same bytes, so a hash of it is comparable.
export function serializeExperiment (experiment) {
  return JSON.stringify(sortValue(experiment), null, 2)
}

function sortValue (value) {
  if (Array.isArray(value))
    return value.map(sortValue)
  if (isPlainObject(value))
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]))
  return value
}

export function parseExperiment (text) {
  const parsed = JSON.parse(text)
  const validation = validateExperiment(parsed)
  return { experiment: parsed, ok: validation.ok, errors: validation.errors }
}

// What a DZ23 agent needs to act on: a result it can reproduce, with the evidence attached.
export function summarizeExperiment (experiment) {
  const validation = validateExperiment(experiment)
  return {
    ok: validation.ok,
    errors: validation.errors,
    experimentId: experiment.experiment_id,
    strategy: `${experiment.strategy_id}@${experiment.strategy_version}`,
    asset: experiment.asset,
    timeframe: experiment.timeframe,
    period: experiment.period,
    netProfit: experiment.metrics?.netProfit ?? null,
    outOfSampleVerdict: experiment.out_of_sample?.verdict ?? experiment.overfitting?.comparison?.verdict ?? 'unknown',
    robustnessScore: experiment.robustness?.score ?? null,
    warnings: experiment.warnings?.length ?? 0,
    reproducible: Boolean(experiment.parameters && Object.keys(experiment.parameters).length && experiment.engine_version),
  }
}

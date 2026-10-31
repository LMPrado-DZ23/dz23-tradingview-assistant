// DZ23 Quant Research — split, walk-forward, in/out-of-sample comparison and parameter robustness.
//
// All of it is pure and index-based: a trade or a tested parameter set keeps its chronological position, so no
// observation can leak from the future into a decision. Formulas and thresholds: quant/FORMULAS.md.

export const RESEARCH_VERSION = '1.0.0'

// Chronological split, no shuffle: the last `1 - isRatio` part is the out-of-sample holdout.
export function splitChronological (items, { isRatio = 0.7 } = {}) {
  if (!Array.isArray(items))
    throw new TypeError('items must be an array')
  if (!(isRatio > 0 && isRatio < 1))
    throw new RangeError('isRatio must be between 0 and 1 (exclusive)')
  if (items.length < 2)
    return { is: [], oos: [...items], boundary: 0, reason: 'not enough observations for a split' }
  const boundary = Math.floor(items.length * isRatio)
  return {
    is: items.slice(0, boundary),
    oos: items.slice(boundary),
    boundary,
  }
}

/**
 * Rolling windows: train [start, start+trainSize), test right after it. A window never shares an observation with
 * its own test part, and `anchored` keeps the train start at zero (expanding window).
 */
export function walkForwardWindows (length, { trainSize, testSize, step = null, anchored = false } = {}) {
  if (!Number.isInteger(length) || length <= 0)
    throw new RangeError('length must be a positive integer')
  if (!Number.isInteger(trainSize) || trainSize <= 0)
    throw new RangeError('trainSize must be a positive integer')
  if (!Number.isInteger(testSize) || testSize <= 0)
    throw new RangeError('testSize must be a positive integer')
  const stride = step ?? testSize
  if (!Number.isInteger(stride) || stride <= 0)
    throw new RangeError('step must be a positive integer')
  const windows = []
  for (let start = 0; start + trainSize + testSize <= length; start += stride) {
    windows.push({
      index: windows.length,
      train: { start: anchored ? 0 : start, end: start + trainSize },
      test: { start: start + trainSize, end: start + trainSize + testSize },
    })
  }
  return windows
}

// Applies an evaluator to each window. The evaluator receives a slice; it must not read outside it.
export function runWalkForward (series, windows, evaluate) {
  if (!Array.isArray(series))
    throw new TypeError('series must be an array')
  return windows.map((window) => ({
    index: window.index,
    train: evaluate(series.slice(window.train.start, window.train.end), window.train),
    test: evaluate(series.slice(window.test.start, window.test.end), window.test),
  }))
}

/**
 * In/out-of-sample comparison of one metric. The ratio is oos/is for a "higher is better" metric; a negative or
 * zero in-sample value makes the ratio meaningless, so it is reported as `null` instead of a fake number.
 */
export function compareInOut ({ is, oos, metric = 'netProfit' } = {}) {
  const isValue = typeof is === 'number' ? is : is?.[metric]
  const oosValue = typeof oos === 'number' ? oos : oos?.[metric]
  if (typeof isValue !== 'number' || typeof oosValue !== 'number')
    return { metric, isValue: isValue ?? null, oosValue: oosValue ?? null, ratio: null, degradationPct: null, verdict: 'unknown', reason: 'the metric is not available on both parts' }
  const ratio = isValue > 0 ? oosValue / isValue : null
  const degradationPct = ratio === null ? null : (1 - ratio) * 100
  let verdict = 'unknown'
  if (ratio !== null)
    verdict = ratio >= 0.7 ? 'stable' : ratio >= 0.3 ? 'degraded' : 'collapsed'
  return { metric, isValue, oosValue, ratio, degradationPct, verdict, reason: ratio === null ? 'in-sample value is not positive' : null }
}

// Index of every parameter set on the grid, so a neighbour is a real adjacency and not a numeric coincidence.
function gridIndex (points, dimensions) {
  const axes = {}
  for (const dimension of dimensions)
    axes[dimension] = [...new Set(points.map((point) => point.params?.[dimension]))].sort((left, right) => (left > right ? 1 : left < right ? -1 : 0))
  const position = new Map()
  for (const point of points) {
    const key = dimensions.map((dimension) => axes[dimension].indexOf(point.params?.[dimension])).join(',')
    position.set(key, point)
  }
  return { axes, position }
}

/**
 * Robustness of a parameter grid.
 *  - a neighbour differs by exactly one step in one dimension;
 *  - `stability` is the mean of the neighbours divided by the point (higher is a plateau, ~0 is an isolated peak);
 *  - the best point is an isolated spike when its neighbours average below `thresholdRatio` of it;
 *  - the plateau is the connected region (through neighbours) at or above `thresholdRatio` of the best value.
 */
export function parameterRobustness (points, { dimensions, thresholdRatio = 0.8 } = {}) {
  if (!Array.isArray(points) || !points.length)
    throw new TypeError('points must be a non-empty array of { params, value }')
  const dims = dimensions ?? [...new Set(points.flatMap((point) => Object.keys(point.params ?? {})))]
  const { axes, position } = gridIndex(points, dims)

  const neighboursOf = (point) => {
    const indices = dims.map((dimension) => axes[dimension].indexOf(point.params?.[dimension]))
    const neighbours = []
    for (let axis = 0; axis < dims.length; axis++) {
      for (const delta of [-1, 1]) {
        const next = [...indices]
        next[axis] += delta
        if (next[axis] < 0 || next[axis] >= axes[dims[axis]].length)
          continue
        const neighbour = position.get(next.join(','))
        if (neighbour)
          neighbours.push(neighbour)
      }
    }
    return neighbours
  }

  const enriched = points.map((point) => {
    const neighbours = neighboursOf(point)
    const values = neighbours.map((neighbour) => neighbour.value).filter((value) => typeof value === 'number')
    const neighbourMean = values.length ? values.reduce((total, value) => total + value, 0) / values.length : null
    return {
      params: { ...point.params },
      value: point.value,
      neighbours: values.length,
      neighbourMean,
      // A plateau means the neighbours are as good as the point; a lone peak means they are much worse
      stability: neighbourMean === null || !(point.value > 0) ? null : neighbourMean / point.value,
    }
  })

  const best = enriched.reduce((current, point) => (typeof point.value === 'number' && (current === null || point.value > current.value) ? point : current), null)
  const isIsolatedSpike = Boolean(best && best.neighbourMean !== null && best.value > 0 && best.neighbourMean < best.value * thresholdRatio)

  // Connected plateau around the best point, through neighbours, at or above thresholdRatio of the best value
  const floor = best && typeof best.value === 'number' ? best.value * thresholdRatio : null
  const byKey = new Map(enriched.map((point) => [dims.map((dimension) => point.params?.[dimension]).join(','), point]))
  const plateau = []
  if (best && floor !== null) {
    const queue = [best]
    const seen = new Set()
    while (queue.length) {
      const point = queue.shift()
      const key = dims.map((dimension) => point.params?.[dimension]).join(',')
      if (seen.has(key))
        continue
      seen.add(key)
      plateau.push(point)
      for (const neighbour of neighboursOf(point)) {
        const neighbourKey = dims.map((dimension) => neighbour.params?.[dimension]).join(',')
        const found = byKey.get(neighbourKey)
        if (found && typeof found.value === 'number' && found.value >= floor && !seen.has(neighbourKey))
          queue.push(found)
      }
    }
  }

  const stabilities = enriched.map((point) => point.stability).filter((value) => typeof value === 'number')
  return {
    researchVersion: RESEARCH_VERSION,
    dimensions: dims,
    gridSize: enriched.length,
    best,
    isIsolatedSpike,
    plateauSize: plateau.length,
    plateauShare: enriched.length ? plateau.length / enriched.length : null,
    plateauBest: plateau.length ? plateau.reduce((current, point) => (point.value > current.value ? point : current), plateau[0]) : null,
    meanStability: stabilities.length ? stabilities.reduce((total, value) => total + value, 0) / stabilities.length : null,
    points: enriched,
  }
}

// A single number for a report: how much of the grid is close to the best result, and whether the peak is alone.
export function robustnessScore (report) {
  if (!report || report.plateauShare === null || typeof report.plateauShare !== 'number')
    return { score: null, reason: 'no plateau information' }
  const width = Math.min(1, report.plateauShare * 2)
  const spikePenalty = report.isIsolatedSpike ? 0.5 : 1
  return {
    score: Math.round(width * spikePenalty * 100) / 100,
    reason: report.isIsolatedSpike ? 'best point has no comparable neighbours' : null,
  }
}

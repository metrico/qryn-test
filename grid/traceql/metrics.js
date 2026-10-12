// Reference evaluator for TraceQL metrics in the grid: a metrics function over
// the oracle's result spans, which are exactly the spans search returns.

const oracle = require('./oracle')

// INTRINSIC_LABELS maps by-labels gigapipe reads from the spans table.
const INTRINSIC_LABELS = {
  name: s => s.name,
  'span:name': s => s.name,
  'service.name': s => s.attrs['service.name'],
  'resource.service.name': s => s.attrs['service.name'],
  rootServiceName: s => s.attrs['service.name']
}

// byValue is a span's value of a by-label, '' when it has none.
const byValue = (s, label) => {
  if (INTRINSIC_LABELS[label]) return INTRINSIC_LABELS[label](s)
  const key = label.replace(/^(span|resource)\./, '')
  return s.attrs[key] === undefined ? '' : s.attrs[key]
}

const seconds = (s) => s.durationNs / 1e9

// quantile interpolates linearly between the closest ranks.
const quantile = (xs, q) => {
  const sorted = [...xs].sort((a, b) => a - b)
  const i = Math.max(0, Math.min(sorted.length - 1, q * (sorted.length - 1)))
  const lo = Math.floor(i)
  return lo + 1 < sorted.length ? sorted[lo] * (1 - (i - lo)) + sorted[lo + 1] * (i - lo) : sorted[lo]
}

// histogramBucket is the power-of-2 upper bound of a span's duration in ns.
const histogramBucket = (s) => s.durationNs > 0 ? 2 ** Math.ceil(Math.log2(s.durationNs)) : 0

// value aggregates spans for fn; window is the bucket width in seconds.
const value = (fn, spans, window, m) => {
  const durs = () => {
    if (m.attr !== 'duration') throw new Error(`oracle: ${fn} over ${m.attr}`)
    return spans.map(seconds)
  }
  switch (fn) {
    case 'count_over_time': return spans.length
    case 'rate': return spans.length / window
    case 'avg_over_time': return durs().reduce((a, b) => a + b, 0) / spans.length
    case 'sum_over_time': return durs().reduce((a, b) => a + b, 0)
    case 'min_over_time': return Math.min(...durs())
    case 'max_over_time': return Math.max(...durs())
    case 'quantile_over_time': return quantile(durs(), m.q === undefined ? 0.5 : m.q)
    case 'histogram_over_time': return spans.length
  }
  throw new Error(`oracle: metrics function ${fn}`)
}

// seriesLabels returns the labels of a range series of fn.
const seriesLabels = (m, group) => {
  if (m.fn === 'histogram_over_time') return group
  if (m.by) return group
  if (m.fn === 'quantile_over_time') return { p: String(m.q === undefined ? 0.5 : m.q) }
  return { __name__: m.fn }
}

// labelKey is a canonical key of a label set.
const labelKey = (labels) => Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',')

// groupKey returns the series labels a span falls in, before the function's own labels.
const groupOf = (m, s) => {
  if (m.fn === 'histogram_over_time') return { __bucket: String(histogramBucket(s) / 1e9) }
  return Object.fromEntries((m.by || []).map(l => [l, byValue(s, l)]))
}

/**
 * range returns the expected series of a range query:
 * [{labels, samples: {ts (ms): value}, buckets: {ts: [span]}}], with zero
 * values left out, or UNRESOLVED. Spans fall in the step bucket of their
 * start time.
 */
const range = (m, found, step) => {
  const series = new Map()
  for (const s of found) {
    const group = groupOf(m, s)
    const labels = seriesLabels(m, group)
    const key = labelKey(labels)
    if (!series.has(key)) series.set(key, { labels, buckets: {} })
    const ts = Math.floor(s.start / step) * step
    ;(series.get(key).buckets[ts] = series.get(key).buckets[ts] || []).push(s)
  }
  return [...series.values()].map(({ labels, buckets }) => {
    const samples = {}
    for (const [ts, spans] of Object.entries(buckets)) {
      const v = value(m.fn, spans, step / 1000, m)
      if (v !== 0) samples[ts] = v
    }
    return { labels, samples, buckets }
  })
}

// instant returns the expected series of an instant query: [{labels, value}].
const instant = (m, found, from, to) => {
  const groups = new Map()
  for (const s of found) {
    const labels = groupOf(m, s)
    const key = labelKey(labels)
    if (!groups.has(key)) groups.set(key, { labels, spans: [] })
    groups.get(key).spans.push(s)
  }
  return [...groups.values()].map(({ labels, spans }) => ({ labels, value: value(m.fn, spans, (to - from) / 1000, m) }))
}

/**
 * compare returns the expected compare() series, [{labels, value}]: per
 * attribute value of the baseline spans, the count of those in the selection
 * and of the rest, each when non-zero; the top `count` values per key by
 * total.
 */
const compare = (m, baseline, from, to) => {
  const filter = m.compare.filter
  const selected = (s) => s.start > from && s.start <= to && (filter === null || oracle.matches(s, filter))
  const counts = new Map()
  for (const s of baseline) {
    const sel = selected(s)
    for (const [k, v] of Object.entries(s.attrs)) {
      if (!counts.has(k)) counts.set(k, new Map())
      const c = counts.get(k).get(v) || { selection: 0, baseline: 0 }
      c[sel ? 'selection' : 'baseline']++
      counts.get(k).set(v, c)
    }
  }
  const top = m.compare.count || 10
  const out = []
  for (const [k, vals] of counts) {
    const ranked = [...vals.entries()].sort((a, b) => (b[1].selection + b[1].baseline) - (a[1].selection + a[1].baseline))
    if (ranked.length > top) {
      const total = ([, c]) => c.selection + c.baseline
      if (total(ranked[top - 1]) === total(ranked[top])) throw new Error(`oracle: compare top ${top} of ${k} is a tie`)
    }
    for (const [v, c] of ranked.slice(0, top)) {
      for (const type of ['selection', 'baseline']) {
        if (c[type] > 0) out.push({ labels: { __meta_type: type, [k]: v }, value: c[type] })
      }
    }
  }
  return out
}

/**
 * metrics returns the expected result of a metrics case: range series, or
 * instant series, or compare series; UNRESOLVED when ancestry does not resolve
 * within the round limit.
 * @param query {Object} the case AST, with metrics
 * @param all {Object[]} from oracle.dataset()
 * @param opts {{from: number, to: number, step: number, instant?: boolean, rounds?: number, pushes?: number}}
 */
const metrics = (query, all, opts) => {
  if (query.pipeline.length !== 1) throw new Error('oracle: pipelines of one spanset expression only')
  const m = query.metrics
  const found = oracle.resultSpans(query.pipeline[0], all, opts)
  if (found === oracle.UNRESOLVED) return oracle.UNRESOLVED
  if (m.fn === 'compare') return compare(m, found, opts.from, opts.to)
  if (opts.instant) return m.fn === 'histogram_over_time' ? [] : instant(m, found, opts.from, opts.to)
  return range(m, found, opts.step)
}

module.exports = { metrics, labelKey, histogramBucket }

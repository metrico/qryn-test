// Normalises TraceQL search, metrics and autocomplete responses and diffs
// them against the oracle. A search result is
// [{trace, spans: [span name, ...], matched, attributes, selected, spanSets}],
// or {status, error} for a failed search; spanSets lists every spanset of the
// trace as {spans, matched, attributes, selected} and the first is also at
// the top level; attributes maps a spanset attribute's name to its OTLP
// value, and selected a listed span's name to its select() values.

const { labelKey } = require('./metrics')
const { SPAN_NAME, nestedSet } = require('./oracle')

// UNRESOLVED_ERROR is the error of a search whose ancestry does not resolve
// within the round limit.
const UNRESOLVED_ERROR = /deeper than the round limit .*GIGAPIPE_TRACEQL_ANCESTRY_ROUNDS/

// selectedOf returns a listed span's select() values: its attributes by key,
// a string as its text and any other value as its OTLP value, and its name at
// SPAN_NAME.
const selectedOf = (span) => {
  const out = Object.fromEntries((span.attributes || []).map(a =>
    [a.key, a.value.stringValue !== undefined ? a.value.stringValue : a.value]))
  if (span.name !== undefined) out[SPAN_NAME] = span.name
  return out
}

/**
 * fromApi maps a search response's ids back to seed names.
 * @param body {Object} the /api/search response
 * @param names {{trace: Object<string, string>, span: Object<string, string>}} id -> name
 */
const fromApi = (body, names) => body.traces.map(t => {
  const name = (id, kind) => names[kind][id] || `${kind}:${id}`
  const spanSets = (t.spanSets || []).map(set => ({
    spans: set.spans.map(s => name(s.spanID, 'span')),
    matched: set.matched,
    attributes: Object.fromEntries((set.attributes || []).map(a => [a.key, a.value])),
    selected: Object.fromEntries(set.spans.map(s => [name(s.spanID, 'span'), selectedOf(s)]).filter(([, v]) => Object.keys(v).length))
  }))
  return {
    trace: name(t.traceID, 'trace'),
    ...(spanSets[0] || { spans: [], matched: 0, attributes: {} }),
    spanSets,
    spanSetMatchesFirst: JSON.stringify(t.spanSet) === JSON.stringify(t.spanSets && t.spanSets[0])
  }
})

/**
 * fromResponse is fromApi for a successful search and {status, error} for a
 * failed one.
 * @param resp {{status: number, data: Object}} the /api/search response
 */
const fromResponse = (resp, names) => resp.status === 200
  ? fromApi(resp.data, names)
  : { status: resp.status, error: (resp.data && resp.data.error) || JSON.stringify(resp.data) }

// attributesDiff compares spanset attributes, names in order and doubles
// within rounding.
const attributesDiff = (name, got, want) => {
  const show = (a) => JSON.stringify(a)
  const same = Object.keys(got).join('\n') === Object.keys(want).join('\n') && Object.keys(want).every(k => {
    const g = got[k]
    const w = want[k]
    if (typeof g.doubleValue === 'number' && typeof w.doubleValue === 'number') return close(g.doubleValue, w.doubleValue)
    return show(g) === show(w)
  })
  return same ? [] : [`${name} attributes ${show(got)}, want ${show(want)}`]
}

// spansetDiff compares one spanset of a trace.
const spansetDiff = (name, gt, wt) => {
  const out = []
  const gs = [...gt.spans].sort().join(',')
  const ws = [...wt.spans].sort().join(',')
  if (gs !== ws) out.push(`${name} spans ${gs}, want ${ws}`)
  if (gt.matched !== wt.matched) out.push(`${name} matched ${gt.matched}, want ${wt.matched}`)
  if (wt.attributes !== undefined) out.push(...attributesDiff(name, gt.attributes || {}, wt.attributes))
  if (wt.selected !== undefined) out.push(...selectedDiff(name, gt.selected || {}, wt.selected))
  return out
}

// selectedDiff compares the select() values of the listed spans.
const selectedDiff = (name, got, want) => {
  const show = (sel) => JSON.stringify(Object.keys(sel).sort().map(span =>
    [span, Object.keys(sel[span]).sort().map(k => [k, sel[span][k]])]))
  return show(got) === show(want) ? [] : [`${name} selected ${show(got)}, want ${show(want)}`]
}

/**
 * diff returns [] when got and want hold the same traces, spans and matched
 * counts, and the same attributes where want lists them, or one line per
 * mismatch. Trace and span order are not compared; a trace's spansets are
 * compared in order when want lists them, else the trace must have one. A
 * want of {error} expects that error.
 */
const diff = (got, want) => {
  const err = errorDiff(got, want, (g) => `${g.length} traces`)
  if (err) return err
  const out = []
  const index = (rs) => new Map(rs.map(r => [r.trace, r]))
  const g = index(got)
  const w = index(want)
  if (g.size !== got.length) out.push(`duplicate traces: ${got.map(r => r.trace).join(',')}`)
  for (const name of [...new Set([...g.keys(), ...w.keys()])].sort()) {
    const gt = g.get(name)
    const wt = w.get(name)
    if (!wt) { out.push(`${name} extra: ${gt.spans.join(',')} matched ${gt.matched}`); continue }
    if (!gt) { out.push(`${name} missing: want ${wt.spans.join(',')} matched ${wt.matched}`); continue }
    out.push(...spansetDiff(name, gt, wt))
    if (gt.spanSets !== undefined) {
      const ws = wt.spanSets || [wt]
      if (gt.spanSets.length !== ws.length) out.push(`${name} has ${gt.spanSets.length} spanSets, want ${ws.length}`)
      for (let i = 1; i < Math.min(gt.spanSets.length, ws.length); i++) {
        out.push(...spansetDiff(`${name} spanSets[${i}]`, gt.spanSets[i], ws[i]))
      }
    }
    if (gt.spanSetMatchesFirst === false) out.push(`${name} spanSet differs from spanSets[0]`)
  }
  return out
}

// errorDiff diffs a result against an expected error, or returns null when
// neither is an error. The unresolved-ancestry error matches by pattern, any
// other by its text.
const errorDiff = (got, want, size) => {
  if (!want.error && !got.error) return null
  if (!want.error) return [`unexpected error ${got.status}: ${got.error}`]
  const unresolved = want.error === 'unresolved ancestry'
  const what = unresolved ? 'an unresolved-ancestry error' : `the error "${want.error}"`
  if (!got.error) return [`want ${what}, got ${size(got)}`]
  const ok = unresolved ? UNRESOLVED_ERROR.test(got.error) : got.error.includes(want.error)
  return ok ? [] : [`error ${got.status}: ${got.error}, want ${what}`]
}

// labelsOf flattens a metrics label list to {key: value}; an int is
// `int <n>`.
const labelsOf = (ls) => Object.fromEntries((ls || []).map(l => {
  const v = l.value || {}
  if (v.doubleValue !== undefined) return [l.key, String(v.doubleValue)]
  if (v.intValue !== undefined) return [l.key, `int ${v.intValue}`]
  return [l.key, v.stringValue || '']
}))

/**
 * fromMetricsResponse normalises a metrics response: range series
 * [{labels, samples: {ts: value}, exemplars}], or [{labels, value}] for an
 * instant or compare() query, or {status, error} for a failed query. Zero
 * samples are left out.
 * @param resp {{status: number, data: Object}}
 * @param kind {'range'|'instant'|'compare'}
 */
const fromMetricsResponse = (resp, kind) => {
  if (resp.status !== 200) return { status: resp.status, error: (resp.data && resp.data.error) || JSON.stringify(resp.data) }
  return (resp.data.series || []).map(s => {
    const labels = labelsOf(s.labels)
    if (kind === 'instant') return { labels, value: s.value || 0 }
    if (kind === 'compare') return { labels, value: s.samples ? s.samples[0].value : s.value }
    const samples = {}
    for (const p of s.samples) {
      if (p.value) samples[p.timestampMs] = p.value
    }
    return { labels, samples, exemplars: s.exemplars || [] }
  })
}

const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

// exemplarDiff checks a range series' exemplars: one per bucket of
// want.exemplarBuckets (every bucket with result spans when unset), each
// naming the trace and start time of one result span of its bucket.
const exemplarDiff = (name, exemplars, want, step, traceNames) => {
  const out = []
  const buckets = want.exemplarBuckets || Object.keys(want.buckets).map(Number)
  if (exemplars.length !== buckets.length) out.push(`${name} has ${exemplars.length} exemplars, want ${buckets.length}`)
  for (const ex of exemplars) {
    const ts = Number(ex.timestampMs)
    const bucket = Math.floor(ts / step) * step
    if (!buckets.includes(bucket)) {
      out.push(`${name} exemplar at ${ts} is in bucket ${bucket}, want one of ${buckets.join(',')}`)
      continue
    }
    const spans = want.buckets[bucket] || []
    const trace = labelsOf(ex.labels)['trace:id']
    if (!spans.some(s => s.traceId === trace && s.start === ts)) {
      out.push(`${name} exemplar ${traceNames[trace] || trace} at ${ts} is not a result span of its bucket`)
    }
  }
  return out
}

/**
 * metricsDiff returns [] when got and want hold the same series and values,
 * or one line per mismatch. Range series also check their exemplars against
 * the result spans. A want of {error} expects that error.
 * @param opts {{kind: string, step?: number, from?: number, names?: Object}}
 */
const metricsDiff = (got, want, { kind, step, from = 0, names: n = { trace: {} } }) => {
  const err = errorDiff(got, want, (g) => `${g.length} series`)
  if (err) return err
  const out = []
  const rel = (ts) => `+${(Number(ts) - from) / 1000}s`
  const g = new Map(got.map(s => [labelKey(s.labels), s]))
  const w = new Map(want.map(s => [labelKey(s.labels), s]))
  if (g.size !== got.length) out.push(`duplicate series: ${got.map(s => labelKey(s.labels)).join(' ')}`)
  for (const key of [...new Set([...g.keys(), ...w.keys()])].sort()) {
    const gs = g.get(key)
    const ws = w.get(key)
    if (!ws) { out.push(`{${key}} extra`); continue }
    if (!gs) { out.push(`{${key}} missing`); continue }
    if (kind !== 'range') {
      if (!close(gs.value, ws.value)) out.push(`{${key}} value ${gs.value}, want ${ws.value}`)
      continue
    }
    for (const ts of [...new Set([...Object.keys(gs.samples), ...Object.keys(ws.samples)])].sort()) {
      const gv = gs.samples[ts] || 0
      const wv = ws.samples[ts] || 0
      if (!close(gv, wv)) out.push(`{${key}} at ${rel(ts)}: ${gv}, want ${wv}`)
    }
    out.push(...exemplarDiff(`{${key}}`, gs.exemplars, ws, step, n.trace))
  }
  return out
}

/**
 * fromAutocompleteResponse normalises a tags v2 or values v2 response to the
 * sorted suggestions, or {status, error} for a failed request. Tags are the
 * resource and span scopes; the intrinsic scope is a fixed list.
 * @param resp {{status: number, data: Object}}
 * @param tags {boolean} whether resp is a tags v2 response
 */
const fromAutocompleteResponse = (resp, tags) => {
  if (resp.status !== 200) return { status: resp.status, error: (resp.data && resp.data.error) || JSON.stringify(resp.data) }
  const values = tags
    ? (resp.data.scopes || []).filter(s => s.name !== 'intrinsic').flatMap(s => s.tags)
    : (resp.data.tagValues || []).map(v => v.value)
  return [...values].sort()
}

/**
 * autocompleteDiff returns [] when got holds the expected suggestions, or one
 * line per mismatch. A superset want only needs its values present. A want of
 * {error} expects that error.
 * @param got {string[]|{status: number, error: string}}
 * @param want {{values: string[], superset: boolean}|{error: string}}
 */
const autocompleteDiff = (got, want) => {
  const err = errorDiff(got, want, (g) => `${g.length} suggestions`)
  if (err) return err
  const out = []
  if (new Set(got).size !== got.length) out.push(`duplicate suggestions: ${got.join(',')}`)
  const missing = want.values.filter(v => !got.includes(v))
  if (missing.length) out.push(`missing ${missing.join(',')}`)
  const extra = got.filter(v => !want.values.includes(v))
  if (!want.superset && extra.length) out.push(`extra ${extra.join(',')}`)
  return out
}

// names inverts seed.ids() for fromApi.
const names = (ids) => {
  const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]))
  return { trace: invert(ids.trace), span: invert(ids.span) }
}

/**
 * nestedSetRows reads the selected nested-set values of every listed span of
 * a search response: [{traceId, spanId, left, right, parent}], an int as its
 * decimal text and a string as `string <text>`.
 * @param body {Object} the /api/search response
 */
const nestedSetRows = (body) => body.traces.flatMap(t => (t.spanSets || []).flatMap(set => set.spans.map(s => {
  const value = (key) => {
    const a = (s.attributes || []).find(a => a.key === key)
    if (!a) return undefined
    return a.value.intValue !== undefined ? a.value.intValue : `string ${a.value.stringValue}`
  }
  return { traceId: t.traceID, spanId: s.spanID, left: value('nestedSetLeft'), right: value('nestedSetRight'), parent: value('nestedSetParent') }
})))

/**
 * nestedSetDiff lists the spans whose nested-set values are missing or
 * differ from the oracle's numbering of the given spans.
 * @param rows {Object[]} from nestedSetRows()
 * @param spans {Object[]} the landed spans, from oracle.dataset()
 */
const nestedSetDiff = (rows, spans) => {
  const text = (n) => [n.left, n.right, n.parent].join('/')
  const got = new Map(rows.map(r => [`${r.traceId}/${r.spanId}`, text(r)]))
  const want = nestedSet(spans)
  const out = []
  for (const s of spans) {
    const key = `${s.traceId}/${s.spanId}`
    const w = text(want.get(key))
    if (!got.has(key)) out.push(`${s.name}: missing, want ${w}`)
    else if (got.get(key) !== w) out.push(`${s.name}: got ${got.get(key)}, want ${w}`)
  }
  return out
}

module.exports = { fromApi, fromResponse, diff, names, fromMetricsResponse, metricsDiff, fromAutocompleteResponse, autocompleteDiff, nestedSetRows, nestedSetDiff }

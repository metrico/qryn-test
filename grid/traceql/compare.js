// Normalises TraceQL search responses and diffs them against the oracle. A
// result is [{trace, spans: [span name, ...], matched}], or {status, error}
// for a failed search.

// UNRESOLVED_ERROR is the error of a search whose ancestry does not resolve
// within the round limit.
const UNRESOLVED_ERROR = /deeper than the round limit .*GIGAPIPE_TRACEQL_ANCESTRY_ROUNDS/

/**
 * fromApi maps a search response's ids back to seed names.
 * @param body {Object} the /api/search response
 * @param names {{trace: Object<string, string>, span: Object<string, string>}} id -> name
 */
const fromApi = (body, names) => body.traces.map(t => {
  const set = t.spanSets && t.spanSets.length ? t.spanSets[0] : { spans: [], matched: 0 }
  const name = (id, kind) => names[kind][id] || `${kind}:${id}`
  return {
    trace: name(t.traceID, 'trace'),
    spans: set.spans.map(s => name(s.spanID, 'span')),
    matched: set.matched,
    spanSets: t.spanSets ? t.spanSets.length : 0,
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

/**
 * diff returns [] when got and want hold the same traces, spans and matched
 * counts, or one line per mismatch. Order is not compared. A want of
 * {error} expects the unresolved-ancestry error.
 */
const diff = (got, want) => {
  if (want.error || got.error) {
    if (!want.error) return [`unexpected error ${got.status}: ${got.error}`]
    if (!got.error) return [`want an unresolved-ancestry error, got ${got.length} traces`]
    return UNRESOLVED_ERROR.test(got.error) ? [] : [`error ${got.status}: ${got.error}, want an unresolved-ancestry error`]
  }
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
    const gs = [...gt.spans].sort().join(',')
    const ws = [...wt.spans].sort().join(',')
    if (gs !== ws) out.push(`${name} spans ${gs}, want ${ws}`)
    if (gt.matched !== wt.matched) out.push(`${name} matched ${gt.matched}, want ${wt.matched}`)
    if (gt.spanSets !== undefined && gt.spanSets !== 1) out.push(`${name} has ${gt.spanSets} spanSets, want 1`)
    if (gt.spanSetMatchesFirst === false) out.push(`${name} spanSet differs from spanSets[0]`)
  }
  return out
}

// names inverts seed.ids() for fromApi.
const names = (ids) => {
  const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]))
  return { trace: invert(ids.trace), span: invert(ids.span) }
}

module.exports = { fromApi, fromResponse, diff, names }

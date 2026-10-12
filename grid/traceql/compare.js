// Normalises TraceQL search responses and diffs them against the oracle. A
// result is [{trace, spans: [span name, ...], matched}].

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
    legacyMatches: JSON.stringify(t.spanSet) === JSON.stringify(t.spanSets && t.spanSets[0])
  }
})

/**
 * diff returns [] when got and want hold the same traces, spans and matched
 * counts, or one line per mismatch. Order is not compared.
 */
const diff = (got, want) => {
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
    if (gt.legacyMatches === false) out.push(`${name} spanSet differs from spanSets[0]`)
  }
  return out
}

// names inverts seed.ids() for fromApi.
const names = (ids) => {
  const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]))
  return { trace: invert(ids.trace), span: invert(ids.span) }
}

module.exports = { fromApi, diff, names }

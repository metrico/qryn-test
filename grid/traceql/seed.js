// TraceQL grid seed: the fixture shapes as named spans. Every time is in
// milliseconds relative to FROM, the query window is (FROM, TO], and FROM is a
// whole second. Generators are pure functions of their arguments.

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const WINDOW = 30 * MINUTE

// Attributes on every seeded span.
const SUITE = { suite: 'traceql-grid' }

// window returns the query window for a run: FROM sits in one of `slots`
// two-hour slots between 1 and 6 days back, so reruns on one stack rarely meet.
const window = (nowMs, slot, slots = 60) => {
  if (slot < 0 || slot >= slots) throw new Error(`slot ${slot} out of [0, ${slots})`)
  const base = Math.floor((nowMs - 26 * HOUR) / HOUR) * HOUR
  const from = base - slot * 2 * HOUR
  return { from, to: from + WINDOW }
}

/**
 * A trace is {name, shape, spans}; a span is
 * {name, parent, start, duration, attrs, push, sameId?}. parent is a span
 * name, null for a root, or `missing:<name>` for a parent that is never
 * written. start and duration are ms (start relative to FROM); push is the
 * ingest batch; sameId names an earlier span whose id the span reuses.
 */
const traces = () => {
  const out = []
  let clock = 0
  // tick hands out distinct in-window start times.
  const tick = () => { clock += 1500; return clock }
  const span = (name, parent, attrs = {}, extra = {}) => ({
    name,
    parent,
    start: extra.start !== undefined ? extra.start : tick(),
    duration: extra.duration !== undefined ? extra.duration : 10 + (name.length * 7) % 40,
    attrs: { ...SUITE, ...attrs },
    push: extra.push || 0,
    ...(extra.sameId ? { sameId: extra.sameId } : {})
  })

  // 1. Chains of depth 9 and 8.
  for (const depth of [9, 8]) {
    const spans = []
    for (let i = 0; i < depth; i++) {
      spans.push(span(`c${depth}_${i}`, i ? `c${depth}_${i - 1}` : null, { shape: 'chain', chain: String(depth), depth: String(i) }))
    }
    out.push({ name: `chain${depth}`, shape: 'chain', spans })
  }

  // 2. A root with 50 children; every fifth child has two grandchildren.
  {
    const spans = [span('fan_root', null, { shape: 'fanout', role: 'root' })]
    for (let i = 0; i < 50; i++) {
      const c = `fan_c${String(i).padStart(2, '0')}`
      spans.push(span(c, 'fan_root', { shape: 'fanout', role: 'child', idx: String(i) }))
      if (i % 5 === 0) {
        for (const g of [0, 1]) spans.push(span(`${c}_g${g}`, c, { shape: 'fanout', role: 'grandchild', idx: String(i) }))
      }
    }
    out.push({ name: 'fanout', shape: 'fanout', spans })
  }

  // 3. A three-level mixed tree with distinct per-level attributes.
  const mixed = (prefix, shape, childPush, rootPush) => [
    span(`${prefix}_root`, null, { shape, lvl: '0', svc: 'gateway', 'http.method': 'GET' }, { push: rootPush, duration: 120 }),
    span(`${prefix}_a`, `${prefix}_root`, { shape, lvl: '1', svc: 'api', op: 'read' }, { push: childPush, duration: 80 }),
    span(`${prefix}_b`, `${prefix}_root`, { shape, lvl: '1', svc: 'api', op: 'write', 'otel.status_code': 'ERROR' }, { push: childPush, duration: 60 }),
    span(`${prefix}_a1`, `${prefix}_a`, { shape, lvl: '2', svc: 'db', 'db.system': 'postgres' }, { push: childPush, duration: 30 }),
    span(`${prefix}_a2`, `${prefix}_a`, { shape, lvl: '2', svc: 'cache' }, { push: childPush, duration: 5 }),
    span(`${prefix}_b1`, `${prefix}_b`, { shape, lvl: '2', svc: 'db', 'db.system': 'mysql' }, { push: childPush, duration: 45 })
  ]
  out.push({ name: 'mixed', shape: 'mixed', spans: mixed('mix', 'mixed', 0, 0) })

  // 4. A rooted trace carrying an orphan subtree.
  out.push({
    name: 'orphan',
    shape: 'orphan',
    spans: [
      span('orph_root', null, { shape: 'orphan', role: 'root' }),
      span('orph_child', 'orph_root', { shape: 'orphan', role: 'child' }),
      span('orph_o1', 'missing:orph_gone', { shape: 'orphan', role: 'orphan' }),
      span('orph_o2', 'orph_o1', { shape: 'orphan', role: 'orphan' })
    ]
  })

  // 5. Two parent-0 roots.
  out.push({
    name: 'tworoots',
    shape: 'tworoots',
    spans: [
      span('two_r1', null, { shape: 'tworoots', role: 'root' }),
      span('two_r2', null, { shape: 'tworoots', role: 'root' }),
      span('two_r1c', 'two_r1', { shape: 'tworoots', role: 'child' }),
      span('two_r2c', 'two_r2', { shape: 'tworoots', role: 'child' })
    ]
  })

  // 6. A root-less trace.
  out.push({
    name: 'rootless',
    shape: 'rootless',
    spans: [
      span('rl_a', 'missing:rl_gone', { shape: 'rootless', role: 'top' }),
      span('rl_b', 'rl_a', { shape: 'rootless', role: 'child' }),
      span('rl_c', 'rl_a', { shape: 'rootless', role: 'child' })
    ]
  })

  // 7. The mixed tree, children pushed first.
  out.push({ name: 'mixed2', shape: 'mixed2', spans: mixed('mix2', 'mixed2', 0, 1) })

  // 8. An attribute matrix: v is missing, int, float, string, bool or a
  // duration string; w pairs with v as an equal, a different or a
  // mismatched value; intrinsic durations vary too.
  out.push({
    name: 'attrs',
    shape: 'attrs',
    spans: [
      span('am_root', null, { shape: 'attrs' }, { duration: 500 }),
      span('am_missing', 'am_root', { shape: 'attrs', w: '1' }, { duration: 1 }),
      span('am_int', 'am_root', { shape: 'attrs', v: '200', w: '200' }, { duration: 2 }),
      span('am_int_neg', 'am_root', { shape: 'attrs', v: '-3', w: '7' }, { duration: 3 }),
      span('am_float', 'am_root', { shape: 'attrs', v: '1.5', w: 'abc' }, { duration: 250 }),
      span('am_str', 'am_root', { shape: 'attrs', v: 'abc', w: 'abc' }, { duration: 100 }),
      span('am_bool', 'am_root', { shape: 'attrs', v: 'true', w: 'false' }, { duration: 50 }),
      span('am_dur', 'am_root', { shape: 'attrs', v: '5ms' }, { duration: 5 })
    ]
  })

  // 9. Time-range edges.
  out.push({
    name: 'edge_chain',
    shape: 'edge',
    spans: [
      span('ec_root', null, { shape: 'edge', role: 'root' }, { start: -HOUR }),
      span('ec_mid', 'ec_root', { shape: 'edge', role: 'mid' }, { start: -10 * MINUTE }),
      span('ec_leaf', 'ec_mid', { shape: 'edge', role: 'leaf' })
    ]
  })
  out.push({
    name: 'edge_bound',
    shape: 'edge',
    spans: [
      span('eb_root', null, { shape: 'edge', role: 'root' }, { start: -5 * SECOND }),
      span('eb_from', 'eb_root', { shape: 'edge', role: 'sibling' }, { start: 0 }),
      span('eb_mid', 'eb_root', { shape: 'edge', role: 'sibling' }),
      span('eb_to', 'eb_root', { shape: 'edge', role: 'sibling' }, { start: WINDOW })
    ]
  })
  out.push({
    name: 'edge_late',
    shape: 'edge',
    spans: [
      span('el_a', null, { shape: 'edge', role: 'root' }),
      span('el_b', 'el_a', { shape: 'edge', role: 'late' }, { start: WINDOW + 5 * MINUTE })
    ]
  })

  // 10. Nested-set numbering, after every case's range: tied roots and
  // siblings, a duplicate span id whose later copy starts first, a
  // self-parent, a cycle with a child, and a late span that starts first
  // under its root.
  {
    const at = (ms) => ({ start: WINDOW + 15 * MINUTE + ms })
    const ns = { shape: 'nested' }
    out.push({
      name: 'nested',
      shape: 'nested',
      spans: [
        span('ns_r1', null, ns, at(0)),
        span('ns_r2', null, ns, at(0)),
        span('ns_a', 'ns_r1', ns, at(1000)),
        span('ns_b', 'ns_r1', ns, at(1000)),
        span('ns_dup', 'ns_r1', ns, at(3000)),
        span('ns_dup_early', 'ns_r1', ns, { ...at(500), sameId: 'ns_dup' }),
        span('ns_dup_c', 'ns_dup', ns, at(4000)),
        span('ns_r2c', 'ns_r2', ns, at(2000)),
        span('ns_self', 'ns_self', ns, at(5000)),
        span('ns_cyc1', 'ns_cyc2', ns, at(6000)),
        span('ns_cyc2', 'ns_cyc1', ns, at(7000)),
        span('ns_cyc_c', 'ns_cyc1', ns, at(8000)),
        span('ns_late', 'ns_r1', ns, { ...at(200), push: 2 })
      ]
    })
  }

  if (clock >= WINDOW) throw new Error(`seed overflows the window: ${clock}ms`)
  return out
}

const hex = (n, width) => n.toString(16).padStart(width, '0')

/**
 * ids assigns trace and span ids: a 24-hex run prefix plus the trace index,
 * and the trace index plus the span index. Ids are lowercase hex.
 * @param prefix {string} 24 hex chars
 */
const ids = (prefix, ts = traces()) => {
  if (!/^[0-9a-f]{24}$/.test(prefix)) throw new Error(`bad trace id prefix ${prefix}`)
  const byTrace = {}
  const bySpan = {}
  ts.forEach((t, ti) => {
    const traceId = prefix + hex(ti + 1, 8)
    byTrace[t.name] = traceId
    t.spans.forEach((s, si) => { bySpan[s.name] = s.sameId ? bySpan[s.sameId] : hex(ti + 1, 8) + hex(si + 1, 8) })
    // Missing parents get ids no seeded span uses.
    t.spans.forEach((s, si) => {
      if (s.parent && s.parent.startsWith('missing:')) bySpan[s.parent] = hex(ti + 1, 8) + hex(0xffff0000 + si, 8)
    })
  })
  return { trace: byTrace, span: bySpan }
}

/**
 * zipkinBatches returns the Zipkin v2 JSON spans to push, one array per push.
 * @param from {number} FROM in ms
 * @param prefix {string} trace id prefix (24 hex chars)
 * @param testId {string} test_id attribute on every span
 */
const zipkinBatches = (from, prefix, testId, ts = traces()) => {
  const id = ids(prefix, ts)
  const batches = []
  for (const t of ts) {
    for (const s of t.spans) {
      const z = {
        traceId: id.trace[t.name],
        id: id.span[s.name],
        name: s.name,
        timestamp: (from + s.start) * 1000,
        duration: s.duration * 1000,
        localEndpoint: { serviceName: `grid-${t.shape}` },
        tags: { ...s.attrs, test_id: testId }
      }
      if (s.parent) z.parentId = id.span[s.parent]
      ;(batches[s.push] = batches[s.push] || []).push(z)
    }
  }
  return batches
}

module.exports = { SECOND, MINUTE, HOUR, WINDOW, SUITE, window, traces, ids, zipkinBatches }

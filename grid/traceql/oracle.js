// Reference evaluator for the TraceQL grid: computes the expected search
// result of a case's AST from the seed. It encodes gigapipe's contract.

const seed = require('./seed')

const DEFAULT_SPSS = 3

// ROUNDS is the ancestry round limit of the e2e stack: ancestry resolves up
// to 2^ROUNDS spans deep.
const ROUNDS = 3

// UNRESOLVED is the result of a search that hits the ancestry round limit.
const UNRESOLVED = { error: 'unresolved ancestry' }

class Unresolved extends Error {}

const DURATION_UNITS = { ns: 1, us: 1e3, µs: 1e3, ms: 1e6, s: 1e9, m: 60e9, h: 3600e9 }

const durationNs = (text) => {
  const m = /^(-?\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)$/.exec(text)
  if (!m) throw new Error(`oracle: bad duration ${text}`)
  return parseFloat(m[1]) * DURATION_UNITS[m[2]]
}

// storedAttrs returns the attributes the writer indexes for a Zipkin span.
const storedAttrs = (trace, span, testId) => {
  const attrs = { ...span.attrs, test_id: testId, name: span.name }
  const service = `grid-${trace.shape}`
  attrs.local_endpoint_service_name = service
  attrs['service.name'] = service
  const status = { ERROR: 'error', OK: 'ok' }[attrs['otel.status_code']]
  if (status) attrs.status = status
  return attrs
}

/**
 * dataset flattens the seed into spans with absolute times:
 * {trace, name, traceId, spanId, parentId, start (ms), durationNs, push, attrs}.
 * @param from {number} FROM in ms
 * @param prefix {string} trace id prefix
 * @param testId {string}
 */
const dataset = (from, prefix, testId) => {
  const ts = seed.traces()
  const id = seed.ids(prefix, ts)
  const spans = []
  for (const t of ts) {
    for (const s of t.spans) {
      spans.push({
        trace: t.name,
        name: s.name,
        traceId: id.trace[t.name],
        spanId: id.span[s.name],
        parentId: s.parent ? id.span[s.parent] : null,
        start: from + s.start,
        durationNs: s.duration * 1e6,
        push: s.push,
        attrs: storedAttrs(t, s, testId)
      })
    }
  }
  return spans
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

const compare = (op, a, b) => {
  switch (op) {
    case '=': return a === b
    case '!=': return a !== b
    case '>': return a > b
    case '>=': return a >= b
    case '<': return a < b
    case '<=': return a <= b
  }
  throw new Error(`oracle: comparison ${op}`)
}

// attrKey strips the scope; span and resource attributes share one namespace.
const attrKey = (attr) => {
  for (const scope of ['span.', 'resource.', '.']) {
    if (attr.startsWith(scope)) return attr.slice(scope.length)
  }
  return null
}

const INTRINSIC_KEYS = { name: 'name', 'span:name': 'name', status: 'status', kind: 'kind' }

// comparison evaluates `attr op literal` on a span.
const comparison = (span, { op, lhs, rhs }) => {
  if (lhs.attr === undefined) throw new Error('oracle: comparison lhs must be an attribute')
  if (lhs.attr === 'duration' || lhs.attr === 'span:duration') {
    if (rhs.dur === undefined) throw new Error('oracle: duration compares with a duration literal')
    return compare(op, span.durationNs, durationNs(rhs.dur))
  }
  const key = attrKey(lhs.attr) || INTRINSIC_KEYS[lhs.attr]
  if (!key) throw new Error(`oracle: attribute ${lhs.attr}`)
  const val = span.attrs[key]
  if (val === undefined) return false
  if (rhs.num !== undefined) return NUMBER.test(val) && compare(op, parseFloat(val), rhs.num)
  const text = rhs.str !== undefined ? rhs.str : rhs.enum
  if (text === undefined) throw new Error(`oracle: literal ${JSON.stringify(rhs)}`)
  if (op === '=~') return new RegExp(text).test(val)
  if (op === '!~') return !new RegExp(text).test(val)
  if (op !== '=' && op !== '!=') throw new Error(`oracle: string comparison ${op}`)
  return compare(op, val, text)
}

const matches = (span, f) => {
  if (f.paren !== undefined) return matches(span, f.paren)
  if (f.op === '&&') return matches(span, f.lhs) && matches(span, f.rhs)
  if (f.op === '||') return matches(span, f.lhs) || matches(span, f.rhs)
  return comparison(span, f)
}

// union returns the spans of both lists, each once, in first-seen order.
const union = (a, b) => [...new Set([...a, ...b])]

// reachable returns the ids of the spans whose parent chain ends at a root,
// keyed by trace id. Every span counts, whenever it starts.
const reachable = (spans) => {
  const byId = new Map(spans.map(s => [`${s.traceId}/${s.spanId}`, s]))
  const out = new Set()
  for (const s of spans) {
    const seen = new Set()
    let cur = s
    while (cur && cur.parentId !== null && !seen.has(cur)) {
      seen.add(cur)
      cur = byId.get(`${cur.traceId}/${cur.parentId}`)
    }
    if (cur && cur.parentId === null) out.add(`${s.traceId}/${s.spanId}`)
  }
  return out
}

// hops returns how many parent links lead up from s before a root or a span
// whose parent is missing; Infinity on a parent cycle.
const hops = (s, byId) => {
  const seen = new Set()
  let n = 0
  for (let cur = s; cur.parentId !== null; n++) {
    if (seen.has(cur)) return Infinity
    seen.add(cur)
    cur = byId.get(`${cur.traceId}/${cur.parentId}`)
    if (!cur) return n
  }
  return n
}

// guard throws Unresolved when a span of the given traces is at least
// 2^rounds parent links from a root or a missing parent.
const guard = (traceIds, ctx) => {
  for (const s of ctx.spans) {
    if (traceIds.has(s.traceId) && hops(s, ctx.byId) >= 2 ** ctx.rounds) throw new Unresolved()
  }
}

const traceIds = (ss) => new Set(ss.map(s => s.traceId))

// related lists the [l, r] pairs of one trace where rel(l, r) holds and both
// spans reach a root.
const related = (lhs, rhs, rel, ctx) => {
  const ok = (s) => ctx.reach.has(`${s.traceId}/${s.spanId}`)
  const pairs = []
  for (const r of rhs.filter(ok)) {
    for (const l of lhs.filter(ok)) {
      if (l.traceId === r.traceId && rel(l, r)) pairs.push([l, r])
    }
  }
  return pairs
}

// result applies the operator kind to related pairs: plain returns the
// related RHS spans, `&` adds the related LHS spans and `!` returns the
// unrelated RHS spans.
const result = (kind, lhs, rhs, pairs) => {
  const matched = new Set(pairs.map(([, r]) => r))
  if (kind === '!') return rhs.filter(r => !matched.has(r))
  if (kind === '&') return union(rhs.filter(r => matched.has(r)), lhs.filter(l => pairs.some(([pl]) => pl === l)))
  return rhs.filter(r => matched.has(r))
}

// ONE_HOP relates a LHS span l to a RHS span r of the same trace; all roots
// of a trace are siblings.
const ONE_HOP = {
  '>': (l, r) => r.parentId === l.spanId,
  '<': (l, r) => l.parentId === r.spanId,
  '~': (l, r) => l.parentId === r.parentId && l.spanId !== r.spanId
}

// oneHop evaluates a one-hop operator. Traces with a root and a missing
// parent resolve root reachability by pointer jumping, under the round limit.
const oneHop = (op, lhs, rhs, ctx) => {
  const rt = traceIds(rhs)
  const candidates = [...traceIds(lhs)].filter(id => rt.has(id))
  const incomplete = candidates.filter(id => {
    const ss = ctx.spans.filter(s => s.traceId === id)
    return ss.some(s => s.parentId === null) && ss.some(s => s.parentId !== null && !ctx.byId.has(`${id}/${s.parentId}`))
  })
  guard(new Set(incomplete), ctx)
  const kind = op.length === 2 ? op[0] : ''
  return result(kind, lhs, rhs, related(lhs, rhs, ONE_HOP[op[op.length - 1]], ctx))
}

// isAncestor reports whether a is a strict ancestor of s.
const isAncestor = (a, s, ctx) => {
  const seen = new Set()
  for (let cur = ctx.byId.get(`${s.traceId}/${s.parentId}`); cur && !seen.has(cur); cur = ctx.byId.get(`${cur.traceId}/${cur.parentId}`)) {
    if (cur === a) return true
    seen.add(cur)
  }
  return false
}

// transitive evaluates `>>` (an ancestor of the RHS span matches the LHS) or
// `<<` (a descendant does) and their `!` and `&` variants. Every span of the
// traces where both sides yield spans must resolve under the round limit.
const transitive = (op, lhs, rhs, ctx) => {
  const rt = traceIds(rhs)
  guard(new Set([...traceIds(lhs)].filter(id => rt.has(id))), ctx)
  const kind = op.length === 3 ? op[0] : ''
  const rel = op.endsWith('>>') ? (l, r) => isAncestor(l, r, ctx) : (l, r) => isAncestor(r, l, ctx)
  return result(kind, lhs, rhs, related(lhs, rhs, rel, ctx))
}

// spansetSpans returns the spans a spanset expression yields. `&&` keeps both
// sides' spans in traces where both sides yield spans; `||` keeps either side's.
// Selectors match only spans, the operands; ctx holds every span of the seed
// (spans, byId), the root-reachable span keys (reach) and the round limit.
const spansetSpans = (expr, spans, ctx) => {
  if (expr.paren !== undefined) return spansetSpans(expr.paren, spans, ctx)
  if (expr.pipeline !== undefined) return pipelineSpansets(expr.pipeline, spans, ctx).flatMap(ss => ss.spans)
  if (expr.selector !== undefined) {
    return expr.selector === null ? spans : spans.filter(s => matches(s, expr.selector))
  }
  const lhs = spansetSpans(expr.lhs, spans, ctx)
  const rhs = spansetSpans(expr.rhs, spans, ctx)
  if (expr.spansetOp === '||') return union(lhs, rhs)
  if (expr.spansetOp === '&&') {
    const lt = traceIds(lhs)
    const rt = traceIds(rhs)
    return union(lhs.filter(s => rt.has(s.traceId)), rhs.filter(s => lt.has(s.traceId)))
  }
  if (/^[!&]?[<>~]$/.test(expr.spansetOp)) return oneHop(expr.spansetOp, lhs, rhs, ctx)
  if (/^[!&]?(>>|<<)$/.test(expr.spansetOp)) return transitive(expr.spansetOp, lhs, rhs, ctx)
  throw new Error(`oracle: unsupported spanset expression ${JSON.stringify(expr)}`)
}

// INT matches the stored values ClickHouse reads as integers.
const INT = /^[+-]?\d+$/

// aggregateValue returns a span's value of an aggregate argument as
// {num, int}, a duration in ns, or null when it has none.
const aggregateValue = (s, attr) => {
  if (attr === 'duration' || attr === 'span:duration') return { num: s.durationNs, int: true }
  const key = attrKey(attr)
  if (!key) throw new Error(`oracle: aggregate argument ${attr}`)
  const val = s.attrs[key]
  return val !== undefined && NUMBER.test(val) ? { num: parseFloat(val), int: INT.test(val) } : null
}

/**
 * aggregate evaluates an aggregate over a spanset's spans: {type, value} with
 * type 'int', 'float' or 'duration' (value in ns), or null when no span has a
 * value. sum is an int when every value is one; min and max take the type of
 * the winning value; avg is a float, or a duration truncated to whole ns.
 */
const aggregate = ({ agg, attr }, spans) => {
  if (agg === 'count') return { type: 'int', value: spans.length }
  const vals = spans.map(s => aggregateValue(s, attr)).filter(v => v !== null)
  if (!vals.length) return null
  const duration = attr === 'duration' || attr === 'span:duration'
  const typed = (int, value) => ({ type: duration ? 'duration' : int ? 'int' : 'float', value })
  const sum = vals.reduce((a, v) => a + v.num, 0)
  switch (agg) {
    case 'sum': return typed(vals.every(v => v.int), sum)
    case 'min':
    case 'max': {
      const win = vals.reduce((w, v) => (agg === 'min' ? v.num < w.num : v.num > w.num) ? v : w)
      return typed(win.int, win.num)
    }
    case 'avg': return duration ? typed(true, Math.trunc(sum / vals.length)) : typed(false, sum / vals.length)
  }
  throw new Error(`oracle: aggregate ${agg}`)
}

// scalarValue is a literal as a number: a duration in ns.
const scalarValue = (x) => {
  if (x.num !== undefined) return x.num
  if (x.dur !== undefined) return durationNs(x.dur)
  throw new Error(`oracle: scalar filter right-hand side ${JSON.stringify(x)}`)
}

// scalarFilter keeps the spansets whose aggregate passes the comparison and
// appends the aggregate to their attributes; a spanset without a value fails.
const scalarFilter = ({ op, lhs, rhs }, sets) => {
  if (lhs.agg === undefined) throw new Error('oracle: scalar filter lhs must be an aggregate')
  const want = scalarValue(rhs)
  const key = `${lhs.agg}(${lhs.attr || ''})`
  const out = []
  for (const ss of sets) {
    const v = aggregate(lhs, ss.spans)
    if (v !== null && compare(op, v.value, want)) out.push({ ...ss, attributes: [...ss.attributes, [key, v]] })
  }
  return out
}

// spansetsOf groups spans into one spanset per trace, without attributes.
const spansetsOf = (spans) => {
  const byTrace = new Map()
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, [])
    byTrace.get(s.traceId).push(s)
  }
  return [...byTrace.values()].map(ss => ({ traceId: ss[0].traceId, spans: ss, attributes: [] }))
}

// pipelineSpansets evaluates a pipeline over spans, the operand candidates:
// a spanset expression and then scalar filters, or scalar filters over every
// span.
const pipelineSpansets = (elements, spans, ctx) => {
  let sets = null
  elements.forEach((e, i) => {
    if (e.scalarFilter !== undefined) {
      sets = scalarFilter(e.scalarFilter, sets || spansetsOf(spans))
      return
    }
    if (i > 0) throw new Error('oracle: unsupported spanset filter after a pipeline stage')
    sets = spansetsOf(spansetSpans(e, spans, ctx))
  })
  return sets
}

// newestFirst orders spans by start time, then span id, both descending.
const newestFirst = (a, b) => b.start - a.start || (a.spanId < b.spanId ? 1 : a.spanId > b.spanId ? -1 : 0)

/**
 * resultSpansets returns the spansets a pipeline yields, one per trace with
 * its spans and attributes ([name, {type, value}]), or UNRESOLVED when
 * ancestry does not resolve within the round limit. Operand spans start in
 * (from, to]; parents, ancestors, siblings and roots count wherever they start.
 * @param pipeline {Object[]} the pipeline of the case AST
 * @param all {Object[]} from dataset(); with opts.pushes only the spans of
 *   the first `pushes` ingest batches count
 * @param opts {{from: number, to: number, rounds?: number, pushes?: number}}
 */
const resultSpansets = (pipeline, all, { from, to, rounds = ROUNDS, pushes }) => {
  const spans = pushes === undefined ? all : all.filter(s => s.push < pushes)
  const inRange = spans.filter(s => s.start > from && s.start <= to)
  const ctx = { spans, byId: new Map(spans.map(s => [`${s.traceId}/${s.spanId}`, s])), reach: reachable(spans), rounds }
  try {
    return pipelineSpansets(pipeline, inRange, ctx)
  } catch (e) {
    if (e instanceof Unresolved) return UNRESOLVED
    throw e
  }
}

/**
 * resultSpans returns the spans of resultSpansets(), or UNRESOLVED.
 */
const resultSpans = (pipeline, all, opts) => {
  const sets = resultSpansets(pipeline, all, opts)
  return sets === UNRESOLVED ? UNRESOLVED : sets.flatMap(ss => ss.spans)
}

// MICRO is Go's microsecond sign.
const MICRO = '\u00b5'

// fraction prints v / unit with the fraction's trailing zeros dropped.
const fraction = (v, unit) => {
  const digits = String(unit).length - 1
  const frac = String(v % unit).padStart(digits, '0').replace(/0+$/, '')
  return String(Math.floor(v / unit)) + (frac ? `.${frac}` : '')
}

/**
 * goDuration formats whole nanoseconds like Go's time.Duration.String().
 * @param ns {number}
 */
const goDuration = (ns) => {
  if (ns < 0) return `-${goDuration(-ns)}`
  if (ns === 0) return '0s'
  if (ns < 1e3) return `${ns}ns`
  if (ns < 1e6) return `${fraction(ns, 1e3)}${MICRO}s`
  if (ns < 1e9) return `${fraction(ns, 1e6)}ms`
  const h = Math.floor(ns / 3600e9)
  const m = Math.floor((ns % 3600e9) / 60e9)
  return (h ? `${h}h` : '') + (h || m ? `${m}m` : '') + `${fraction(ns % 60e9, 1e9)}s`
}

/**
 * attributeValue is an aggregate as the OTLP value search returns: an int as
 * a decimal string, a float as a double, a duration as a Go duration string.
 */
const attributeValue = ({ type, value }) => {
  if (type === 'int') return { intValue: String(value) }
  if (type === 'duration') return { stringValue: goDuration(value) }
  return { doubleValue: value }
}

/**
 * search returns the expected traces of a search, newest first:
 * [{trace, traceId, spans: [span name, ...], matched, attributes}], or
 * UNRESOLVED when ancestry does not resolve within the round limit. The
 * spansets are resultSpansets(); a trace lists its spss newest result spans
 * and its attributes as {name: OTLP value}; limit counts traces by their
 * newest result span (ties by trace id, descending).
 * @param query {Object} the case AST
 * @param all {Object[]} from dataset()
 * @param opts {{from: number, to: number, limit: number, spss?: number, rounds?: number, pushes?: number}}
 */
const search = (query, all, opts) => {
  const { limit, spss = DEFAULT_SPSS } = opts
  const sets = resultSpansets(query.pipeline, all, opts)
  if (sets === UNRESOLVED) return UNRESOLVED
  const traces = sets.map(ss => ({ ...ss, spans: [...ss.spans].sort(newestFirst) }))
  traces.sort((a, b) => b.spans[0].start - a.spans[0].start || (a.traceId < b.traceId ? 1 : -1))
  return traces.slice(0, limit).map(ss => ({
    trace: ss.spans[0].trace,
    traceId: ss.traceId,
    spans: ss.spans.slice(0, spss).map(s => s.name),
    matched: ss.spans.length,
    attributes: Object.fromEntries(ss.attributes.map(([k, v]) => [k, attributeValue(v)]))
  }))
}

module.exports = { DEFAULT_SPSS, ROUNDS, UNRESOLVED, dataset, matches, resultSpans, search, durationNs, goDuration }

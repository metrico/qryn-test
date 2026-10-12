// Reference evaluator for the TraceQL grid: computes the expected search
// result of a case's AST from the seed. It encodes gigapipe's contract.

const seed = require('./seed')

const DEFAULT_SPSS = 3

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
 * {trace, name, traceId, spanId, parentId, start (ms), durationNs, attrs}.
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

// spansetSpans returns the spans a spanset expression yields.
const spansetSpans = (expr, spans) => {
  if (expr.paren !== undefined) return spansetSpans(expr.paren, spans)
  if (expr.selector !== undefined) {
    return expr.selector === null ? spans : spans.filter(s => matches(s, expr.selector))
  }
  throw new Error(`oracle: unsupported spanset expression ${JSON.stringify(expr)}`)
}

// newestFirst orders spans by start time, then span id, both descending.
const newestFirst = (a, b) => b.start - a.start || (a.spanId < b.spanId ? 1 : a.spanId > b.spanId ? -1 : 0)

/**
 * search returns the expected traces of a search, newest first:
 * [{trace, traceId, spans: [span name, ...], matched}]. Operand spans start in
 * (from, to]; a trace lists its spss newest result spans; limit counts traces
 * by their newest result span (ties by trace id, descending).
 * @param query {Object} the case AST
 * @param spans {Object[]} from dataset()
 * @param opts {{from: number, to: number, limit: number, spss?: number}}
 */
const search = (query, spans, { from, to, limit, spss = DEFAULT_SPSS }) => {
  if (query.pipeline.length !== 1) throw new Error('oracle: pipelines of one spanset expression only')
  const inRange = spans.filter(s => s.start > from && s.start <= to)
  const byTrace = new Map()
  for (const s of spansetSpans(query.pipeline[0], inRange)) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, [])
    byTrace.get(s.traceId).push(s)
  }
  const traces = [...byTrace.values()].map(ss => ss.sort(newestFirst))
  traces.sort((a, b) => b[0].start - a[0].start || (a[0].traceId < b[0].traceId ? 1 : -1))
  return traces.slice(0, limit).map(ss => ({
    trace: ss[0].trace,
    traceId: ss[0].traceId,
    spans: ss.slice(0, spss).map(s => s.name),
    matched: ss.length
  }))
}

module.exports = { DEFAULT_SPSS, dataset, search, durationNs }

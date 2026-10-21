// Reference evaluator for the TraceQL grid: computes the expected search
// result of a case's AST from the seed. It encodes gigapipe's contract.

const seed = require('./seed')
const { canonicalScalar, canonicalField } = require('./ast')

const DEFAULT_SPSS = 3

// ROUNDS is the ancestry round limit of the e2e stack: ancestry resolves up
// to 2^ROUNDS spans deep.
const ROUNDS = 3

// UNRESOLVED is the result of a search that hits the ancestry round limit.
const UNRESOLVED = { error: 'unresolved ancestry' }

// GROUPED is the result of a query with a spanset operator over grouped
// spansets: gigapipe rejects it before evaluation.
const GROUPED = { error: 'spanset operators are not supported for multiple spansets per trace. consider using coalesce()' }

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

const INTRINSIC_KEYS = {
  name: 'name',
  'span:name': 'name',
  status: 'status',
  kind: 'kind',
  statusMessage: 'statusMessage',
  rootName: 'name',
  rootServiceName: 'service.name'
}

const isDuration = (attr) => attr === 'duration' || attr === 'span:duration'

// INT matches the stored values ClickHouse reads as integers.
const INT = /^[+-]?\d+$/

const ARITHMETIC = ['+', '-', '*', '/', '%', '^']

/**
 * Field expressions evaluate under the nil rule: a missing attribute, a value
 * that does not cast and an integer division or modulo by zero are nil (null),
 * nil propagates through arithmetic, and a comparison with nil is false. An
 * attribute is cast to the type of the operand it meets; two attributes
 * compare as numbers when both are, as strings when neither is, and are nil
 * otherwise. `!x` and `x` as a condition are false unless x is a boolean.
 */

// domain is the type a field node casts to: 'num', 'str', 'bool', or 'any'
// for an attribute.
const domain = (f) => {
  if (f.paren !== undefined) return domain(f.paren)
  if (f.attr !== undefined) {
    if (isDuration(f.attr)) return 'num'
    return attrKey(f.attr) === null && INTRINSIC_KEYS[f.attr] ? 'str' : 'any'
  }
  if (f.num !== undefined || f.dur !== undefined) return 'num'
  if (f.str !== undefined || f.enum !== undefined) return 'str'
  if (f.unary !== undefined) return f.unary === '-' ? 'num' : 'bool'
  if (f.op !== undefined) return ARITHMETIC.includes(f.op) ? 'num' : 'bool'
  return 'bool'
}

// raw is an attribute's stored text, or null when the span lacks it.
const raw = (span, attr) => {
  const key = attrKey(attr) || INTRINSIC_KEYS[attr]
  if (!key) throw new Error(`oracle: attribute ${attr}`)
  const val = span.attrs[key]
  return val === undefined ? null : val
}

// num evaluates a numeric node to {v, int} or null; a duration is in ns.
const num = (span, f) => {
  if (f.paren !== undefined) return num(span, f.paren)
  if (f.attr !== undefined) {
    if (isDuration(f.attr)) return { v: span.durationNs, int: false }
    const val = raw(span, f.attr)
    return val !== null && NUMBER.test(val) ? { v: parseFloat(val), int: INT.test(val) } : null
  }
  if (f.num !== undefined) return { v: f.num, int: Number.isInteger(f.num) }
  if (f.dur !== undefined) return { v: durationNs(f.dur), int: false }
  if (f.unary === '-') {
    const x = num(span, f.expr)
    return x && { v: -x.v, int: x.int }
  }
  if (ARITHMETIC.includes(f.op)) {
    const l = num(span, f.lhs)
    const r = num(span, f.rhs)
    if (l === null || r === null) return null
    const int = l.int && r.int
    switch (f.op) {
      case '+': return { v: l.v + r.v, int }
      case '-': return { v: l.v - r.v, int }
      case '*': return { v: l.v * r.v, int }
      case '/': return int ? (r.v === 0 ? null : { v: Math.trunc(l.v / r.v), int }) : { v: l.v / r.v, int }
      case '%': return int && r.v === 0 ? null : { v: l.v % r.v, int }
      case '^': return { v: Math.pow(l.v, r.v), int }
    }
  }
  throw new Error(`oracle: not a number ${JSON.stringify(f)}`)
}

// str evaluates a string node, or null.
const str = (span, f) => {
  if (f.paren !== undefined) return str(span, f.paren)
  if (f.attr !== undefined) return raw(span, f.attr)
  if (f.str !== undefined) return f.str
  if (f.enum !== undefined) return f.enum
  throw new Error(`oracle: not a string ${JSON.stringify(f)}`)
}

// bool evaluates a boolean node to true, false or null (not a boolean).
const bool = (span, f) => {
  if (f.paren !== undefined) return bool(span, f.paren)
  if (f.attr !== undefined) {
    const val = raw(span, f.attr)
    return val === 'true' ? true : val === 'false' ? false : null
  }
  if (f.bool !== undefined) return f.bool
  if (f.unary === '!') {
    const x = bool(span, f.expr)
    return x === null ? false : !x
  }
  if (f.op === '&&') return bool(span, f.lhs) === true && bool(span, f.rhs) === true
  if (f.op === '||') return bool(span, f.lhs) === true || bool(span, f.rhs) === true
  if (f.op !== undefined) return comparison(span, f)
  throw new Error(`oracle: not a boolean ${JSON.stringify(f)}`)
}

// value evaluates a node in its own domain, null when nil.
const value = (span, f) => {
  switch (domain(f)) {
    case 'num': return num(span, f)
    case 'bool': return bool(span, f)
  }
  return str(span, f)
}

const regex = (op, text, re) => {
  if (text === null) return false
  const m = new RegExp(re).test(text)
  return op === '=~' ? m : !m
}

// comparison evaluates `lhs op rhs`, false when either side is nil.
const comparison = (span, { op, lhs, rhs }) => {
  if (rhs.nil !== undefined || lhs.nil !== undefined) {
    if (rhs.nil !== undefined && lhs.nil !== undefined) return false
    const present = value(span, rhs.nil !== undefined ? lhs : rhs) !== null
    return op === '!=' ? present : !present
  }
  const d = domain(lhs) !== 'any' ? domain(lhs) : domain(rhs)
  const both = (evaluate) => {
    const a = evaluate(span, lhs)
    const b = evaluate(span, rhs)
    return a === null || b === null ? null : [a, b]
  }
  let pair
  switch (d) {
    case 'num':
      pair = both(num)
      return pair !== null && compare(op, pair[0].v, pair[1].v)
    case 'bool':
      pair = both(bool)
      return pair !== null && compare(op, pair[0], pair[1])
    case 'str':
      if (op === '=~' || op === '!~') return regex(op, str(span, lhs), str(span, rhs))
      pair = both(str)
      return pair !== null && compare(op, pair[0], pair[1])
  }
  pair = both(str)
  if (pair === null) return false
  const [a, b] = pair.map(x => NUMBER.test(x) ? parseFloat(x) : null)
  if (a !== null && b !== null) return compare(op, a, b)
  return a === null && b === null && compare(op, pair[0], pair[1])
}

// matches reports whether a span passes a spanset filter.
const matches = (span, f) => bool(span, f) === true

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

// argOf is an aggregate's argument as a field node.
const argOf = (x) => x.arg || { attr: x.attr }

// staticType is the type of a field node before it reads a span: an
// arithmetic result has the type of its first operand that is not an
// attribute.
const staticType = (f) => {
  if (f.paren !== undefined) return staticType(f.paren)
  if (f.attr !== undefined) return isDuration(f.attr) ? 'duration' : 'attr'
  if (f.dur !== undefined) return 'duration'
  if (f.num !== undefined) return 'number'
  if (f.unary !== undefined) return staticType(f.expr)
  const l = staticType(f.lhs)
  return l !== 'attr' ? l : staticType(f.rhs)
}

/**
 * aggregate evaluates an aggregate over a spanset's spans: {type, value} with
 * type 'int', 'float' or 'duration' (value in ns), or null when no span has a
 * value. sum is an int when every value is one; min and max take the type of
 * the winning value; avg is a float, or a duration truncated to whole ns.
 */
const aggregate = (x, spans) => {
  const { agg } = x
  if (agg === 'count') return { type: 'int', value: spans.length }
  const arg = argOf(x)
  const vals = spans.map(s => num(s, arg)).filter(v => v !== null).map(v => ({ num: v.v, int: v.int }))
  if (!vals.length) return null
  const duration = staticType(arg) === 'duration'
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
  const key = canonicalScalar(lhs)
  const out = []
  for (const ss of sets) {
    const v = aggregate(lhs, ss.spans)
    if (v !== null && compare(op, v.value, want)) out.push({ ...ss, attributes: [...ss.attributes, [key, v]] })
  }
  return out
}

// spansetsOf groups spans into one spanset per trace, without attributes or
// group key.
const spansetsOf = (spans) => {
  const byTrace = new Map()
  for (const s of spans) {
    if (!byTrace.has(s.traceId)) byTrace.set(s.traceId, [])
    byTrace.get(s.traceId).push(s)
  }
  return [...byTrace.values()].map(ss => ({ traceId: ss[0].traceId, spans: ss, attributes: [], key: [] }))
}

const NIL_KEY = { rank: 3, value: 0, text: '', type: 'nil' }

/**
 * groupValue is a span's value of a by() expression as a group key element:
 * {rank, value, text, type}. Keys order by rank, value, then text: numbers,
 * bools, strings, then nil. A number keeps its type (a duration in ns); an
 * attribute is its stored text, which orders as a number when it is one.
 */
const groupValue = (span, f) => {
  switch (domain(f)) {
    case 'num': {
      const n = num(span, f)
      if (n === null) return NIL_KEY
      const type = staticType(f) === 'duration' ? 'duration' : n.int ? 'int' : 'float'
      return { rank: 0, value: n.v, text: '', type }
    }
    case 'bool': return { rank: 1, value: bool(span, f) ? 1 : 0, text: '', type: 'bool' }
    case 'str': {
      const t = str(span, f)
      return t === null ? NIL_KEY : { rank: 2, value: 0, text: t, type: 'string' }
    }
  }
  const t = str(span, f)
  if (t === null) return NIL_KEY
  return NUMBER.test(t) && isFinite(parseFloat(t))
    ? { rank: 0, value: parseFloat(t), text: t, type: 'string' }
    : { rank: 2, value: 0, text: t, type: 'string' }
}

const compareKeys = (a, b) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    for (const f of ['rank', 'value', 'text', 'type']) {
      if (a[i][f] !== b[i][f]) return a[i][f] < b[i][f] ? -1 : 1
    }
  }
  return a.length - b.length
}

// groupBy splits each spanset by the value of expr per span, appending it to
// the group key and, named by the stage, to the attributes.
const groupBy = (expr, sets) => {
  const name = `by(${canonicalField(expr)})`
  return sets.flatMap(ss => {
    const groups = new Map()
    for (const s of ss.spans) {
      const v = groupValue(s, expr)
      const id = JSON.stringify(v)
      if (!groups.has(id)) groups.set(id, { traceId: ss.traceId, spans: [], key: [...ss.key, v], attributes: [...ss.attributes, [name, v]] })
      groups.get(id).spans.push(s)
    }
    return [...groups.values()]
  })
}

// coalesce merges the spansets of each trace into one without attributes.
const coalesce = (sets) => spansetsOf(sets.flatMap(ss => ss.spans))

// referencesSpan reports whether a field expression reads an attribute.
const referencesSpan = (f) => f.attr !== undefined ||
  [f.paren, f.expr, f.lhs, f.rhs].some(x => x !== undefined && referencesSpan(x))

// checkGroupBys throws Invalid for a by() that reads no attribute.
const checkGroupBys = (elements) => {
  for (const e of elements) {
    if (e.groupBy !== undefined && !referencesSpan(e.groupBy)) {
      throw new Invalid(`grouping field expressions must reference the span: by(${canonicalField(e.groupBy)})`)
    }
    for (let x = e; x !== undefined; x = x.paren) {
      if (x.pipeline !== undefined) checkGroupBys(x.pipeline)
      if (x.spansetOp !== undefined) checkGroupBys([x.lhs, x.rhs])
    }
  }
}

const SELECT_ERROR = 'syntax error: select() takes attributes and intrinsics only'

// LISTED are the intrinsics every listed span or trace carries, so select()
// adds nothing for them.
const LISTED = ['duration', 'span:duration', 'span:id', 'traceDuration', 'trace:duration', 'trace:id',
  'rootName', 'trace:rootName', 'rootServiceName', 'trace:rootService']

// SPAN_NAME is the key of a listed span's selected name.
const SPAN_NAME = '#name'

// isFieldName reports whether an attribute node names a scoped attribute or
// an intrinsic.
const isFieldName = (attr) => attrKey(attr) !== null || INTRINSIC_KEYS[attr] !== undefined || LISTED.includes(attr)

// selects returns the select() stages of a pipeline, nested pipelines included.
const selects = (elements) => elements.flatMap(e => {
  if (e.select !== undefined) return [e.select]
  for (let x = e; x !== undefined; x = x.paren) {
    if (x.pipeline !== undefined) return selects(x.pipeline)
    if (x.spansetOp !== undefined) return selects([x.lhs, x.rhs])
  }
  return []
})

// checkSelects throws Invalid for a select() argument other than an
// attribute or an intrinsic.
const checkSelects = (elements) => {
  for (const fields of selects(elements)) {
    if (fields.some(f => f.attr === undefined || !isFieldName(f.attr))) throw new Invalid(SELECT_ERROR)
  }
}

/**
 * selectedKeys lists the stored keys select() reads for each listed span,
 * each once; the span name is SPAN_NAME.
 * @param elements {Object[]} a pipeline
 */
const selectedKeys = (elements) => {
  const keys = selects(elements).flat()
    .filter(f => !LISTED.includes(f.attr))
    .map(f => (f.attr === 'name' || f.attr === 'span:name') ? SPAN_NAME : attrKey(f.attr) || INTRINSIC_KEYS[f.attr])
  return [...new Set(keys)]
}

// selectedValues returns a span's selected values by key, {} without any.
const selectedValues = (span, keys) => Object.fromEntries(keys
  .map(k => [k, span.attrs[k === SPAN_NAME ? 'name' : k]])
  .filter(([, v]) => v !== undefined))

// grouped reports whether a pipeline ends grouped when its input is grouped
// as `input`, and throws Grouped for a spanset operator over grouped spansets.
const grouped = (elements, input) => {
  let res = input
  for (const e of elements) {
    if (e.groupBy !== undefined) res = true
    else if (e.coalesce !== undefined) res = false
    else if (e.scalarFilter === undefined) res = spansetGrouped(e, res)
  }
  return res
}

class Grouped extends Error {}

class Invalid extends Error {}

const spansetGrouped = (expr, input) => {
  if (expr.paren !== undefined) return spansetGrouped(expr.paren, input)
  if (expr.pipeline !== undefined) return grouped(expr.pipeline, input)
  if (expr.spansetOp !== undefined) {
    if (input || spansetGrouped(expr.lhs, false) || spansetGrouped(expr.rhs, false)) throw new Grouped()
    return false
  }
  return input
}

// lonePipeline returns the elements of a parenthesised pipeline, or null.
const lonePipeline = (expr) => {
  while (expr.paren !== undefined) expr = expr.paren
  return expr.pipeline !== undefined ? expr.pipeline : null
}

// spansetStage evaluates a spanset expression over one input spanset: its
// spans are the operand candidates, and its attributes are kept, followed by
// those of a lone parenthesised pipeline.
const spansetStage = (expr, input, ctx) => {
  const inner = lonePipeline(expr)
  if (inner !== null) {
    return pipelineSpansets(inner, input.spans, ctx)
      .map(ss => ({ ...ss, attributes: [...input.attributes, ...ss.attributes], key: [...input.key, ...ss.key] }))
  }
  return spansetsOf(spansetSpans(expr, input.spans, ctx)).map(ss => ({ ...ss, attributes: input.attributes, key: input.key }))
}

// pipelineSpansets evaluates a pipeline over spans, the operand candidates of
// its first stage. Each later stage reads the spansets of the stage before:
// a spanset expression draws its operands from each spanset's spans, and
// ancestry reads every span of the trace.
const pipelineSpansets = (elements, spans, ctx) => {
  let sets = null
  for (const e of elements) {
    if (e.scalarFilter !== undefined) {
      sets = scalarFilter(e.scalarFilter, sets || spansetsOf(spans))
    } else if (e.groupBy !== undefined) {
      sets = groupBy(e.groupBy, sets || spansetsOf(spans))
    } else if (e.coalesce !== undefined) {
      sets = coalesce(sets)
    } else if (e.select !== undefined) {
      sets = sets || spansetsOf(spans)
    } else {
      sets = (sets || [{ spans, attributes: [], key: [] }]).flatMap(ss => spansetStage(e, ss, ctx))
    }
  }
  return sets
}

// needsWholeTrace reports whether a pipeline relates spans across a trace:
// through a spanset operator, a scalar filter or a by() stage.
const needsWholeTrace = (elements) => elements.some(e => {
  if (e.scalarFilter !== undefined || e.groupBy !== undefined) return true
  for (let x = e; x !== undefined; x = x.paren) {
    if (x.spansetOp !== undefined) return true
    if (x.pipeline !== undefined) return needsWholeTrace(x.pipeline)
  }
  return false
})

// earliestFirst orders spans by start time, then span id, both ascending.
const earliestFirst = (a, b) => a.start - b.start || (a.spanId < b.spanId ? -1 : a.spanId > b.spanId ? 1 : 0)

/**
 * resultSpansets returns the spansets a pipeline yields, one per trace and
 * group key with its spans, attributes ([name, {type, value, text?}]) and
 * key. It returns GROUPED for a spanset operator over grouped spansets,
 * {error} for a by() that reads no attribute or a select() argument that is
 * neither an attribute nor an intrinsic, and UNRESOLVED when ancestry
 * does not resolve within the round limit. Operand spans start in (from, to];
 * parents, ancestors, siblings and roots count wherever they start.
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
    checkSelects(pipeline)
    grouped(pipeline, false)
    checkGroupBys(pipeline)
    return pipelineSpansets(pipeline, inRange, ctx)
  } catch (e) {
    if (e instanceof Unresolved) return UNRESOLVED
    if (e instanceof Grouped) return GROUPED
    if (e instanceof Invalid) return { error: e.message }
    throw e
  }
}

/**
 * resultSpans returns the spans of resultSpansets(), or its error result.
 */
const resultSpans = (pipeline, all, opts) => {
  const sets = resultSpansets(pipeline, all, opts)
  return sets.error ? sets : sets.flatMap(ss => ss.spans)
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
 * attributeValue is an aggregate or a group key as the OTLP value search
 * returns: an int as a decimal string, a float as a double, a duration as a
 * Go duration string, a bool as a bool, a string as its text and nil as "nil".
 */
const attributeValue = ({ type, value, text }) => {
  switch (type) {
    case 'int': return { intValue: String(value) }
    case 'duration': return { stringValue: goDuration(value) }
    case 'bool': return { boolValue: value === 1 }
    case 'string': return { stringValue: text }
    case 'nil': return { stringValue: 'nil' }
  }
  return { doubleValue: value }
}

/**
 * search returns the expected traces of a search, newest first:
 * [{trace, traceId, spans: [span name, ...], matched, attributes, selected, spanSets}],
 * or the error result of resultSpansets(). The spansets are resultSpansets();
 * a trace lists them in spanSets by group key, each with its spss
 * earliest-starting result spans (ties by span id), matched and attributes
 * as {name: OTLP value}, and the first of them at the top level. selected
 * maps a listed span's name to its select() values, {key: text} with the
 * span name at SPAN_NAME, for the spans that have any. limit counts traces
 * by their newest result span (ties by trace id, descending).
 * @param query {Object} the case AST
 * @param all {Object[]} from dataset()
 * @param opts {{from: number, to: number, limit: number, spss?: number, rounds?: number, pushes?: number}}
 */
const search = (query, all, opts) => {
  const { limit, spss = DEFAULT_SPSS } = opts
  const sets = resultSpansets(query.pipeline, all, opts)
  if (sets.error) return sets
  const byTrace = new Map()
  for (const ss of sets) {
    if (!byTrace.has(ss.traceId)) byTrace.set(ss.traceId, [])
    byTrace.get(ss.traceId).push({ ...ss, spans: [...ss.spans].sort(earliestFirst) })
  }
  const traces = [...byTrace.values()].map(tss => {
    tss.sort((a, b) => compareKeys(a.key, b.key))
    const newest = Math.max(...tss.flatMap(ss => ss.spans.map(s => s.start)))
    return { traceId: tss[0].traceId, trace: tss[0].spans[0].trace, newest, sets: tss }
  })
  traces.sort((a, b) => b.newest - a.newest || (a.traceId < b.traceId ? 1 : -1))
  const keys = selectedKeys(query.pipeline)
  return traces.slice(0, limit).map(t => {
    const spanSets = t.sets.map(ss => {
      const listed = ss.spans.slice(0, spss)
      return {
        spans: listed.map(s => s.name),
        matched: ss.spans.length,
        attributes: Object.fromEntries(ss.attributes.map(([k, v]) => [k, attributeValue(v)])),
        selected: Object.fromEntries(listed.map(s => [s.name, selectedValues(s, keys)]).filter(([, v]) => Object.keys(v).length))
      }
    })
    return { trace: t.trace, traceId: t.traceId, ...spanSets[0], spanSets }
  })
}

module.exports = { DEFAULT_SPSS, ROUNDS, UNRESOLVED, GROUPED, SELECT_ERROR, SPAN_NAME, dataset, matches, resultSpans, search, durationNs, goDuration, needsWholeTrace }

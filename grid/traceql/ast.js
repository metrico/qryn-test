// JSON AST of the TraceQL grid cases and its canonical printer; the
// self-check holds each case's query equal to print(ast).
//
// query {pipeline: [element], metrics?, hints?: [[key, value]]}; element spanset
//   | {scalarFilter: {op, lhs: scalar, rhs: scalar}} | {groupBy: field} | {coalesce: true} | {select: [field]}
// spanset {selector: field|null} | {spansetOp, lhs, rhs} | {paren: spanset} | {pipeline: [element]}
// scalar {agg, attr?, arg?: field} | {num} | {dur}
// field {attr} | {str} | {num} | {dur} | {enum} | {bool} | {nil: true} | {op, lhs, rhs} | {unary, expr} | {paren}
// A field tree is grouped as gigapipe groups the printed query; print adds no parentheses.
// metrics {fn, attr?, q?, by?: [label]} | {fn: 'compare', compare: {filter: field|null, count?}}

const printField = (f) => {
  if (f.attr !== undefined) return f.attr
  if (f.str !== undefined) return JSON.stringify(f.str)
  if (f.num !== undefined) return String(f.num)
  if (f.dur !== undefined) return f.dur
  if (f.enum !== undefined) return f.enum
  if (f.bool !== undefined) return String(f.bool)
  if (f.nil !== undefined) return 'nil'
  if (f.paren !== undefined) return `(${printField(f.paren)})`
  if (f.op !== undefined) return `${printField(f.lhs)} ${f.op} ${printField(f.rhs)}`
  if (f.unary !== undefined) return `${f.unary}${printField(f.expr)}`
  throw new Error(`ast: unknown field node ${JSON.stringify(f)}`)
}

const isLeaf = (f) => f.op === undefined && f.unary === undefined && f.paren === undefined

// canonicalField prints a field expression the way gigapipe names an
// aggregate or a by() stage: parentheses as written are dropped, and operands other than
// attributes and literals are parenthesised.
const canonicalField = (f) => {
  if (f.paren !== undefined) return canonicalField(f.paren)
  const wrap = (x) => {
    while (x.paren !== undefined) x = x.paren
    return isLeaf(x) ? printField(x) : `(${canonicalField(x)})`
  }
  if (f.op !== undefined) {
    if (f.rhs.nil !== undefined) return `${wrap(f.lhs)} ${f.op} nil`
    if (f.lhs.nil !== undefined) return `${wrap(f.rhs)} ${f.op} nil`
    return `${wrap(f.lhs)} ${f.op} ${wrap(f.rhs)}`
  }
  if (f.unary !== undefined) return `${f.unary}${wrap(f.expr)}`
  return printField(f)
}

const printScalar = (x) => {
  if (x.agg !== undefined) return `${x.agg}(${x.arg ? printField(x.arg) : x.attr || ''})`
  if (x.num !== undefined) return String(x.num)
  if (x.dur !== undefined) return x.dur
  throw new Error(`ast: unknown scalar node ${JSON.stringify(x)}`)
}

const printSpanset = (s) => {
  if (s.selector !== undefined) return s.selector === null ? '{}' : `{ ${printField(s.selector)} }`
  if (s.spansetOp !== undefined) return `${printSpanset(s.lhs)} ${s.spansetOp} ${printSpanset(s.rhs)}`
  if (s.paren !== undefined) return `(${printSpanset(s.paren)})`
  if (s.pipeline !== undefined) return printPipeline(s.pipeline)
  throw new Error(`ast: unknown spanset node ${JSON.stringify(s)}`)
}

const printElement = (e) => {
  if (e.groupBy !== undefined) return `by(${printField(e.groupBy)})`
  if (e.coalesce !== undefined) return 'coalesce()'
  if (e.select !== undefined) return `select(${e.select.map(printField).join(', ')})`
  if (e.scalarFilter === undefined) return printSpanset(e)
  const f = e.scalarFilter
  return `${printScalar(f.lhs)} ${f.op} ${printScalar(f.rhs)}`
}

const printPipeline = (elements) => elements.map(printElement).join(' | ')

const printMetrics = (m) => {
  let args = m.attr || ''
  if (m.q !== undefined) args += `, ${m.q}`
  if (m.compare) {
    args = printSpanset({ selector: m.compare.filter })
    if (m.compare.count !== undefined) args += `, ${m.compare.count}`
  }
  const by = m.by ? ` by (${m.by.join(', ')})` : ''
  return `${m.fn}(${args})${by}`
}

const printHints = (hints) => ` with(${hints.map(([k, v]) => `${k}=${v}`).join(', ')})`

const print = (query) => printPipeline(query.pipeline) +
  (query.metrics ? ` | ${printMetrics(query.metrics)}` : '') +
  (query.hints ? printHints(query.hints) : '')

// canonicalScalar is an aggregate's canonical form, which names its value.
const canonicalScalar = (x) => x.arg ? `${x.agg}(${canonicalField(x.arg)})` : printScalar(x)

module.exports = { print, printField, printScalar, printSpanset, canonicalField, canonicalScalar }

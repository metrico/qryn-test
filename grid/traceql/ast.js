// JSON AST of the TraceQL grid cases and its canonical printer; the
// self-check holds each case's query equal to print(ast).
//
// query {pipeline: [element], metrics?}; element spanset | {scalarFilter: {op, lhs: scalar, rhs: scalar}}
// spanset {selector: field|null} | {spansetOp, lhs, rhs} | {paren: spanset} | {pipeline: [element]}
// scalar {agg, attr?} | {num} | {dur}
// field {attr} | {str} | {num} | {dur} | {enum} | {op, lhs, rhs} | {paren}
// metrics {fn, attr?, q?, by?: [label]} | {fn: 'compare', compare: {filter: field|null, count?}}

const printField = (f) => {
  if (f.attr !== undefined) return f.attr
  if (f.str !== undefined) return JSON.stringify(f.str)
  if (f.num !== undefined) return String(f.num)
  if (f.dur !== undefined) return f.dur
  if (f.enum !== undefined) return f.enum
  if (f.paren !== undefined) return `(${printField(f.paren)})`
  if (f.op !== undefined) return `${printField(f.lhs)} ${f.op} ${printField(f.rhs)}`
  throw new Error(`ast: unknown field node ${JSON.stringify(f)}`)
}

const printScalar = (x) => {
  if (x.agg !== undefined) return `${x.agg}(${x.attr || ''})`
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

const print = (query) => printPipeline(query.pipeline) +
  (query.metrics ? ` | ${printMetrics(query.metrics)}` : '')

module.exports = { print, printField, printScalar, printSpanset }

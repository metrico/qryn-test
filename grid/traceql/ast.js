// JSON AST of the TraceQL grid cases and its canonical printer; the
// self-check holds each case's query equal to print(ast).
//
// query {pipeline: [spanset], metrics?}; spanset {selector: field|null} | {spansetOp, lhs, rhs} | {paren}
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

const printSpanset = (s) => {
  if (s.selector !== undefined) return s.selector === null ? '{}' : `{ ${printField(s.selector)} }`
  if (s.spansetOp !== undefined) return `${printSpanset(s.lhs)} ${s.spansetOp} ${printSpanset(s.rhs)}`
  if (s.paren !== undefined) return `(${printSpanset(s.paren)})`
  throw new Error(`ast: unknown spanset node ${JSON.stringify(s)}`)
}

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

const print = (query) => query.pipeline.map(printSpanset).join(' | ') +
  (query.metrics ? ` | ${printMetrics(query.metrics)}` : '')

module.exports = { print, printField, printSpanset }

// JSON AST for the TraceQL grid cases and its canonical printer. The
// self-check holds every case's query string equal to print(ast), so a query
// and its AST cannot drift apart.
//
// Query:     {pipeline: [element, ...]}
// Element:   a spanset expression
// Spanset:   {selector: field | null}            `{ field }` or `{}`
//            {spansetOp: op, lhs, rhs}           `lhs op rhs`
//            {paren: spanset}                    `(spanset)`
// Field:     {attr: '.x' | 'span.x' | 'resource.x' | 'name' | 'duration' | 'status' | ...}
//            {str: 'x'} | {num: 1.5} | {dur: '5ms'} | {enum: 'error'}
//            {op, lhs, rhs}                      binary, e.g. `=`, `&&`
//            {paren: field}                      `(field)`

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

const print = (query) => query.pipeline.map(printSpanset).join(' | ')

module.exports = { print, printField, printSpanset }

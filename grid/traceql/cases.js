// Expands grid/traceql/cases.json into runs. A case's range is ms relative to
// FROM and defaults to the seed window; a metrics case's step is in seconds.

const { WINDOW } = require('./seed')
const file = require('./cases.json')

/**
 * runs returns one run per case:
 * {id, name, note, query, ast, from, to, limit, spss, pushes}, times in ms.
 * pushes, when set, is how many seed batches have landed when the case runs.
 * @param from {number} FROM in ms
 */
const runs = (from) => file.cases.map(c => {
  const range = c.range || { from: 0, to: WINDOW }
  return {
    id: c.id,
    name: `${c.id}: ${c.query}`,
    note: c.note,
    query: c.query,
    ast: c.ast,
    from: from + range.from,
    to: from + range.to,
    limit: c.limit || file.defaults.limit,
    spss: c.spss,
    pushes: c.pushes
  }
})

/**
 * metricsRuns returns one run per metrics case:
 * {id, name, note, query, ast, from, to, step, instant, kind}, times in ms.
 * kind is 'range', 'instant' or 'compare'.
 * @param from {number} FROM in ms
 */
const metricsRuns = (from) => file.metrics.map(c => {
  const range = c.range || { from: 0, to: WINDOW }
  const compare = c.ast.metrics.fn === 'compare'
  return {
    id: c.id,
    name: `${c.id}: ${c.instant ? 'instant ' : ''}${c.query}`,
    note: c.note,
    query: c.query,
    ast: c.ast,
    from: from + range.from,
    to: from + range.to,
    step: (c.step || file.defaults.step) * 1000,
    instant: !!c.instant,
    kind: compare ? 'compare' : c.instant ? 'instant' : 'range'
  }
})

module.exports = { runs, metricsRuns }

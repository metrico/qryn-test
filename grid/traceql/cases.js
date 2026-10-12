// Expands grid/traceql/cases.json into runs. A case's range is ms relative to
// FROM and defaults to the seed window.

const { WINDOW } = require('./seed')
const file = require('./cases.json')

/**
 * runs returns one run per case:
 * {id, name, note, query, ast, from, to, limit, spss}, times in ms.
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
    spss: c.spss
  }
})

module.exports = { runs }

// Reference evaluator for tags v2 and values v2 in the grid: the attribute
// keys or values of the oracle's result spans, which are exactly the spans
// search returns. A query that selects every span reads every key or value
// of the dates in range, so its result is a superset of the seed's.

const oracle = require('./oracle')

// selectsEverySpan reports whether a query has no selector or is a lone `{}`.
const selectsEverySpan = (query) => {
  if (query.pipeline.length === 0) return true
  if (query.pipeline.length > 1) return false
  let expr = query.pipeline[0]
  while (expr.paren !== undefined) expr = expr.paren
  return expr.selector === null
}

// TAG_KEYS maps tag names the API rewrites to their attribute key.
const TAG_KEYS = { status: 'otel.status_code' }

// tagKey is the attribute key of a values v2 tag, without its scope.
const tagKey = (tag) => TAG_KEYS[tag] || tag.replace(/^span\./, '').replace(/^\./, '').replace(/^resource\./, '')

// suggestions returns the sorted distinct keys of spans' attributes, or the
// values of tag when it is set.
const suggestions = (spans, tag) => {
  const out = new Set()
  for (const s of spans) {
    if (tag === undefined) {
      Object.keys(s.attrs).forEach(k => out.add(k))
      continue
    }
    const v = s.attrs[tagKey(tag)]
    if (v !== undefined) out.add(v)
  }
  return [...out].sort()
}

/**
 * autocomplete returns the expected tags v2 or values v2 result:
 * {values: [string], superset: boolean}, or the error result of
 * oracle.resultSpans(). values are sorted and cut to limit.
 * @param query {Object} the case AST
 * @param all {Object[]} from oracle.dataset()
 * @param opts {{from: number, to: number, tag?: string, limit?: number, rounds?: number, pushes?: number}}
 */
const autocomplete = (query, all, opts) => {
  const { from, to, tag, limit, pushes } = opts
  if (selectsEverySpan(query)) {
    const spans = all.filter(s => s.start > from && s.start <= to && (pushes === undefined || s.push < pushes))
    return { values: suggestions(spans, tag), superset: true }
  }
  const found = oracle.resultSpans(query.pipeline, all, opts)
  if (found.error) return found
  const values = suggestions(found, tag)
  return { values: limit ? values.slice(0, limit) : values, superset: false }
}

module.exports = { autocomplete, selectsEverySpan }

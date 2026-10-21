// gigapipe I/O for the TraceQL grid suite: Zipkin ingest, the Tempo
// search, metrics and autocomplete APIs, and the nested-set side table.

const axios = require('axios')
const { clokiExtUrl, clokiWriteUrl, axiosGet, axiosPost } = require('../../common')

// The ClickHouse HTTP endpoint (with credentials) and database of the stack.
const clickhouseUrl = process.env.GRID_CLICKHOUSE_URL || 'http://qryn:q1w2e3r4@e2e.clickhouse:8123'
const clickhouseDb = process.env.GRID_CLICKHOUSE_DB || 'cloki'

const secs = (ms) => {
  if (ms % 1000 !== 0) throw new Error(`${ms}ms is not a whole second`)
  return String(ms / 1000)
}

// push writes each batch through the Zipkin API, in order.
const push = async (batches) => {
  for (const batch of batches) {
    await axiosPost(`http://${clokiWriteUrl}/tempo/spans`, JSON.stringify(batch), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

/**
 * search runs a TraceQL search over (from, to] and returns the response,
 * whatever its status.
 * @param run {{query: string, from: number, to: number, limit: number, spss?: number}}
 */
const search = async (run) => {
  const qs = new URLSearchParams({
    q: run.query,
    start: secs(run.from),
    end: secs(run.to),
    limit: String(run.limit)
  })
  if (run.spss !== undefined) qs.set('spss', String(run.spss))
  return axiosGet(`http://${clokiExtUrl}/api/search?${qs}`, { validateStatus: () => true })
}

/**
 * metrics runs a TraceQL metrics query over (from, to] and returns the
 * response, whatever its status: a range query with the step, or an instant
 * query.
 * @param run {{query: string, from: number, to: number, step: number, instant?: boolean}}
 */
const metrics = async (run) => {
  const qs = new URLSearchParams({ q: run.query, start: secs(run.from), end: secs(run.to) })
  if (!run.instant) qs.set('step', `${secs(run.step)}s`)
  const path = run.instant ? 'query' : 'query_range'
  return axiosGet(`http://${clokiExtUrl}/api/metrics/${path}?${qs}`, { validateStatus: () => true })
}

/**
 * autocomplete runs tags v2, or values v2 of run.tag, for a TraceQL query over
 * (from, to] and returns the response, whatever its status. An empty query
 * sends no q.
 * @param run {{query: string, from: number, to: number, tag?: string, limit?: number}}
 */
const autocomplete = async (run) => {
  const qs = new URLSearchParams({ start: secs(run.from), end: secs(run.to) })
  if (run.query) qs.set('q', run.query)
  if (run.limit !== undefined) qs.set('limit', String(run.limit))
  const path = run.tag === undefined ? 'tags' : `tag/${encodeURIComponent(run.tag)}/values`
  return axiosGet(`http://${clokiExtUrl}/api/v2/search/${path}?${qs}`, { validateStatus: () => true })
}

/**
 * nestedSetRows reads the newest stored nested-set values of the given
 * traces: [{traceId, spanId, left, right, parent}], ids in lowercase hex.
 * @param traceIds {string[]} hex trace ids
 */
const nestedSetRows = async (traceIds) => {
  const url = new URL(clickhouseUrl)
  const ids = traceIds.map(id => {
    if (!/^[0-9a-f]{32}$/.test(id)) throw new Error(`bad trace id ${id}`)
    return `unhex('${id}')`
  })
  const query = `SELECT lower(hex(trace_id)) AS traceId, lower(hex(span_id)) AS spanId,
      argMax(left, version) AS left, argMax(right, version) AS right, argMax(parent, version) AS parent
    FROM ${clickhouseDb}.tempo_traces_nested_set
    WHERE trace_id IN (${ids.join(', ')})
    GROUP BY trace_id, span_id
    FORMAT JSONEachRow`
  const res = await axios.post(`${url.protocol}//${url.host}/`, query, {
    auth: { username: decodeURIComponent(url.username) || 'default', password: decodeURIComponent(url.password) },
    responseType: 'text',
    transformResponse: [(data) => data]
  })
  return res.data.split('\n').filter(Boolean).map(line => JSON.parse(line))
}

// waitFor polls fn until it returns true or the timeout passes.
const waitFor = async (fn, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

module.exports = { push, search, metrics, autocomplete, nestedSetRows, waitFor }

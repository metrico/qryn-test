// gigapipe I/O for the TraceQL grid suite: Zipkin ingest and the Tempo
// search, metrics and autocomplete APIs.

const { clokiExtUrl, clokiWriteUrl, axiosGet, axiosPost } = require('../../common')

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

// waitFor polls fn until it returns true or the timeout passes.
const waitFor = async (fn, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  return false
}

module.exports = { push, search, metrics, autocomplete, waitFor }

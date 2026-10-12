// gigapipe I/O for the TraceQL grid suite: Zipkin ingest and the Tempo
// search API.

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
 * search runs a TraceQL search over (from, to] and returns the response body.
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
  const resp = await axiosGet(`http://${clokiExtUrl}/api/search?${qs}`)
  return resp.data
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

module.exports = { push, search, waitFor }

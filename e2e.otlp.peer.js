const {
  _it,
  axiosGet,
  clokiExtUrl,
  clokiWriteUrl,
  extraHeaders,
  shard,
  start,
  testID
} = require('./common')

// A client span names the service it calls in peer.service. The span still
// belongs to the service that emitted it: filing it under the callee would give
// the callee a span carrying the caller's resource attributes (service.version,
// host, ...), and the caller would lose its outgoing calls.
const peerTestID = testID + 'peer'
const caller = 'peer-caller-' + testID
const callee = 'peer-callee-' + testID

_it('otlp traces: should push a client span naming its callee', async () => {
  const { Resource } = require('@opentelemetry/resources')
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node')
  const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base')
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto')
  const { SpanKind } = require('@opentelemetry/api')

  const provider = new NodeTracerProvider({
    resource: new Resource({ 'service.name': caller, 'service.version': '1.4.0' })
  })
  provider.addSpanProcessor(new SimpleSpanProcessor(new OTLPTraceExporter({
    headers: { 'X-Scope-OrgID': '1', 'X-Shard': shard, ...extraHeaders },
    url: 'http://' + clokiWriteUrl + '/v1/traces'
  })))
  const span = provider.getTracer('peer-service-e2e').startSpan('GET /pay', {
    kind: SpanKind.CLIENT,
    attributes: { 'peer.service': callee, testId: peerTestID }
  })
  span.end()
  await provider.forceFlush()
  await provider.shutdown()
  await new Promise(f => setTimeout(f, 2000))
})

const searchCount = async (q) => {
  const req = 'http://' + clokiExtUrl + '/api/search' +
    `?start=${Math.floor(start / 1000)}&end=${Math.floor(Date.now() / 1000) + 60}` +
    `&q=${encodeURIComponent(q)}&limit=10`
  const res = await axiosGet(req, { headers: { 'X-Scope-OrgID': '1' } })
  return res.data.traces.length
}

_it('otlp traces: should file a client span under its own service', async () => {
  expect(await searchCount(`{.testId="${peerTestID}" && .service.name="${caller}"}`)).toBe(1)
}, ['otlp traces: should push a client span naming its callee'])

_it('otlp traces: should not file a client span under its callee', async () => {
  expect(await searchCount(`{.testId="${peerTestID}" && .service.name="${callee}"}`)).toBe(0)
  expect(await searchCount(`{.testId="${peerTestID}" && .peer.service="${callee}"}`)).toBe(1)
}, ['otlp traces: should push a client span naming its callee'])

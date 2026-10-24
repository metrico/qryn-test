const {
  _it,
  axiosPost,
  otelCollectorUrl,
  clokiExtUrl,
  start,
  end,
  testID
} = require('./common')
const querier = require('./pyroscope_pb/querier_pb')
const { Dictionary, profile, encodeRequest } = require('./otlp_profiles')

const __it = (name, fn, deps) => _it(name, () => {
  if (!otelCollectorUrl) {
    return
  }
  return fn()
}, deps)

// OTLP resource attributes keep their names as profile tags, dots included
// (service.version, k8s.pod.name). A selector names such a label in double
// quotes, as in the Prometheus UTF-8 matcher syntax: {"service.version"="1.4.0"}.
const labelsTestID = testID + 'otlplabels'
const CPU_TYPE = 'samples:samples:count:cpu:nanoseconds'

// One profile per version, each with a frame only that version has, so a read
// shows which versions a selector matched.
const buildRequest = (version, frame) => {
  const dict = new Dictionary()
  return encodeRequest({
    dict,
    resourceAttrs: {
      'service.name': 'otlp-labels-test',
      'service.version': version,
      __session_id__: labelsTestID
    },
    profiles: [
      profile(dict, {
        sampleType: ['samples', 'count'],
        periodType: ['cpu', 'nanoseconds'],
        timeUnixNanoStr: (start * 1000000).toString(),
        durationNano: 10000000000,
        samples: [{ stack: dict.stack([frame, 'main']), values: [10] }]
      })
    ]
  })
}

__it('otlp pprof: should push profiles of two versions', async () => {
  for (const [version, frame] of [['1.3.2', 'app.v132only'], ['1.4.0', 'app.v140only']]) {
    await axiosPost(
      `${otelCollectorUrl}/v1development/profiles`,
      buildRequest(version, frame),
      { headers: { 'Content-Type': 'application/x-protobuf' } }
    )
  }
})

const mergedFrames = async (labelSelector) => {
  const req = new querier.SelectMergeStacktracesRequest()
  req.setProfileTypeid(CPU_TYPE)
  req.setLabelSelector(labelSelector)
  req.setStart(start - 1)
  req.setEnd(end + 1)
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeStacktraces`,
    req.serializeBinary(), { responseType: 'arraybuffer' }
  )
  const res = querier.SelectMergeStacktracesResponse.deserializeBinary(_res.data).toObject()
  return res.flamegraph.namesList
}

__it('otlp pprof: should select by a quoted dotted label name', async () => {
  const names = await mergedFrames(`{__session_id__="${labelsTestID}", "service.version"="1.4.0"}`)
  expect(names).toContain('app.v140only')
  expect(names).not.toContain('app.v132only')
}, ['otlp pprof: should push profiles of two versions'])

__it('otlp pprof: should match a quoted dotted label name by regex', async () => {
  const names = await mergedFrames(`{__session_id__="${labelsTestID}", "service.version"=~"1\\\\.3\\\\..*"}`)
  expect(names).toContain('app.v132only')
  expect(names).not.toContain('app.v140only')
}, ['otlp pprof: should push profiles of two versions'])

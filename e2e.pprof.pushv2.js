const zlib = require('zlib')
const protobufjs = require('protobufjs')
const {
  _it,
  axiosPost,
  clokiExtUrl,
  clokiWriteUrl,
  testID,
  start,
  end
} = require('./common')
const pprof = require('./pyroscope_pb/profile_pb')
const querier = require('./pyroscope_pb/querier_pb')
const types = require('./pyroscope_pb/types/v1/types_pb')

// The Pyroscope v2 push API, which every SDK from 1.0 onwards sends to
// /push.v1.PusherService/Push over Connect. There is no generated stub for the
// push service in pyroscope_pb, and the four messages it needs are small
// enough to declare here rather than vendor a generated file for.
//
// Field numbers follow grafana/pyroscope api/push/v1/push.proto.
const pushRoot = protobufjs.parse(`
  syntax = "proto3";
  message LabelPair { string name = 1; string value = 2; }
  message RawSample { bytes raw_profile = 1; string ID = 2; }
  message RawProfileSeries {
    repeated LabelPair labels = 1;
    repeated RawSample samples = 2;
  }
  message PushRequest { repeated RawProfileSeries series = 1; }
`).root
const PushRequest = pushRoot.lookupType('PushRequest')

const serviceName = `pushv2-e2e-${testID}`

// A CPU pprof with one named frame, gzipped the way the SDKs send it.
const cpuProfile = (timeNanos, durationNanos, value) => {
  const p = new pprof.Profile()
  // Index 0 of the string table must be the empty string.
  p.setStringTableList(['', 'samples', 'count', 'cpu', 'nanoseconds', 'main.e2ePushV2'])

  const sampleType = new pprof.ValueType()
  sampleType.setType(1)
  sampleType.setUnit(2)
  p.addSampleType(sampleType)

  // The period type is what the server derives the profile type from: a cpu
  // period becomes process_cpu.
  const periodType = new pprof.ValueType()
  periodType.setType(3)
  periodType.setUnit(4)
  p.setPeriodType(periodType)
  p.setPeriod(10000000)

  // A push carries no time window of its own, so these two fields are the only
  // source for the timestamp and duration the server stores.
  p.setTimeNanos(timeNanos)
  p.setDurationNanos(durationNanos)

  const fn = new pprof.Function()
  fn.setId(1)
  fn.setName(5)
  fn.setSystemName(5)
  p.addFunction(fn)

  const line = new pprof.Line()
  line.setFunctionId(1)
  line.setLine(10)
  const loc = new pprof.Location()
  loc.setId(1)
  loc.addLine(line)
  p.addLocation(loc)

  const sample = new pprof.Sample()
  sample.addLocationId(1)
  sample.addValue(value)
  p.addSample(sample)

  return zlib.gzipSync(Buffer.from(p.serializeBinary()))
}

const pushBody = () => {
  // Two samples in one series and a second series, so the response cannot pass
  // by returning only the first of either.
  const at = (start + end) / 2
  return Buffer.from(PushRequest.encode(PushRequest.fromObject({
    series: [
      {
        labels: [
          {name: 'service_name', value: serviceName},
          {name: 'region', value: 'e2e-west'},
          // A Pyroscope-internal label, which is not a user tag.
          {name: '__session_id__', value: testID}
        ],
        samples: [
          {rawProfile: cpuProfile(at * 1000000, 10000000000, 3), ID: `${testID}-a`},
          {rawProfile: cpuProfile((at + 1000) * 1000000, 10000000000, 5), ID: `${testID}-b`}
        ]
      },
      {
        labels: [{name: 'service_name', value: `${serviceName}-second`}],
        samples: [
          {rawProfile: cpuProfile(at * 1000000, 10000000000, 7), ID: `${testID}-c`}
        ]
      }
    ]
  })).finish())
}

const waitFor = async (get, check) => {
  let last
  for (let i = 0; i < 30; i++) {
    last = await get()
    if (check(last)) {
      return last
    }
    await new Promise(f => setTimeout(f, 1000))
  }
  return last
}

const profileTypeIDs = async () => {
  const req = new querier.ProfileTypesRequest()
  req.setStart(start)
  req.setEnd(end)
  const res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/ProfileTypes`,
    req.serializeBinary(), {responseType: 'arraybuffer'}
  )
  return querier.ProfileTypesResponse.deserializeBinary(res.data)
    .toObject().profileTypesList.map(t => t.id)
}

_it('pushv2: should accept a Pyroscope v2 Connect push', async () => {
  const res = await axiosPost(
    `http://${clokiWriteUrl}/push.v1.PusherService/Push`,
    pushBody(), {
      headers: {'Content-Type': 'application/proto'},
      responseType: 'arraybuffer'
    }
  )
  // A Connect unary success. PushResponse has no fields, so an empty body is
  // the correct encoding of it rather than a truncated reply.
  expect(res.status).toEqual(200)
})

_it('pushv2: should derive the profile type from the pprof period', async () => {
  const ids = await waitFor(
    () => profileTypeIDs(),
    ids => ids.some(id => id.startsWith('process_cpu:'))
  )
  // The push said nothing about the profile type; the server read it off the
  // pprof's cpu period type.
  expect(ids.some(id => id.startsWith('process_cpu:'))).toBeTruthy()
}, ['pushv2: should accept a Pyroscope v2 Connect push'])

_it('pushv2: should take the application name from the series labels', async () => {
  const req = new types.LabelValuesRequest()
  req.setName('service_name')
  req.setStart(start)
  req.setEnd(end)
  const values = await waitFor(async () => {
    const res = await axiosPost(
      `http://${clokiExtUrl}/querier.v1.QuerierService/LabelValues`,
      req.serializeBinary(), {responseType: 'arraybuffer'}
    )
    return types.LabelValuesResponse.deserializeBinary(res.data).getNamesList()
  }, names => names.includes(serviceName))

  // Both series land under the name their own labels carried, not under one
  // shared name and not under the internal __session_id__ label.
  expect(values).toContain(serviceName)
  expect(values).toContain(`${serviceName}-second`)
}, ['pushv2: should accept a Pyroscope v2 Connect push'])

_it('pushv2: should keep every sample of a pushed series', async () => {
  const ids = await waitFor(
    () => profileTypeIDs(),
    ids => ids.some(id => id.startsWith('process_cpu:'))
  )
  const typeID = ids.find(id => id.startsWith('process_cpu:'))

  const req = new querier.SelectMergeStacktracesRequest()
  req.setProfileTypeid(typeID)
  req.setLabelSelector(`{service_name="${serviceName}"}`)
  req.setStart(start)
  req.setEnd(end)

  const flame = await waitFor(async () => {
    const res = await axiosPost(
      `http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeStacktraces`,
      req.serializeBinary(), {responseType: 'arraybuffer'}
    )
    return querier.SelectMergeStacktracesResponse.deserializeBinary(res.data).toObject()
  }, r => r.flamegraph && r.flamegraph.namesList.includes('main.e2ePushV2'))

  // The frame survived symbolization, so the payload was stored whole rather
  // than merely accepted.
  expect(flame.flamegraph.namesList).toContain('main.e2ePushV2')
  // Both samples of this series are present: 3 + 5. Keeping only the first
  // sample of the series would total 3.
  expect(flame.flamegraph.total).toEqual(8)
}, ['pushv2: should accept a Pyroscope v2 Connect push'])

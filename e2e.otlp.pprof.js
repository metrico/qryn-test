const {
  _it,
  axiosPost,
  otelCollectorUrl,
  clokiExtUrl,
  extraHeaders,
  start,
  end,
  testID
} = require('./common')
const axios = require('axios')
const types = require('./pyroscope_pb/types/v1/types_pb')
const querier = require('./pyroscope_pb/querier_pb')
const { Dictionary, profile, encodeRequest } = require('./otlp_profiles')

const __it = (name, fn, deps) => _it(name, () => {
  if (!otelCollectorUrl) {
    return
  }
  return fn()
}, deps)

// A session id distinct from the pprof suite's, so the two sets of profiles
// never mix in a `{__session_id__="..."}` query even though both suites run
// against the same instance in the same time window.
const otlpTestID = testID + 'otlp'
const serviceName = 'otlp-test-client'

// gigapipe derives type_id as `<type>:<period_type>:<period_unit>` and the
// pyroscope __profile_type__ as
// `<type>:<sample_type>:<sample_unit>:<period_type>:<period_unit>`, where
// <type> for an OTLP profile is its sample_type type string.
const CPU_TYPE = 'samples:samples:count:cpu:nanoseconds'
const ALLOC_TYPE = 'alloc_objects:alloc_objects:count:space:bytes'

const BUCKETS = 5
const BUCKET_MS = 20000

/**
 * Builds one export request carrying TWO profiles that share a single
 * dictionary. Two profiles per request is deliberate: an OTLP batch maps to one
 * ClickHouse row *per profile*, so this is what catches a regression where a
 * multi-profile request collapses into a single row.
 *
 * The dictionary also carries entries no sample references, so a successful
 * read back proves the writer's per-profile dictionary pruning kept the
 * payload self-contained.
 *
 * @param i {number} bucket index
 * @returns {Buffer}
 */
const buildRequest = (i) => {
  const dict = new Dictionary()
  const clientMapping = dict.mapping('/usr/bin/otlp-test-client')
  const libMapping = dict.mapping('/usr/lib/libtest-other.so')

  const parse = dict.stack(['app.parse', 'app.handler', 'main'])
  const encode = dict.stack(['app.encode', 'app.handler', 'main'])
  const malloc = dict.stack(['runtime.mallocgc', 'main'])
  // Frames with no lines: gigapipe cannot symbolize these, so it names them
  // after the binary the location's mapping points at, plus the address, as
  // "<filename>+0x<address>".
  //
  // The two below sit at the SAME address in DIFFERENT binaries. That is the
  // case a name built from the address alone gets wrong: it collapses both into
  // one "+0x2a" node and sums their values, attributing one binary's time to
  // the other. Keeping them as two distinct frames is the property under test,
  // so assert both, not just one.
  const unsymbolized = dict.stackOfLocations([
    dict.addressLocation(0x2a, { mappingIndex: clientMapping }),
    dict.location('main')
  ])
  const unsymbolizedOtherBinary = dict.stackOfLocations([
    dict.addressLocation(0x2a, { mappingIndex: libMapping }),
    dict.location('main')
  ])

  // Never referenced by any sample -> must be pruned out of the stored payload.
  dict.fn('never.referenced.function')
  dict.str('never-referenced-string')
  dict.location('never.referenced.location')
  dict.attr('never.referenced.attr', 'nope')
  dict.link('0af7651916cd43dd8448eb211c80319c', 'b7ad6b7169203331')

  const timeUnixNanoStr = ((start + i * BUCKET_MS) * 1000000).toString()

  return encodeRequest({
    dict,
    resourceAttrs: {
      'service.name': serviceName,
      __session_id__: otlpTestID,
      five: (i % 5).toString()
    },
    scopeAttrs: { scope_label: 'otlp' },
    profiles: [
      profile(dict, {
        sampleType: ['samples', 'count'],
        periodType: ['cpu', 'nanoseconds'],
        timeUnixNanoStr,
        durationNano: 10000000000,
        samples: [
          { stack: parse, values: [7] },
          { stack: encode, values: [13] },
          { stack: unsymbolized, values: [5] },
          { stack: unsymbolizedOtherBinary, values: [11] }
        ]
      }),
      profile(dict, {
        sampleType: ['alloc_objects', 'count'],
        periodType: ['space', 'bytes'],
        timeUnixNanoStr,
        durationNano: 10000000000,
        samples: [
          { stack: malloc, values: [100] },
          { stack: parse, values: [20] }
        ]
      })
    ]
  })
}

__it('otlp pprof: should push otlp profiles', async () => {
  for (let i = 0; i < BUCKETS; i++) {
    const body = buildRequest(i)
    await axiosPost(
      `${otelCollectorUrl}/v1development/profiles`,
      body,
      { headers: { 'Content-Type': 'application/x-protobuf' } }
    )
  }
  await new Promise(f => setTimeout(f, 5000))
})

__it('otlp pprof: should reject json otlp profiles', async () => {
  const res = await axios.post(
    `${otelCollectorUrl}/v1development/profiles`,
    JSON.stringify({ resourceProfiles: [] }),
    {
      headers: { ...extraHeaders, 'Content-Type': 'application/json' },
      validateStatus: () => true
    }
  )
  expect(res.status).toBe(415)
})

__it('otlp pprof: should read pyro ProfileTypes', async () => {
  const req = new querier.ProfileTypesRequest()
  req.setStart(start)
  req.setEnd(end)
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/ProfileTypes`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const res = querier.ProfileTypesResponse.deserializeBinary(_res.data)
  const profileTypes = res.getProfileTypesList().map(pt => pt.getId())
  for (const pt of [CPU_TYPE, ALLOC_TYPE]) {
    expect(profileTypes.includes(pt)).toBeTruthy()
  }
}, ['otlp pprof: should push otlp profiles'])

__it('otlp pprof: should read pyro LabelValues', async () => {
  const req = new types.LabelValuesRequest()
  req.setName('__session_id__')
  req.setStart(start)
  req.setEnd(end)
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/LabelValues`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const res = types.LabelValuesResponse.deserializeBinary(_res.data)
  expect(res.getNamesList().includes(otlpTestID)).toBeTruthy()
}, ['otlp pprof: should push otlp profiles'])

// Resource and scope attributes other than service.name become profile tags;
// service.name becomes the service_name label.
__it('otlp pprof: should read pyro Series', async () => {
  const req = new querier.SeriesRequest()
  req.setStart(start)
  req.setEnd(end)
  req.setMatchersList([`{__session_id__="${otlpTestID}"}`])
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/Series`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const res = querier.SeriesResponse.deserializeBinary(_res.data)
  let labels = res.getLabelsSetList().map(ls => {
    const ll = ls.toObject().labelsList
    ll.forEach((v) => {
      if (v.name === '__session_id__') {
        expect(v.value).toBe(otlpTestID)
        v.value = 'TEST_ID'
      }
    })
    ll.sort((a, b) => a.name.localeCompare(b.name))
    return JSON.stringify(ll)
  })
  labels = Object.keys(Object.fromEntries(labels.map(l => [l, true])))
  labels.sort()
  expect(labels).toMatchSnapshot()
}, ['otlp pprof: should push otlp profiles'])

// Flamegraph path: served from the pre-computed tree/functions columns the
// writer builds at ingest time (buildOTLPTree), NOT from the stored payload.
__it('otlp pprof: should read pyro SelectMergeStacktraces', async () => {
  const req = new querier.SelectMergeStacktracesRequest()
  req.setProfileTypeid(CPU_TYPE)
  req.setLabelSelector(`{service_name="${serviceName}", __session_id__="${otlpTestID}"}`)
  req.setStart(start)
  req.setEnd(end)
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeStacktraces`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const res = (querier.SelectMergeStacktracesResponse.deserializeBinary(_res.data)).toObject()
  const names = [...res.flamegraph.namesList]
  names.sort()
  const levels = []
  for (const level of res.flamegraph.levelsList) {
    levels.push({})
    const j = levels.length - 1
    for (let i = 0; i < level.valuesList.length; i += 4) {
      const name = res.flamegraph.namesList[level.valuesList[i + 3]]
      levels[j][name] = levels[j][name] || { self: 0, total: 0 }
      levels[j][name].total += level.valuesList[i + 1]
      levels[j][name].self += level.valuesList[i + 2]
    }
  }
  expect(names).toMatchSnapshot()
  expect(levels).toMatchSnapshot()
}, ['otlp pprof: should push otlp profiles'])

// This is the one that exercises the stored OTLP payload: MergeProfiles reads
// the payload column, sees payload_type=otel_v1development and converts it back
// to pprof before merging. It therefore covers both the writer's dictionary
// pruning and the reader's otlpToPProf conversion.
__it('otlp pprof: should read pyro SelectMergeProfile', async () => {
  const req = new querier.SelectMergeProfileRequest()
  req.setProfileTypeid(CPU_TYPE)
  req.setLabelSelector(`{service_name="${serviceName}", __session_id__="${otlpTestID}"}`)
  req.setStart(start - 1)
  req.setEnd(end + 1)
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeProfile`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const pprof = require('./pyroscope_pb/profile_pb')
  const res = (pprof.Profile.deserializeBinary(_res.data)).toObject()
  const functions = {}
  for (const sample of res.sampleList) {
    for (const locationId of sample.locationIdList) {
      const location = res.locationList.find(l => l.id === locationId)
      for (const line of location.lineList) {
        const fn = res.functionList.find(f => f.id === line.functionId)
        const fnName = res.stringTableList[fn.name]
        functions[fnName] = functions[fnName] || new Array(sample.valueList.length).fill(0)
        sample.valueList.forEach((v, i) => {
          functions[fnName][i] += v
        })
      }
    }
  }
  for (const key of Object.keys(functions)) {
    functions[key].sort((a, b) => a - b)
  }
  expect(functions).toMatchSnapshot()
}, ['otlp pprof: should push otlp profiles'])

// A second profile type from the SAME export requests. If a multi-profile OTLP
// request ever collapses back into one row, this type disappears entirely.
__it('otlp pprof: should read the second profile type of each request', async () => {
  const req = new querier.SelectMergeStacktracesRequest()
  req.setProfileTypeid(ALLOC_TYPE)
  req.setLabelSelector(`{service_name="${serviceName}", __session_id__="${otlpTestID}"}`)
  req.setStart(start)
  req.setEnd(end)
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeStacktraces`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const res = (querier.SelectMergeStacktracesResponse.deserializeBinary(_res.data)).toObject()
  const names = [...res.flamegraph.namesList]
  names.sort()
  expect(names).toMatchSnapshot()
}, ['otlp pprof: should push otlp profiles'])

__it('otlp pprof: should read pyro SelectSeries', async () => {
  const req = new querier.SelectSeriesRequest()
  req.setProfileTypeid(CPU_TYPE)
  req.setLabelSelector(`{service_name="${serviceName}", __session_id__="${otlpTestID}"}`)
  req.setStart(start - 1)
  req.setEnd(end + 1)
  req.setStep(1)
  const reqBody = req.serializeBinary()
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/SelectSeries`,
    reqBody, { responseType: 'arraybuffer' }
  )
  const res = (querier.SelectSeriesResponse.deserializeBinary(_res.data)).toObject()
  const series = {}
  for (const serie of res.seriesList) {
    serie.labelsList.forEach((label) => {
      if (label.name === '__session_id__') {
        expect(label.value).toBe(otlpTestID)
        label.value = 'TEST_ID'
      }
    })
    serie.labelsList.sort((a, b) => a.name.localeCompare(b.name))
    serie.pointsList.forEach(p => { p.timestamp -= start })
    series[JSON.stringify(serie.labelsList)] = serie.pointsList
  }
  expect(series).toMatchSnapshot()
}, ['otlp pprof: should push otlp profiles'])

// Collectors and the eBPF profiler batch many processes into ONE export
// request: several resources, each with its own attributes, sharing one
// dictionary. Each resource must land as its own series, carrying only its own
// resource attributes and only its own samples. The failure this catches is a
// batch folded into one insert row: the request is rejected and nothing is
// stored, or the last resource's attributes and values overwrite the others'.
const multiTestID = testID + 'otlp-multi'
const multiResources = [
  { service: 'otlp-multi-a', resourceID: 'a', fn: 'a.work', value: 3 },
  { service: 'otlp-multi-b', resourceID: 'b', fn: 'b.work', value: 9 }
]

__it('otlp pprof: should push one request with several resources', async () => {
  const dict = new Dictionary()
  const timeUnixNanoStr = (start * 1000000).toString()
  const body = encodeRequest({
    dict,
    resources: multiResources.map(r => ({
      resourceAttrs: {
        'service.name': r.service,
        __session_id__: multiTestID,
        resource_id: r.resourceID
      },
      profiles: [
        profile(dict, {
          sampleType: ['samples', 'count'],
          periodType: ['cpu', 'nanoseconds'],
          timeUnixNanoStr,
          durationNano: 10000000000,
          samples: [{ stack: dict.stack([r.fn, 'main']), values: [r.value] }]
        })
      ]
    }))
  })
  await axiosPost(
    `${otelCollectorUrl}/v1development/profiles`,
    body,
    { headers: { 'Content-Type': 'application/x-protobuf' } }
  )
  await new Promise(f => setTimeout(f, 5000))
})

__it('otlp pprof: should keep each resource of one request as its own series', async () => {
  const req = new querier.SeriesRequest()
  req.setStart(start)
  req.setEnd(end)
  req.setMatchersList([`{__session_id__="${multiTestID}"}`])
  const _res = await axiosPost(
    `http://${clokiExtUrl}/querier.v1.QuerierService/Series`,
    req.serializeBinary(), { responseType: 'arraybuffer' }
  )
  const res = querier.SeriesResponse.deserializeBinary(_res.data)
  const pairs = res.getLabelsSetList().map(ls => {
    const labels = Object.fromEntries(ls.toObject().labelsList.map(l => [l.name, l.value]))
    return `${labels.service_name}/${labels.resource_id}`
  })
  pairs.sort()
  expect(pairs).toEqual(['otlp-multi-a/a', 'otlp-multi-b/b'])
}, ['otlp pprof: should push one request with several resources'])

__it('otlp pprof: should keep each resource of one request to its own samples', async () => {
  for (const r of multiResources) {
    const req = new querier.SelectMergeStacktracesRequest()
    req.setProfileTypeid(CPU_TYPE)
    req.setLabelSelector(`{service_name="${r.service}", __session_id__="${multiTestID}"}`)
    req.setStart(start)
    req.setEnd(end)
    const _res = await axiosPost(
      `http://${clokiExtUrl}/querier.v1.QuerierService/SelectMergeStacktraces`,
      req.serializeBinary(), { responseType: 'arraybuffer' }
    )
    const res = (querier.SelectMergeStacktracesResponse.deserializeBinary(_res.data)).toObject()
    const names = res.flamegraph.namesList
    const others = multiResources.filter(o => o !== r).map(o => o.fn)
    expect(names).toContain(r.fn)
    for (const fn of others) {
      expect(names).not.toContain(fn)
    }
    expect(res.flamegraph.total).toBe(r.value)
  }
}, ['otlp pprof: should push one request with several resources'])

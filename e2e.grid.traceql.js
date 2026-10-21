// TraceQL grid suite: every case in grid/traceql/cases.json must return the
// traces, spans and matched counts the oracle computes from the seed. Cases
// with `pushes` run between that many seed batches landing and the next push.
// Metrics cases run on the whole seed and must return the oracle's series.
// Autocomplete cases must suggest the keys or values of the oracle's result
// spans. Every seed step waits until select() returns the oracle's
// nested-set numbering for every landed span.
const { _it, testID } = require('./common')
const seed = require('./grid/traceql/seed')
const oracle = require('./grid/traceql/oracle')
const { metrics } = require('./grid/traceql/metrics')
const { autocomplete } = require('./grid/traceql/autocomplete')
const { runs, metricsRuns, autocompleteRuns } = require('./grid/traceql/cases')
const { nestedSetRows, nestedSetDiff, fromResponse, diff, names, fromMetricsResponse, metricsDiff, fromAutocompleteResponse, autocompleteDiff } = require('./grid/traceql/compare')
const client = require('./grid/traceql/client')

const TEST_ID = `${testID}_grid_traceql`
const PREFIX = ('7ace' + BigInt(testID.substring(2)).toString(16)).padEnd(24, '0').substring(0, 24)
const SLOT = Number(BigInt(testID.substring(2)) % 60n)
const { from: FROM } = seed.window(Date.now(), SLOT)
const SPANS = oracle.dataset(FROM, PREFIX, TEST_ID)
const NAMES = names(seed.ids(PREFIX))
const BATCHES = seed.zipkinBatches(FROM, PREFIX, TEST_ID)
const RUNS = runs(FROM)
const METRICS = metricsRuns(FROM)
const AUTOCOMPLETE = autocompleteRuns(FROM)

// NESTED_SET_PROBE lists every span of this run with its nested-set values:
// its range holds every seeded span, limit every trace and spss every span.
const NESTED_SET_PROBE = {
  query: `{ .test_id = "${TEST_ID}" } | select(nestedSetLeft, nestedSetRight, nestedSetParent)`,
  from: FROM - seed.HOUR - seed.SECOND,
  to: FROM + seed.WINDOW + 16 * seed.MINUTE,
  limit: seed.traces().length,
  spss: Math.max(...seed.traces().map(t => t.spans.length))
}

// numberingDiff diffs the probe's nested-set values against the oracle's
// numbering of the landed spans.
const numberingDiff = async (landed) => {
  const resp = await client.search(NESTED_SET_PROBE)
  if (resp.status !== 200) return [`search ${resp.status}: ${JSON.stringify(resp.data)}`]
  return nestedSetDiff(nestedSetRows(resp.data), landed)
}

const seeded = (pushes) => pushes === BATCHES.length ? 'grid traceql: seed' : `grid traceql: seed ${pushes} of ${BATCHES.length} pushes`

const check = async (run) => {
  const got = fromResponse(await client.search(run), NAMES)
  return diff(got, oracle.search(run.ast, SPANS, run))
}

const checkMetrics = async (run) => {
  const got = fromMetricsResponse(await client.metrics(run), run.kind)
  return metricsDiff(got, metrics(run.ast, SPANS, run), { kind: run.kind, step: run.step, from: FROM, names: NAMES })
}

const checkAutocomplete = async (run) => {
  const got = fromAutocompleteResponse(await client.autocomplete(run), run.tag === undefined)
  return autocompleteDiff(got, autocomplete(run.ast, SPANS, run))
}

let prev
for (let pushes = 1; pushes <= BATCHES.length; pushes++) {
  const step = seeded(pushes)
  const cases = RUNS.filter(r => (r.pushes || BATCHES.length) === pushes)
  _it(step, async () => {
    await client.push(BATCHES.slice(pushes - 1, pushes))
    // Every landed span is readable from the spans table ({}) and the attribute index.
    const probes = RUNS.filter(r => r.id === 'all_spss_100' || r.id === 'suite').map(r => ({ ...r, pushes }))
    const ready = await client.waitFor(async () => {
      for (const run of probes) {
        if ((await check(run)).length) return false
      }
      return true
    })
    expect(ready).toBe(true)
    const landed = SPANS.filter(s => s.push < pushes)
    let numbering = []
    const numbered = await client.waitFor(async () => {
      numbering = await numberingDiff(landed)
      return numbering.length === 0
    })
    expect(numbering).toEqual([])
    expect(numbered).toBe(true)
  }, prev && [prev])
  for (const run of cases) {
    _it(`grid traceql: ${run.name}`, async () => {
      expect(await check(run)).toEqual([])
    }, [step])
  }
  for (const run of AUTOCOMPLETE.filter(r => (r.pushes || BATCHES.length) === pushes)) {
    _it(`grid traceql autocomplete: ${run.name}`, async () => {
      expect(await checkAutocomplete(run)).toEqual([])
    }, [step])
  }
  prev = step
}

for (const run of METRICS) {
  _it(`grid traceql metrics: ${run.name}`, async () => {
    expect(await checkMetrics(run)).toEqual([])
  }, [seeded(BATCHES.length)])
}

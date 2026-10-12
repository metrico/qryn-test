// TraceQL grid suite: every case in grid/traceql/cases.json must return the
// traces, spans and matched counts the oracle computes from the seed.
const { _it, testID } = require('./common')
const seed = require('./grid/traceql/seed')
const oracle = require('./grid/traceql/oracle')
const { runs } = require('./grid/traceql/cases')
const { fromApi, diff, names } = require('./grid/traceql/compare')
const client = require('./grid/traceql/client')

const TEST_ID = `${testID}_grid_traceql`
const PREFIX = ('7ace' + BigInt(testID.substring(2)).toString(16)).padEnd(24, '0').substring(0, 24)
const SLOT = Number(BigInt(testID.substring(2)) % 60n)
const { from: FROM } = seed.window(Date.now(), SLOT)
const SPANS = oracle.dataset(FROM, PREFIX, TEST_ID)
const NAMES = names(seed.ids(PREFIX))
const SEEDED = 'grid traceql: seed'

_it(SEEDED, async () => {
  await client.push(seed.zipkinBatches(FROM, PREFIX, TEST_ID))
  // Every span is readable from the spans table ({}) and the attribute index.
  const probes = runs(FROM).filter(r => r.id === 'all_spss_100' || r.id === 'suite')
  const ready = await client.waitFor(async () => {
    for (const run of probes) {
      const got = fromApi(await client.search(run), NAMES)
      if (diff(got, oracle.search(run.ast, SPANS, run)).length) return false
    }
    return true
  })
  expect(ready).toBe(true)
})

for (const run of runs(FROM)) {
  _it(`grid traceql: ${run.name}`, async () => {
    const got = fromApi(await client.search(run), NAMES)
    const want = oracle.search(run.ast, SPANS, run)
    expect(diff(got, want)).toEqual([])
  }, [SEEDED])
}

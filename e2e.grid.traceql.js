// TraceQL grid suite: every case in grid/traceql/cases.json must return the
// traces, spans and matched counts the oracle computes from the seed. Cases
// with `pushes` run once that many seed batches have landed and before the
// next one is pushed: tests run in declaration order.
const { _it, testID } = require('./common')
const seed = require('./grid/traceql/seed')
const oracle = require('./grid/traceql/oracle')
const { runs } = require('./grid/traceql/cases')
const { fromResponse, diff, names } = require('./grid/traceql/compare')
const client = require('./grid/traceql/client')

const TEST_ID = `${testID}_grid_traceql`
const PREFIX = ('7ace' + BigInt(testID.substring(2)).toString(16)).padEnd(24, '0').substring(0, 24)
const SLOT = Number(BigInt(testID.substring(2)) % 60n)
const { from: FROM } = seed.window(Date.now(), SLOT)
const SPANS = oracle.dataset(FROM, PREFIX, TEST_ID)
const NAMES = names(seed.ids(PREFIX))
const BATCHES = seed.zipkinBatches(FROM, PREFIX, TEST_ID)
const RUNS = runs(FROM)

const seeded = (pushes) => pushes === BATCHES.length ? 'grid traceql: seed' : `grid traceql: seed ${pushes} of ${BATCHES.length} pushes`

const check = async (run) => {
  const got = fromResponse(await client.search(run), NAMES)
  return diff(got, oracle.search(run.ast, SPANS, run))
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
  }, prev && [prev])
  for (const run of cases) {
    _it(`grid traceql: ${run.name}`, async () => {
      expect(await check(run)).toEqual([])
    }, [step])
  }
  prev = step
}

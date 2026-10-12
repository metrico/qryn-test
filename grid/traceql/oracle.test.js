// TraceQL oracle self-check, run without a gigapipe stack: the seed holds the
// nine fixture shapes, every case's query prints from its AST, and the oracle
// reproduces hand-checked results for every case.

const seed = require('./seed')
const oracle = require('./oracle')
const { print } = require('./ast')
const { runs } = require('./cases')
const { diff } = require('./compare')

const FROM = Date.UTC(2026, 9, 1, 12)
const PREFIX = '7ace00000000000000000000'
const spans = oracle.dataset(FROM, PREFIX, 'selfcheck')
const byName = (ts) => Object.fromEntries(ts.map(t => [t.name, t]))

describe('traceql grid seed', () => {
  const ts = byName(seed.traces())
  const children = (t, parent) => t.spans.filter(s => s.parent === parent)

  it('holds the nine fixture shapes', () => {
    const depth = (t) => {
      const parent = Object.fromEntries(t.spans.map(s => [s.name, s.parent]))
      return Math.max(...t.spans.map(s => {
        let d = 1
        for (let p = parent[s.name]; p && !p.startsWith('missing:'); p = parent[p]) d++
        return d
      }))
    }
    expect([depth(ts.chain9), depth(ts.chain8)]).toEqual([9, 8])
    expect(children(ts.fanout, 'fan_root')).toHaveLength(50)
    expect(ts.fanout.spans.filter(s => s.attrs.role === 'grandchild').length).toBeGreaterThan(0)
    expect(new Set(ts.mixed.spans.map(s => s.attrs.lvl))).toEqual(new Set(['0', '1', '2']))
    expect(ts.orphan.spans.filter(s => s.parent === null)).toHaveLength(1)
    expect(ts.orphan.spans.some(s => s.parent && s.parent.startsWith('missing:'))).toBe(true)
    expect(ts.tworoots.spans.filter(s => s.parent === null)).toHaveLength(2)
    expect(ts.rootless.spans.filter(s => s.parent === null)).toHaveLength(0)
    const pushes = (t) => [...new Set(t.spans.map(s => s.push))].sort()
    expect(pushes(ts.mixed2)).toEqual([0, 1])
    expect(ts.mixed2.spans.find(s => s.parent === null).push).toEqual(1)
    expect(ts.mixed2.spans.filter(s => s.parent !== null).every(s => s.push === 0)).toBe(true)
    expect(new Set(ts.attrs.spans.map(s => s.attrs.v))).toEqual(new Set([undefined, '200', '-3', '1.5', 'abc', 'true', '5ms']))
    const start = (name) => seed.traces().flatMap(t => t.spans).find(s => s.name === name).start
    expect([start('ec_root'), start('ec_mid')]).toEqual([-seed.HOUR, -10 * seed.MINUTE])
    expect([start('eb_from'), start('eb_to'), start('el_b')]).toEqual([0, seed.WINDOW, seed.WINDOW + 5 * seed.MINUTE])
  })

  it('names every span once, links parents within the trace and gives distinct start times', () => {
    const all = seed.traces().flatMap(t => t.spans.map(s => ({ ...s, trace: t.name })))
    expect(new Set(all.map(s => s.name)).size).toEqual(all.length)
    const traceOf = Object.fromEntries(all.map(s => [s.name, s.trace]))
    for (const s of all) {
      if (s.parent && !s.parent.startsWith('missing:')) expect(traceOf[s.parent]).toEqual(s.trace)
    }
    expect(new Set(all.map(s => s.start)).size).toEqual(all.length)
  })

  it('assigns distinct ids', () => {
    const id = seed.ids(PREFIX)
    expect(new Set(Object.values(id.trace)).size).toEqual(Object.keys(id.trace).length)
    expect(new Set(Object.values(id.span)).size).toEqual(Object.keys(id.span).length)
    expect(Object.values(id.trace).every(t => /^[0-9a-f]{32}$/.test(t))).toBe(true)
    expect(Object.values(id.span).every(s => /^[0-9a-f]{16}$/.test(s))).toBe(true)
  })

  it('pushes the Zipkin batches with parent ids and whole-microsecond times', () => {
    const batches = seed.zipkinBatches(FROM, PREFIX, 'selfcheck')
    expect(batches).toHaveLength(2)
    const all = batches.flat()
    expect(all.filter(z => z.parentId === undefined).map(z => z.name).sort())
      .toEqual(['am_root', 'c8_0', 'c9_0', 'eb_root', 'ec_root', 'el_a', 'fan_root', 'mix2_root', 'mix_root', 'orph_root', 'two_r1', 'two_r2'])
    expect(batches[1].map(z => z.name)).toEqual(['mix2_root'])
    expect(all.find(z => z.name === 'eb_from').timestamp).toEqual(FROM * 1000)
  })

  it('places the window in a two-hour slot at least a day back', () => {
    const now = Date.UTC(2026, 9, 12, 18, 52, 13)
    expect(seed.window(now, 0)).toEqual({ from: Date.UTC(2026, 9, 11, 16), to: Date.UTC(2026, 9, 11, 16, 30) })
    expect(seed.window(now, 3).from).toEqual(Date.UTC(2026, 9, 11, 10))
    expect(() => seed.window(now, 60)).toThrow()
  })
})

describe('traceql grid cases', () => {
  const file = require('./cases.json')
  it('have unique ids', () => {
    expect(new Set(file.cases.map(c => c.id)).size).toEqual(file.cases.length)
  })
  for (const c of file.cases) {
    it(`${c.id} prints its query from its AST`, () => {
      expect(print(c.ast)).toEqual(c.query)
    })
  }
})

// Every trace's three newest in-range spans and in-range span count.
const NEWEST = {
  chain9: [['c9_8', 'c9_7', 'c9_6'], 9],
  chain8: [['c8_7', 'c8_6', 'c8_5'], 8],
  fanout: [['fan_c49', 'fan_c48', 'fan_c47'], 71],
  mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 6],
  orphan: [['orph_o2', 'orph_o1', 'orph_child'], 4],
  tworoots: [['two_r2c', 'two_r1c', 'two_r2'], 4],
  rootless: [['rl_c', 'rl_b', 'rl_a'], 3],
  mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 6],
  attrs: [['am_dur', 'am_bool', 'am_str'], 8],
  edge_chain: [['ec_leaf'], 1],
  edge_bound: [['eb_to', 'eb_mid'], 2],
  edge_late: [['el_a'], 1]
}

// Every trace's in-range span count.
const IN_RANGE = { chain9: 9, chain8: 8, fanout: 71, mixed: 6, orphan: 4, tworoots: 4, rootless: 3, mixed2: 6, attrs: 8, edge_chain: 1, edge_bound: 2, edge_late: 1 }

// Hand-checked results per case: trace -> [listed spans, matched], or just
// matched when the listed spans are the trace's spss newest.
const EXPECTED = {
  all: NEWEST,
  all_limit_3: { edge_bound: NEWEST.edge_bound, edge_late: NEWEST.edge_late, edge_chain: NEWEST.edge_chain },
  all_spss_100: IN_RANGE,
  suite: NEWEST,
  suite_limit_2: { edge_bound: [['eb_to', 'eb_mid'], 2], edge_late: [['el_a'], 1] },
  fanout: { fanout: [['fan_c49', 'fan_c48', 'fan_c47'], 71] },
  fanout_children_spss_5: { fanout: [['fan_c49', 'fan_c48', 'fan_c47', 'fan_c46', 'fan_c45'], 50] },
  fanout_spss_1: { fanout: [['fan_c49'], 71] },
  name: { mixed: [['mix_a'], 1] },
  lvl_numeric: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  depth_ge_7: { chain9: [['c9_8', 'c9_7'], 2], chain8: [['c8_7'], 1] },
  svc_db_and_lvl: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  svc_db_or_gateway: { mixed: [['mix_b1', 'mix_a1', 'mix_root'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_root'], 3] },
  svc_regex: { mixed: [['mix_a2'], 1], mixed2: [['mix2_a2'], 1] },
  span_scope: { mixed: [['mix_a1'], 1], mixed2: [['mix2_a1'], 1] },
  resource_scope: { tworoots: [['two_r2c', 'two_r1c', 'two_r2'], 4] },
  status_error: { mixed: [['mix_b'], 1], mixed2: [['mix2_b'], 1] },
  duration_gt_100ms: { mixed: [['mix_root'], 1], mixed2: [['mix2_root'], 1], attrs: [['am_float', 'am_root'], 2] },
  v_gt_1: { attrs: [['am_float', 'am_int'], 2] },
  v_ne_abc: { attrs: [['am_dur', 'am_bool', 'am_float'], 5] },
  edge: { edge_chain: [['ec_leaf'], 1], edge_bound: [['eb_to', 'eb_mid'], 2], edge_late: [['el_a'], 1] },
  edge_at_from: {},
  edge_at_to: { edge_bound: [['eb_to'], 1] },
  edge_out_of_range_root: {},
  edge_late: {},
  edge_late_wider: { edge_late: [['el_b'], 1] },
  edge_wider_start: { edge_chain: [['ec_leaf', 'ec_mid'], 2], edge_bound: [['eb_to', 'eb_mid', 'eb_from'], 4], edge_late: [['el_a'], 1] },
  and_parent_child: { mixed: [['mix_a1', 'mix_a'], 2] },
  and_svc_db_gateway: { mixed: [['mix_b1', 'mix_a1', 'mix_root'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_root'], 3] },
  and_no_shared_trace: {},
  and_dedup: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  and_fanout_spss: { fanout: [['fan_c45_g1', 'fan_c45_g0', 'fan_c40_g1'], 21] },
  and_three: { mixed: [['mix_b', 'mix_a', 'mix_root'], 3] },
  and_out_of_range_operand: {},
  and_orphan: { orphan: [['orph_o2', 'orph_o1', 'orph_root'], 3] },
  and_rootless: { rootless: [['rl_c', 'rl_b', 'rl_a'], 3] },
  and_across_pushes: { mixed2: [['mix2_b1', 'mix2_root'], 2] },
  and_chain_attrs: { chain9: [['c9_8', 'c9_7', 'c9_6'], 9] },
  or_union: {
    mixed: [['mix_b1', 'mix_a1'], 2],
    mixed2: [['mix2_b1', 'mix2_a1'], 2],
    fanout: [['fan_root'], 1],
    orphan: [['orph_root'], 1],
    tworoots: [['two_r2', 'two_r1'], 2],
    edge_late: [['el_a'], 1]
  },
  or_union_limit_2: { edge_late: [['el_a'], 1], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  or_dedup: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  or_boundary: { edge_bound: [['eb_to', 'eb_mid'], 2] },
  or_attrs: { attrs: [['am_str', 'am_float', 'am_int'], 3] },
  and_or_left_assoc: { tworoots: [['two_r2c', 'two_r1c', 'two_r2'], 4] },
  or_paren_and: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2], tworoots: [['two_r2c', 'two_r1c', 'two_r2'], 4] },
  and_paren_or: { mixed: [['mix_b1', 'mix_a1', 'mix_a'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_a'], 3] }
}

describe('traceql oracle on hand-checked results', () => {
  const all = runs(FROM)
  it('has a hand-checked result for exactly the cases in cases.json', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(all.map(r => r.id).sort())
  })
  for (const run of all) {
    it(run.name, () => {
      const got = oracle.search(run.ast, spans, run)
      const spss = run.spss || oracle.DEFAULT_SPSS
      const want = Object.entries(EXPECTED[run.id] || {}).map(([trace, e]) => typeof e === 'number'
        ? { trace, spans: got.find(t => t.trace === trace)?.spans || [], matched: e, spssCheck: Math.min(spss, e) }
        : { trace, spans: e[0], matched: e[1] })
      for (const w of want.filter(w => w.spssCheck !== undefined)) expect(w.spans).toHaveLength(w.spssCheck)
      expect(diff(got, want)).toEqual([])
      for (const t of got) {
        const order = t.spans.map(n => spans.find(s => s.name === n).start)
        expect(order).toEqual([...order].sort((a, b) => b - a))
      }
    })
  }
})

describe('traceql oracle rules', () => {
  const sel = (selector) => ({ pipeline: [{ selector }] })
  const named = (name) => ({ op: '=', lhs: { attr: 'name' }, rhs: { str: name } })
  const opts = { from: FROM, to: FROM + seed.WINDOW, limit: 100 }

  it('breaks start-time ties by span id and trace id, descending', () => {
    const tied = spans.map(s => ({ ...s, start: FROM + 1000 }))
    const got = oracle.search(sel(null), tied, { ...opts, limit: 1, spss: 2 })
    const lastTrace = [...new Set(spans.map(s => s.traceId))].sort().pop()
    expect(got[0].traceId).toEqual(lastTrace)
    const ids = tied.filter(s => s.traceId === lastTrace).map(s => s.spanId).sort().reverse()
    expect(got[0].spans).toEqual(ids.slice(0, 2).map(id => tied.find(s => s.spanId === id).name))
  })

  it('rejects what it cannot evaluate', () => {
    expect(() => oracle.search({ pipeline: [{ spansetOp: '>>', lhs: sel(null).pipeline[0], rhs: sel(null).pipeline[0] }] }, spans, opts)).toThrow(/unsupported/)
    expect(() => oracle.search(sel({ op: '=', lhs: { attr: 'foo' }, rhs: { str: 'x' } }), spans, opts)).toThrow(/attribute/)
    expect(oracle.search(sel(named('nope')), spans, opts)).toEqual([])
  })

  it('parses durations', () => {
    expect(oracle.durationNs('1.5ms')).toEqual(1.5e6)
    expect(oracle.durationNs('2s')).toEqual(2e9)
    expect(() => oracle.durationNs('5')).toThrow()
  })
})

describe('traceql result diff', () => {
  const t = (trace, spans, matched) => ({ trace, spans, matched })
  it('matches regardless of trace and span order', () => {
    expect(diff([t('b', ['y', 'x'], 2), t('a', ['z'], 1)], [t('a', ['z'], 1), t('b', ['x', 'y'], 2)])).toEqual([])
  })
  it('reports extra, missing, span and matched mismatches', () => {
    expect(diff([t('a', ['x'], 1), t('c', ['w'], 1)], [t('a', ['y'], 2), t('b', ['z'], 1)])).toEqual([
      'a spans x, want y',
      'a matched 1, want 2',
      'b missing: want z matched 1',
      'c extra: w matched 1'
    ])
  })
  it('reports a spanSet that differs from spanSets[0] and extra spansets', () => {
    const got = [{ ...t('a', ['x'], 1), spanSets: 2, spanSetMatchesFirst: false }]
    expect(diff(got, [t('a', ['x'], 1)])).toEqual(['a has 2 spanSets, want 1', 'a spanSet differs from spanSets[0]'])
  })
})

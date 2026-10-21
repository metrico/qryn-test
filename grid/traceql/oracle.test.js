// TraceQL oracle self-check, run without a gigapipe stack: the seed holds the
// fixture shapes, every case's query prints from its AST, and the oracle
// reproduces hand-checked results for every search, metrics and autocomplete
// case.

const seed = require('./seed')
const oracle = require('./oracle')
const { metrics, labelKey, histogramBucket, sampleFraction, exemplarLimit, thin } = require('./metrics')
const { cityHash64, sampleThreshold } = require('./cityhash')
const { autocomplete, selectsEverySpan } = require('./autocomplete')
const { print } = require('./ast')
const { runs, metricsRuns, autocompleteRuns } = require('./cases')
const { nestedSetDiff, nestedSetRows, diff, fromApi, metricsDiff, fromMetricsResponse, fromAutocompleteResponse, autocompleteDiff } = require('./compare')

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
    expect(new Set(ts.attrs.spans.map(s => s.attrs.w))).toEqual(new Set([undefined, '1', '200', '7', 'abc', 'false']))
    const start = (name) => seed.traces().flatMap(t => t.spans).find(s => s.name === name).start
    expect([start('ec_root'), start('ec_mid')]).toEqual([-seed.HOUR, -10 * seed.MINUTE])
    expect([start('eb_from'), start('eb_to'), start('el_b')]).toEqual([0, seed.WINDOW, seed.WINDOW + 5 * seed.MINUTE])
  })

  it('names every span once, links parents within the trace and gives distinct start times outside the nested-set trace', () => {
    const all = seed.traces().flatMap(t => t.spans.map(s => ({ ...s, trace: t.name })))
    expect(new Set(all.map(s => s.name)).size).toEqual(all.length)
    const traceOf = Object.fromEntries(all.map(s => [s.name, s.trace]))
    for (const s of all) {
      if (s.parent && !s.parent.startsWith('missing:')) expect(traceOf[s.parent]).toEqual(s.trace)
    }
    const timed = all.filter(s => s.trace !== 'nested')
    expect(new Set(timed.map(s => s.start)).size).toEqual(timed.length)
  })

  it('holds the nested-set fixtures after every case range', () => {
    const t = ts.nested
    const by = Object.fromEntries(t.spans.map(s => [s.name, s]))
    expect(by.ns_r1.start).toEqual(by.ns_r2.start)
    expect(by.ns_a.start).toEqual(by.ns_b.start)
    expect(by.ns_self.parent).toEqual('ns_self')
    expect([by.ns_cyc1.parent, by.ns_cyc2.parent]).toEqual(['ns_cyc2', 'ns_cyc1'])
    expect(by.ns_dup_early.sameId).toEqual('ns_dup')
    expect(by.ns_dup_early.start).toBeLessThan(by.ns_dup.start)
    expect(by.ns_late.push).toEqual(2)
    const latest = Math.max(...runs(FROM).map(r => r.to), ...metricsRuns(FROM).map(r => r.to), ...autocompleteRuns(FROM).map(r => r.to))
    expect(Math.min(...t.spans.map(s => FROM + s.start))).toBeGreaterThan(latest)
  })

  it('assigns distinct ids, except a span that reuses one', () => {
    const id = seed.ids(PREFIX)
    expect(new Set(Object.values(id.trace)).size).toEqual(Object.keys(id.trace).length)
    const reused = seed.traces().flatMap(t => t.spans).filter(s => s.sameId)
    expect(reused.map(s => id.span[s.name])).toEqual(reused.map(s => id.span[s.sameId]))
    expect(new Set(Object.values(id.span)).size).toEqual(Object.keys(id.span).length - reused.length)
    expect(Object.values(id.trace).every(t => /^[0-9a-f]{32}$/.test(t))).toBe(true)
    expect(Object.values(id.span).every(s => /^[0-9a-f]{16}$/.test(s))).toBe(true)
  })

  it('pushes the Zipkin batches with parent ids and whole-microsecond times', () => {
    const batches = seed.zipkinBatches(FROM, PREFIX, 'selfcheck')
    expect(batches).toHaveLength(3)
    const all = batches.flat()
    expect(all.filter(z => z.parentId === undefined).map(z => z.name).sort())
      .toEqual(['am_root', 'c8_0', 'c9_0', 'eb_root', 'ec_root', 'el_a', 'fan_root', 'mix2_root', 'mix_root', 'ns_r1', 'ns_r2', 'orph_root', 'two_r1', 'two_r2'])
    expect(batches[1].map(z => z.name)).toEqual(['mix2_root'])
    expect(batches[2].map(z => z.name)).toEqual(['ns_late'])
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
    const ids = [...file.cases, ...file.metrics, ...file.autocomplete].map(c => c.id)
    expect(new Set(ids).size).toEqual(ids.length)
  })
  for (const c of [...file.cases, ...file.metrics, ...file.autocomplete]) {
    it(`${c.id} prints its query from its AST`, () => {
      expect(print(c.ast)).toEqual(c.query)
    })
  }
})

// Every trace's three earliest-starting in-range spans and in-range span count.
const EARLIEST = {
  chain9: [['c9_0', 'c9_1', 'c9_2'], 9],
  chain8: [['c8_0', 'c8_1', 'c8_2'], 8],
  fanout: [['fan_root', 'fan_c00', 'fan_c00_g0'], 71],
  mixed: [['mix_root', 'mix_a', 'mix_b'], 6],
  orphan: [['orph_root', 'orph_child', 'orph_o1'], 4],
  tworoots: [['two_r1', 'two_r2', 'two_r1c'], 4],
  rootless: [['rl_a', 'rl_b', 'rl_c'], 3],
  mixed2: [['mix2_root', 'mix2_a', 'mix2_b'], 6],
  attrs: [['am_root', 'am_missing', 'am_int'], 8],
  edge_chain: [['ec_leaf'], 1],
  edge_bound: [['eb_to', 'eb_mid'], 2],
  edge_late: [['el_a'], 1]
}

// Every trace's in-range span count.
const IN_RANGE = { chain9: 9, chain8: 8, fanout: 71, mixed: 6, orphan: 4, tworoots: 4, rootless: 3, mixed2: 6, attrs: 8, edge_chain: 1, edge_bound: 2, edge_late: 1 }

// One-hop operators between every in-range span (spss 100): spans with an
// in-range parent, with a different in-range sibling, without one, and every
// parent and child. Spans that cannot reach a root never relate.
const HOP_CHILD = {
  chain9: 8,
  chain8: 7,
  fanout: 70,
  mixed: [['mix_a', 'mix_b', 'mix_a1', 'mix_a2', 'mix_b1'], 5],
  orphan: [['orph_child'], 1],
  tworoots: [['two_r1c', 'two_r2c'], 2],
  mixed2: [['mix2_a', 'mix2_b', 'mix2_a1', 'mix2_a2', 'mix2_b1'], 5],
  attrs: 7
}
const HOP_SIBLING = {
  fanout: 70,
  mixed: [['mix_a', 'mix_b', 'mix_a1', 'mix_a2'], 4],
  tworoots: [['two_r1', 'two_r2'], 2],
  mixed2: [['mix2_a', 'mix2_b', 'mix2_a1', 'mix2_a2'], 4],
  attrs: 7,
  edge_bound: [['eb_mid', 'eb_to'], 2]
}
const HOP_NOT_SIBLING = {
  chain9: 9,
  chain8: 8,
  fanout: [['fan_root'], 1],
  mixed: [['mix_root', 'mix_b1'], 2],
  orphan: [['orph_root', 'orph_child', 'orph_o1', 'orph_o2'], 4],
  tworoots: [['two_r1c', 'two_r2c'], 2],
  rootless: [['rl_a', 'rl_b', 'rl_c'], 3],
  mixed2: [['mix2_root', 'mix2_b1'], 2],
  attrs: [['am_root'], 1],
  edge_chain: [['ec_leaf'], 1],
  edge_late: [['el_a'], 1]
}
const HOP_UNION_CHILD = {
  chain9: 9,
  chain8: 8,
  fanout: 71,
  mixed: 6,
  orphan: [['orph_root', 'orph_child'], 2],
  tworoots: [['two_r1', 'two_r2', 'two_r1c', 'two_r2c'], 4],
  mixed2: 6,
  attrs: 8
}

// Transitive operators between every span that resolves under R=3 (spss 100):
// spans with an in-range ancestor, with an in-range descendant, and both.
const TR_DESCENDANT = {
  chain8: [['c8_1', 'c8_2', 'c8_3', 'c8_4', 'c8_5', 'c8_6', 'c8_7'], 7],
  fanout: 70,
  mixed: [['mix_a', 'mix_b', 'mix_a1', 'mix_a2', 'mix_b1'], 5],
  orphan: [['orph_child'], 1],
  tworoots: [['two_r1c', 'two_r2c'], 2],
  mixed2: [['mix2_a', 'mix2_b', 'mix2_a1', 'mix2_a2', 'mix2_b1'], 5],
  attrs: 7
}
const TR_ANCESTOR = {
  chain8: [['c8_0', 'c8_1', 'c8_2', 'c8_3', 'c8_4', 'c8_5', 'c8_6'], 7],
  fanout: 11,
  mixed: [['mix_root', 'mix_a', 'mix_b'], 3],
  orphan: [['orph_root'], 1],
  tworoots: [['two_r1', 'two_r2'], 2],
  mixed2: [['mix2_root', 'mix2_a', 'mix2_b'], 3],
  attrs: [['am_root'], 1]
}
const TR_UNION = {
  chain8: 8,
  fanout: 71,
  mixed: 6,
  orphan: [['orph_root', 'orph_child'], 2],
  tworoots: [['two_r1', 'two_r2', 'two_r1c', 'two_r2c'], 4],
  mixed2: 6,
  attrs: 8
}

// Spanset attribute values as search returns them.
const intAttr = (n) => ({ intValue: String(n) })
const doubleAttr = (x) => ({ doubleValue: x })
const durationAttr = (d) => ({ stringValue: d })
const strAttr = (v) => ({ stringValue: v })
const boolAttr = (b) => ({ boolValue: b })
const NIL = strAttr('nil')

// ns is a span's selected nested-set values.
const ns = (left, right, parent) => ({ nestedSetLeft: intAttr(left), nestedSetRight: intAttr(right), nestedSetParent: intAttr(parent) })

// The tworoots spans, newest first.
const TWO_NEWEST = ['two_r2c', 'two_r1c', 'two_r2', 'two_r1']

// sets lists a trace's spansets in order, each as [listed spans, matched, attributes?, selected?].
const sets = (...ss) => ({ sets: ss })

// The level-2 spans of the mixed trees, and the three earliest-starting spans
// of the mixed trees and of the attribute matrix.
const MIXED_LEAVES = ['mix_a1', 'mix_a2', 'mix_b1']
const MIXED2_LEAVES = ['mix2_a1', 'mix2_a2', 'mix2_b1']
const MIXED_EARLIEST = ['mix_root', 'mix_a', 'mix_b']
const MIXED2_EARLIEST = ['mix2_root', 'mix2_a', 'mix2_b']
const ATTRS_EARLIEST = ['am_root', 'am_missing', 'am_int']

// Hand-checked results per case: trace -> [listed spans in any order, matched,
// attributes?, selected?], or just matched when the listed spans are the
// trace's spss earliest-starting spans, or sets(...) for a trace with several
// spansets; UNRESOLVED when ancestry does not resolve within the round limit,
// GROUPED for a spanset operator over grouped spansets. Attributes map a name
// to its OTLP value, selected a listed span to its select() values (the span
// name at `#name`); both default to none.
const EXPECTED = {
  all: EARLIEST,
  all_limit_3: { edge_bound: EARLIEST.edge_bound, edge_late: EARLIEST.edge_late, edge_chain: EARLIEST.edge_chain },
  all_spss_100: IN_RANGE,
  suite: EARLIEST,
  suite_limit_2: { edge_bound: [['eb_to', 'eb_mid'], 2], edge_late: [['el_a'], 1] },
  fanout: { fanout: EARLIEST.fanout },
  fanout_children_spss_5: { fanout: [['fan_c00', 'fan_c01', 'fan_c02', 'fan_c03', 'fan_c04'], 50] },
  fanout_spss_1: { fanout: [['fan_root'], 71] },
  name: { mixed: [['mix_a'], 1] },
  lvl_numeric: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  depth_ge_7: { chain9: [['c9_8', 'c9_7'], 2], chain8: [['c8_7'], 1] },
  svc_db_and_lvl: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  svc_db_or_gateway: { mixed: [['mix_b1', 'mix_a1', 'mix_root'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_root'], 3] },
  svc_regex: { mixed: [['mix_a2'], 1], mixed2: [['mix2_a2'], 1] },
  span_scope: { mixed: [['mix_a1'], 1], mixed2: [['mix2_a1'], 1] },
  resource_scope: { tworoots: [['two_r1', 'two_r2', 'two_r1c'], 4] },
  status_error: { mixed: [['mix_b'], 1], mixed2: [['mix2_b'], 1] },
  duration_gt_100ms: { mixed: [['mix_root'], 1], mixed2: [['mix2_root'], 1], attrs: [['am_float', 'am_root'], 2] },
  v_gt_1: { attrs: [['am_float', 'am_int'], 2] },
  v_ne_abc: { attrs: [['am_int', 'am_int_neg', 'am_float'], 5] },
  edge: { edge_chain: [['ec_leaf'], 1], edge_bound: [['eb_to', 'eb_mid'], 2], edge_late: [['el_a'], 1] },
  edge_at_from: {},
  edge_at_to: { edge_bound: [['eb_to'], 1] },
  edge_out_of_range_root: {},
  edge_late: {},
  edge_late_wider: { edge_late: [['el_b'], 1] },
  edge_wider_start: { edge_chain: [['ec_leaf', 'ec_mid'], 2], edge_bound: [['eb_root', 'eb_from', 'eb_mid'], 4], edge_late: [['el_a'], 1] },
  and_parent_child: { mixed: [['mix_a1', 'mix_a'], 2] },
  and_svc_db_gateway: { mixed: [['mix_b1', 'mix_a1', 'mix_root'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_root'], 3] },
  and_no_shared_trace: {},
  and_dedup: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  and_fanout_spss: { fanout: [['fan_root', 'fan_c00_g0', 'fan_c00_g1'], 21] },
  and_three: { mixed: [['mix_b', 'mix_a', 'mix_root'], 3] },
  and_out_of_range_operand: {},
  and_orphan: { orphan: [['orph_o2', 'orph_o1', 'orph_root'], 3] },
  and_rootless: { rootless: [['rl_c', 'rl_b', 'rl_a'], 3] },
  and_across_pushes: { mixed2: [['mix2_b1', 'mix2_root'], 2] },
  and_chain_attrs: { chain9: [['c9_0', 'c9_1', 'c9_2'], 9] },
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
  and_or_left_assoc: { tworoots: [['two_r1', 'two_r2', 'two_r1c'], 4] },
  or_paren_and: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2], tworoots: [['two_r1', 'two_r2', 'two_r1c'], 4] },
  and_paren_or: { mixed: [['mix_b1', 'mix_a1', 'mix_a'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_a'], 3] },
  hop_child_all: HOP_CHILD,
  hop_parent_all: {
    chain9: 8,
    chain8: 7,
    fanout: 11,
    mixed: [['mix_root', 'mix_a', 'mix_b'], 3],
    orphan: [['orph_root'], 1],
    tworoots: [['two_r1', 'two_r2'], 2],
    mixed2: [['mix2_root', 'mix2_a', 'mix2_b'], 3],
    attrs: [['am_root'], 1]
  },
  hop_sibling_all: HOP_SIBLING,
  hop_not_child_all: {
    chain9: [['c9_0'], 1],
    chain8: [['c8_0'], 1],
    fanout: [['fan_root'], 1],
    mixed: [['mix_root'], 1],
    orphan: [['orph_root', 'orph_o1', 'orph_o2'], 3],
    tworoots: [['two_r1', 'two_r2'], 2],
    rootless: [['rl_a', 'rl_b', 'rl_c'], 3],
    mixed2: [['mix2_root'], 1],
    attrs: [['am_root'], 1],
    edge_chain: [['ec_leaf'], 1],
    edge_bound: [['eb_mid', 'eb_to'], 2],
    edge_late: [['el_a'], 1]
  },
  hop_not_parent_all: {
    chain9: [['c9_8'], 1],
    chain8: [['c8_7'], 1],
    fanout: 60,
    mixed: [['mix_a1', 'mix_a2', 'mix_b1'], 3],
    orphan: [['orph_child', 'orph_o1', 'orph_o2'], 3],
    tworoots: [['two_r1c', 'two_r2c'], 2],
    rootless: [['rl_a', 'rl_b', 'rl_c'], 3],
    mixed2: [['mix2_a1', 'mix2_a2', 'mix2_b1'], 3],
    attrs: [['am_missing', 'am_int', 'am_int_neg', 'am_float', 'am_str', 'am_bool', 'am_dur'], 7],
    edge_chain: [['ec_leaf'], 1],
    edge_bound: [['eb_mid', 'eb_to'], 2],
    edge_late: [['el_a'], 1]
  },
  hop_not_sibling_all: HOP_NOT_SIBLING,
  hop_union_child_all: HOP_UNION_CHILD,
  hop_union_parent_all: HOP_UNION_CHILD,
  hop_union_sibling_all: HOP_SIBLING,
  hop_child_empty_operands: HOP_CHILD,
  hop_not_sibling_empty_operands: HOP_NOT_SIBLING,
  hop_union_parent_empty_operands: HOP_UNION_CHILD,
  hop_child: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  hop_parent: { mixed: [['mix_b', 'mix_a'], 2], mixed2: [['mix2_b', 'mix2_a'], 2] },
  hop_sibling: { mixed: [['mix_a2'], 1], mixed2: [['mix2_a2'], 1] },
  hop_not_child: { mixed: [['mix_b1'], 1], mixed2: [['mix2_b1'], 1] },
  hop_not_parent: { mixed: [['mix_b'], 1], mixed2: [['mix2_b'], 1] },
  hop_not_sibling: { mixed: [['mix_b1', 'mix_a2'], 2], mixed2: [['mix2_b1', 'mix2_a2'], 2] },
  hop_union_child: { mixed: [['mix_b1', 'mix_b'], 2], mixed2: [['mix2_b1', 'mix2_b'], 2] },
  hop_union_parent: { mixed: [['mix_a2', 'mix_a'], 2], mixed2: [['mix2_a2', 'mix2_a'], 2] },
  hop_union_sibling: { mixed: [['mix_b', 'mix_a'], 2], mixed2: [['mix2_b', 'mix2_a'], 2] },
  hop_chain: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  hop_chain_depth: { chain9: [['c9_4'], 1], chain8: [['c8_4'], 1] },
  hop_group_rhs: { mixed: [['mix_a2', 'mix_a1'], 2], mixed2: [['mix2_a2', 'mix2_a1'], 2] },
  hop_group_lhs: {},
  hop_chain_child: { chain9: [['c9_8'], 1] },
  hop_chain_parent: { chain9: [['c9_6'], 1] },
  hop_orphan_child: {},
  hop_orphan_not_child: { orphan: [['orph_o2', 'orph_o1'], 2] },
  hop_orphan_rooted_child: { orphan: [['orph_child'], 1] },
  hop_orphan_sibling: {},
  hop_rootless_child: {},
  hop_rootless_not_child: {
    fanout: [['fan_c00', 'fan_c01', 'fan_c02'], 50],
    orphan: [['orph_child'], 1],
    tworoots: [['two_r2c', 'two_r1c'], 2],
    rootless: [['rl_c', 'rl_b'], 2]
  },
  hop_rootless_sibling: {},
  hop_roots_siblings: { tworoots: [['two_r2', 'two_r1'], 2] },
  hop_root_children: {
    fanout: [['fan_c00', 'fan_c01', 'fan_c02'], 50],
    orphan: [['orph_child'], 1],
    tworoots: [['two_r2c', 'two_r1c'], 2]
  },
  hop_fanout_union_spss: { fanout: [['fan_c00', 'fan_c00_g0', 'fan_c00_g1'], 30] },
  hop_fanout_grandchild_siblings: { fanout: [['fan_c00_g0', 'fan_c00_g1', 'fan_c05_g0'], 20] },
  hop_fanout_siblings_spss_5: { fanout: [['fan_c00', 'fan_c01', 'fan_c02', 'fan_c03', 'fan_c04'], 50] },
  hop_db_parent_any: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  hop_attrs_sibling: { attrs: [['am_str'], 1] },
  hop_attrs_union_parent: { attrs: [['am_str', 'am_root'], 2] },
  hop_edge_siblings: { edge_bound: [['eb_to', 'eb_mid'], 2] },
  hop_edge_out_of_range_parent: {},
  hop_edge_wider_parent: { edge_chain: [['ec_leaf'], 1] },
  hop_edge_late_child: {},
  and_empty_operand: { mixed: [MIXED_EARLIEST, 6], mixed2: [MIXED2_EARLIEST, 6] },
  hop_edge_empty_lhs: { edge_chain: [['ec_leaf'], 1], edge_bound: [['eb_to', 'eb_mid'], 2], edge_late: [['el_a'], 1] },
  tr_descendant_all: TR_DESCENDANT,
  tr_ancestor_all: TR_ANCESTOR,
  tr_not_descendant_all: {
    chain8: [['c8_0'], 1],
    fanout: [['fan_root'], 1],
    mixed: [['mix_root'], 1],
    orphan: [['orph_root', 'orph_o1', 'orph_o2'], 3],
    tworoots: [['two_r1', 'two_r2'], 2],
    rootless: [['rl_a', 'rl_b', 'rl_c'], 3],
    mixed2: [['mix2_root'], 1],
    attrs: [['am_root'], 1],
    edge_chain: [['ec_leaf'], 1],
    edge_bound: [['eb_mid', 'eb_to'], 2],
    edge_late: [['el_a'], 1]
  },
  tr_not_ancestor_all: {
    chain8: [['c8_7'], 1],
    fanout: 60,
    mixed: [['mix_a1', 'mix_a2', 'mix_b1'], 3],
    orphan: [['orph_child', 'orph_o1', 'orph_o2'], 3],
    tworoots: [['two_r1c', 'two_r2c'], 2],
    rootless: [['rl_a', 'rl_b', 'rl_c'], 3],
    mixed2: [['mix2_a1', 'mix2_a2', 'mix2_b1'], 3],
    attrs: 7,
    edge_chain: [['ec_leaf'], 1],
    edge_bound: [['eb_mid', 'eb_to'], 2],
    edge_late: [['el_a'], 1]
  },
  tr_union_descendant_all: TR_UNION,
  tr_union_ancestor_all: TR_UNION,
  tr_chain8_descendants: { chain8: 7 },
  tr_chain8_ancestors: { chain8: [['c8_0', 'c8_1', 'c8_2', 'c8_3', 'c8_4', 'c8_5', 'c8_6'], 7] },
  tr_chain8_union_ancestor: { chain8: [['c8_7', 'c8_3'], 2] },
  tr_chain9_error: oracle.UNRESOLVED,
  tr_chain9_error_shallow_operands: oracle.UNRESOLVED,
  tr_chain9_error_nested: oracle.UNRESOLVED,
  tr_empty_operands_error: oracle.UNRESOLVED,
  tr_chain9_no_candidate: { chain9: 9 },
  tr_chain_path: { chain8: [['c8_6'], 1] },
  tr_chain_group: { chain8: [['c8_2'], 1] },
  tr_mixed_descendant: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  tr_mixed_ancestor_root: { mixed: [['mix_root'], 1], mixed2: [['mix2_root'], 1] },
  tr_mixed_ancestor: { mixed: [['mix_b', 'mix_a'], 2], mixed2: [['mix2_b', 'mix2_a'], 2] },
  tr_mixed_not_descendant: { mixed: [['mix_b1'], 1], mixed2: [['mix2_b1'], 1] },
  tr_mixed_not_ancestor: { mixed: [['mix_b'], 1], mixed2: [['mix2_b'], 1] },
  tr_mixed_union_descendant: { mixed: [['mix_b1', 'mix_b'], 2], mixed2: [['mix2_b1', 'mix2_b'], 2] },
  tr_mixed_union_ancestor: { mixed: [['mix_a2', 'mix_a'], 2], mixed2: [['mix2_a2', 'mix2_a'], 2] },
  tr_mixed_with_child: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  tr_mixed_and: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 3], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  tr_orphan_descendant: { orphan: [['orph_child'], 1] },
  tr_orphan_not_descendant: { orphan: [['orph_o2', 'orph_o1', 'orph_root'], 3] },
  tr_orphan_ancestor: { orphan: [['orph_root'], 1] },
  tr_rootless_descendant: {},
  tr_rootless_not_ancestor: { rootless: [['rl_c', 'rl_b', 'rl_a'], 3] },
  tr_tworoots_descendant: { tworoots: [['two_r2c', 'two_r1c'], 2] },
  tr_fanout_descendant_spss: { fanout: [['fan_c00_g0', 'fan_c00_g1', 'fan_c05_g0'], 20] },
  tr_fanout_ancestor: {
    fanout: [['fan_root', 'fan_c00', 'fan_c05', 'fan_c10', 'fan_c15', 'fan_c20', 'fan_c25', 'fan_c30', 'fan_c35', 'fan_c40', 'fan_c45'], 11]
  },
  tr_fanout_union_descendant: { fanout: [['fan_root', 'fan_c00_g0', 'fan_c00_g1'], 21] },
  tr_attrs_ancestor: { attrs: [['am_root'], 1] },
  tr_empty_lhs_not_ancestor: { mixed: [MIXED_EARLIEST, 6] },
  tr_edge_out_of_range_ancestors: {},
  tr_edge_wider: { edge_chain: [['ec_leaf', 'ec_mid'], 2], edge_bound: [['eb_to', 'eb_mid', 'eb_from'], 3] },
  tr_edge_not_descendant: { edge_chain: [['ec_leaf'], 1] },
  tr_late_parent_before: {},
  tr_late_parent_before_not: { mixed2: [['mix2_a', 'mix2_b', 'mix2_a1'], 5] },
  tr_late_parent_after: { mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  // Scalar filters. The api spans' descendants below level 0 are a1, a2 and
  // b1; the mixed tree's durations are 120, 80, 60, 30, 5 and 45ms; the
  // attribute matrix's numeric v are 200, -3 and 1.5.
  agg_desc_count: {
    mixed: [MIXED_LEAVES, 3, { 'count()': intAttr(3) }],
    mixed2: [MIXED2_LEAVES, 3, { 'count()': intAttr(3) }]
  },
  agg_desc_count_fails: {},
  agg_bare_count: { fanout: [['fan_root', 'fan_c00', 'fan_c00_g0'], 71, { 'count()': intAttr(71) }] },
  agg_bare_count_eq: {
    chain8: [['c8_0', 'c8_1', 'c8_2'], 8, { 'count()': intAttr(8) }],
    attrs: [ATTRS_EARLIEST, 8, { 'count()': intAttr(8) }]
  },
  agg_chained: { mixed: [MIXED_EARLIEST, 6, { 'count()': intAttr(6), 'avg(duration)': durationAttr('56.666666ms') }] },
  agg_chained_fails: {},
  agg_nil_skipped: { attrs: [ATTRS_EARLIEST, 8, { 'avg(.v)': doubleAttr(198.5 / 3) }] },
  agg_all_nil_dropped: {},
  agg_count_zero: {},
  agg_number_vs_duration: { attrs: [ATTRS_EARLIEST, 8, { 'max(duration)': durationAttr('500ms') }] },
  agg_int_vs_float: { mixed: [MIXED_EARLIEST, 6, { 'count()': intAttr(6) }] },
  agg_sum_float: { attrs: [ATTRS_EARLIEST, 8, { 'sum(.v)': doubleAttr(198.5) }] },
  agg_min_int: { attrs: [ATTRS_EARLIEST, 8, { 'min(.v)': intAttr(-3) }] },
  agg_max_float: { attrs: [['am_int_neg', 'am_float', 'am_str'], 5, { 'max(.v)': doubleAttr(1.5) }] },
  agg_union_descendant_sum: {
    mixed: [['mix_a', 'mix_b', 'mix_a1'], 4, { 'sum(duration)': durationAttr('215ms') }],
    mixed2: [['mix2_a', 'mix2_b', 'mix2_a1'], 4, { 'sum(duration)': durationAttr('215ms') }]
  },
  agg_chain8_depth: { chain8: [['c8_1', 'c8_2', 'c8_3'], 7, { 'max(.depth)': intAttr(7), 'min(.depth)': intAttr(1) }] },
  agg_paren_operand: { mixed: [MIXED_EARLIEST, 6] },
  agg_paren_operand_fails: {},
  agg_unresolved: oracle.UNRESOLVED,
  fe_attr_eq_attr: { attrs: [['am_str', 'am_int'], 2] },
  fe_attr_ne_attr: { attrs: [['am_bool', 'am_int_neg'], 2] },
  fe_attr_lt_attr: { attrs: [['am_int_neg'], 1] },
  fe_arith: { attrs: [['am_int'], 1] },
  fe_precedence_mul: { attrs: [['am_int_neg'], 1] },
  fe_pow: { attrs: [['am_int_neg'], 1] },
  fe_pow_int: { attrs: [['am_int_neg'], 1] },
  fe_int_div: { attrs: [['am_int_neg'], 1] },
  fe_float_div: { attrs: [['am_float'], 1] },
  fe_div_zero: { attrs: [['am_float'], 1] },
  fe_mod_zero_ne: { attrs: [['am_float'], 1] },
  fe_mod: { attrs: [['am_int_neg'], 1] },
  fe_unary_minus: { attrs: [['am_int_neg'], 1] },
  fe_int_float_mul: { attrs: [['am_float'], 1] },
  fe_failed_cast: { attrs: [['am_float', 'am_int'], 2] },
  fe_not_eq: { attrs: [['am_dur', 'am_bool', 'am_str', 'am_float', 'am_int_neg', 'am_missing', 'am_root'], 7] },
  fe_not_ne: { attrs: [['am_dur', 'am_bool', 'am_str', 'am_int', 'am_missing', 'am_root'], 6] },
  fe_not_bool: { attrs: [['am_bool'], 1] },
  fe_not_precedence: { attrs: [['am_bool'], 1] },
  fe_bool_attr: { attrs: [['am_bool'], 1] },
  fe_bool_ne: { attrs: [['am_bool'], 1] },
  fe_nil_absent: { attrs: [['am_missing', 'am_root'], 2] },
  fe_nil_present: { attrs: [['am_bool', 'am_str', 'am_float', 'am_int_neg', 'am_int', 'am_missing'], 6] },
  fe_nil_resource: { attrs: [['am_missing', 'am_root'], 2] },
  fe_nil_or: { attrs: [['am_int_neg', 'am_missing', 'am_root'], 3] },
  fe_sum_ne_nil: { attrs: [['am_int_neg', 'am_int'], 2] },
  fe_duration_number: { attrs: [['am_float', 'am_root'], 2] },
  fe_duration_arith: { attrs: [['am_str', 'am_float', 'am_root'], 3] },
  fe_duration_or: { attrs: [['am_str', 'am_float', 'am_root'], 3] },
  fe_status_and: { mixed: [['mix_b'], 1], mixed2: [['mix2_b'], 1] },
  fe_and_or_level: { attrs: [['am_int_neg'], 1] },
  fe_regex_not: { attrs: [['am_dur', 'am_bool', 'am_str', 'am_missing', 'am_root'], 5] },
  fe_string_order: { attrs: [['am_bool', 'am_str'], 2] },
  fe_literal_left: { attrs: [['am_int'], 1] },
  fe_child: { attrs: [['am_str', 'am_int'], 2] },
  fe_agg_sum_expr: { attrs: [ATTRS_EARLIEST, 8, { 'sum(.v + .w)': intAttr(404) }] },
  fe_agg_avg_div: { attrs: [ATTRS_EARLIEST, 8, { 'avg(.v / 2)': doubleAttr(33.25) }] },
  fe_agg_duration_expr: { attrs: [ATTRS_EARLIEST, 8, { 'max(duration * 2)': durationAttr('1s') }] },
  fe_agg_canonical: { attrs: [ATTRS_EARLIEST, 8, { 'min(.w - (.v * 2))': intAttr(-200) }] },
  fe_agg_all_nil: {},
  // Narrowing. The mixed trees' level-0, level-1 and level-2 spans are root;
  // a and b; a1, a2 and b1. a1 and b1 are db, a2 cache, a and b api.
  nr_stage_intersection: { mixed: [['mix_b1', 'mix_a1'], 2] },
  nr_stage_disjoint: {},
  nr_empty_selector: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  nr_child: { mixed: [['mix_b1', 'mix_b'], 2], mixed2: [['mix2_b1', 'mix2_b'], 2] },
  nr_sibling: { mixed: [['mix_a2', 'mix_a1'], 2], mixed2: [['mix2_a2', 'mix2_a1'], 2] },
  nr_pivot: { attrs: [['am_int'], 1] },
  nr_descendant_through_failed: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  nr_ancestor_through_failed: { mixed: [['mix_root'], 1], mixed2: [['mix2_root'], 1] },
  nr_chain_failed_link: { chain8: [['c8_1', 'c8_2', 'c8_4'], 6] },
  nr_union_descendant: { mixed: [['mix_b1', 'mix_a1', 'mix_root'], 3], mixed2: [['mix2_b1', 'mix2_a1', 'mix2_root'], 3] },
  nr_not_descendant_empty_lhs: { mixed: [MIXED_LEAVES, 3], mixed2: [MIXED2_LEAVES, 3] },
  nr_scalar_then_stage: { mixed: [['mix_b1', 'mix_a1'], 2, { 'count()': intAttr(6) }] },
  nr_stage_then_scalar: {
    mixed: [MIXED_LEAVES, 3, { 'count()': intAttr(6), 'avg(duration)': durationAttr('26.666666ms') }]
  },
  nr_stage_then_scalar_fails: {},
  nr_paren_operand: { mixed: [['mix_b1', 'mix_a1'], 2, { 'count()': intAttr(6) }] },
  nr_paren_stage: { mixed: [MIXED_LEAVES, 3, { 'count()': intAttr(6), 'max(duration)': durationAttr('45ms') }] },
  nr_bare_count_then_stage: { chain8: [['c8_7'], 1, { 'count()': intAttr(8) }] },
  nr_unresolved_full_tree: oracle.UNRESOLVED,
  nr_and: {},
  nr_or: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  // by() and coalesce(). The mixed trees' svc is gateway on root, api on a
  // and b, db on a1 and b1, cache on a2; op is read on a, write on b.
  by_svc: {
    mixed: sets(
      [['mix_b', 'mix_a'], 2, { 'by(.svc)': strAttr('api') }],
      [['mix_a2'], 1, { 'by(.svc)': strAttr('cache') }],
      [['mix_b1', 'mix_a1'], 2, { 'by(.svc)': strAttr('db') }],
      [['mix_root'], 1, { 'by(.svc)': strAttr('gateway') }])
  },
  by_nil_last: {
    mixed: sets(
      [['mix_b1'], 1, { 'by(.db.system)': strAttr('mysql') }],
      [['mix_a1'], 1, { 'by(.db.system)': strAttr('postgres') }],
      [['mix_root', 'mix_a', 'mix_b'], 4, { 'by(.db.system)': NIL }])
  },
  by_attr_order: {
    attrs: sets(
      [['am_int_neg'], 1, { 'by(.v)': strAttr('-3') }],
      [['am_float'], 1, { 'by(.v)': strAttr('1.5') }],
      [['am_int'], 1, { 'by(.v)': strAttr('200') }],
      [['am_dur'], 1, { 'by(.v)': strAttr('5ms') }],
      [['am_str'], 1, { 'by(.v)': strAttr('abc') }],
      [['am_bool'], 1, { 'by(.v)': strAttr('true') }],
      [['am_missing', 'am_root'], 2, { 'by(.v)': NIL }])
  },
  by_typed_number: {
    attrs: sets(
      [['am_missing'], 1, { 'by(.w * 2)': intAttr(2) }],
      [['am_int_neg'], 1, { 'by(.w * 2)': intAttr(14) }],
      [['am_int'], 1, { 'by(.w * 2)': intAttr(400) }],
      [['am_root', 'am_float', 'am_str'], 5, { 'by(.w * 2)': NIL }])
  },
  by_duration: {
    mixed: sets(
      [['mix_a2'], 1, { 'by(duration)': durationAttr('5ms') }],
      [['mix_a1'], 1, { 'by(duration)': durationAttr('30ms') }],
      [['mix_b1'], 1, { 'by(duration)': durationAttr('45ms') }],
      [['mix_b'], 1, { 'by(duration)': durationAttr('60ms') }],
      [['mix_a'], 1, { 'by(duration)': durationAttr('80ms') }],
      [['mix_root'], 1, { 'by(duration)': durationAttr('120ms') }])
  },
  by_bool: {
    mixed: sets(
      [['mix_b', 'mix_a', 'mix_root'], 3, { 'by(.lvl = "2")': boolAttr(false) }],
      [MIXED_LEAVES, 3, { 'by(.lvl = "2")': boolAttr(true) }])
  },
  by_status: {
    mixed: sets([['mix_b'], 1, { 'by(status)': strAttr('error') }], [['mix_root', 'mix_a', 'mix_a1'], 5, { 'by(status)': NIL }])
  },
  by_nested: {
    mixed: sets(
      [['mix_root'], 1, { 'by(.lvl)': strAttr('0'), 'by(.svc)': strAttr('gateway') }],
      [['mix_b', 'mix_a'], 2, { 'by(.lvl)': strAttr('1'), 'by(.svc)': strAttr('api') }],
      [['mix_a2'], 1, { 'by(.lvl)': strAttr('2'), 'by(.svc)': strAttr('cache') }],
      [['mix_b1', 'mix_a1'], 2, { 'by(.lvl)': strAttr('2'), 'by(.svc)': strAttr('db') }])
  },
  by_count: {
    mixed: sets(
      [['mix_b', 'mix_a'], 2, { 'by(.svc)': strAttr('api'), 'count()': intAttr(2) }],
      [['mix_b1', 'mix_a1'], 2, { 'by(.svc)': strAttr('db'), 'count()': intAttr(2) }]),
    mixed2: sets(
      [['mix2_b', 'mix2_a'], 2, { 'by(.svc)': strAttr('api'), 'count()': intAttr(2) }],
      [['mix2_b1', 'mix2_a1'], 2, { 'by(.svc)': strAttr('db'), 'count()': intAttr(2) }])
  },
  by_mid_chain: {
    mixed: [['mix_b', 'mix_a'], 2, { 'by(.svc)': strAttr('api'), 'count()': intAttr(2), 'avg(duration)': durationAttr('70ms') }],
    mixed2: [['mix2_b', 'mix2_a'], 2, { 'by(.svc)': strAttr('api'), 'count()': intAttr(2), 'avg(duration)': durationAttr('70ms') }]
  },
  by_filter: {
    mixed: sets([['mix_a2'], 1, { 'by(.svc)': strAttr('cache') }], [['mix_b1', 'mix_a1'], 2, { 'by(.svc)': strAttr('db') }])
  },
  by_paren_stage: {
    mixed: [['mix_b1', 'mix_a1'], 2, { 'by(.svc)': strAttr('db'), 'count()': intAttr(2) }],
    mixed2: [['mix2_b1', 'mix2_a1'], 2, { 'by(.svc)': strAttr('db'), 'count()': intAttr(2) }]
  },
  by_inside_paren_stage: {
    mixed: sets([['mix_a2'], 1, { 'by(.svc)': strAttr('cache') }], [['mix_b1', 'mix_a1'], 2, { 'by(.svc)': strAttr('db') }]),
    mixed2: sets([['mix2_a2'], 1, { 'by(.svc)': strAttr('cache') }], [['mix2_b1', 'mix2_a1'], 2, { 'by(.svc)': strAttr('db') }])
  },
  by_after_structural: {
    mixed: sets(
      [['mix_a'], 1, { 'by(.op)': strAttr('read') }],
      [['mix_b'], 1, { 'by(.op)': strAttr('write') }],
      [MIXED_LEAVES, 3, { 'by(.op)': NIL }]),
    mixed2: sets(
      [['mix2_a'], 1, { 'by(.op)': strAttr('read') }],
      [['mix2_b'], 1, { 'by(.op)': strAttr('write') }],
      [MIXED2_LEAVES, 3, { 'by(.op)': NIL }])
  },
  // Every trace with more than two in-range spans is one nil group, except
  // the mixed trees, where only level 2 has three spans.
  by_leading: Object.fromEntries(Object.entries(EARLIEST).filter(([, [, n]]) => n > 2).map(([trace, [listed, n]]) =>
    [trace, trace.startsWith('mixed')
      ? [trace === 'mixed' ? MIXED_LEAVES : MIXED2_LEAVES, 3, { 'by(.lvl)': strAttr('2'), 'count()': intAttr(3) }]
      : [listed, n, { 'by(.lvl)': NIL, 'count()': intAttr(n) }]])),
  by_coalesce: { mixed: [['mix_a', 'mix_b', 'mix_a1'], 4], mixed2: [['mix2_a', 'mix2_b', 'mix2_a1'], 4] },
  by_coalesce_count: {
    mixed: [['mix_a', 'mix_b', 'mix_a1'], 4, { 'count()': intAttr(4) }],
    mixed2: [['mix2_a', 'mix2_b', 'mix2_a1'], 4, { 'count()': intAttr(4) }]
  },
  by_coalesce_operand: { mixed: [MIXED_EARLIEST, 6], mixed2: [MIXED2_EARLIEST, 6] },
  by_grouped_structural: oracle.GROUPED,
  by_grouped_operand: oracle.GROUPED,
  by_coalesce_ungrouped: { mixed: [MIXED_EARLIEST, 6] },
  by_no_span_reference: { error: 'grouping field expressions must reference the span: by(1)' },
  by_spss: {
    fanout: sets(
      [['fan_c00', 'fan_c01'], 50, { 'by(.role)': strAttr('child') }],
      [['fan_c00_g0', 'fan_c00_g1'], 20, { 'by(.role)': strAttr('grandchild') }],
      [['fan_root'], 1, { 'by(.role)': strAttr('root') }])
  },
  by_limit: {
    mixed2: sets(
      [['mix2_b', 'mix2_a'], 2, { 'by(.svc)': strAttr('api') }],
      [['mix2_a2'], 1, { 'by(.svc)': strAttr('cache') }],
      [['mix2_b1', 'mix2_a1'], 2, { 'by(.svc)': strAttr('db') }])
  },
  sel_attrs: {
    mixed: [MIXED_EARLIEST, 6, {}, { mix_root: { svc: 'gateway', lvl: '0' }, mix_a: { svc: 'api', op: 'read', lvl: '1' }, mix_b: { svc: 'api', op: 'write', lvl: '1' } }]
  },
  sel_intrinsics: {
    mixed: [['mix_b', 'mix_a'], 2, {}, { mix_b: { '#name': 'mix_b', status: 'error' }, mix_a: { '#name': 'mix_a' } }],
    mixed2: [['mix2_b', 'mix2_a'], 2, {}, { mix2_b: { '#name': 'mix2_b', status: 'error' }, mix2_a: { '#name': 'mix2_a' } }]
  },
  sel_leading: {
    fanout: [['fan_c00_g0', 'fan_c00_g1', 'fan_c05_g0'], 20, {}, { fan_c00_g0: { idx: '0' }, fan_c00_g1: { idx: '0' }, fan_c05_g0: { idx: '5' } }]
  },
  sel_missing: {
    attrs: [['am_dur', 'am_bool', 'am_str', 'am_float', 'am_int_neg', 'am_int', 'am_missing', 'am_root'], 8, {}, {
      am_dur: { v: '5ms' }, am_bool: { v: 'true' }, am_str: { v: 'abc' }, am_float: { v: '1.5' }, am_int_neg: { v: '-3' }, am_int: { v: '200' }
    }]
  },
  sel_nested: {
    mixed: [[...MIXED_LEAVES, 'mix_root'], 4, {}, { mix_b1: { 'db.system': 'mysql' }, mix_a1: { 'db.system': 'postgres' }, mix_root: { 'http.method': 'GET' } }],
    mixed2: [[...MIXED2_LEAVES, 'mix2_root'], 4, {}, { mix2_b1: { 'db.system': 'mysql' }, mix2_a1: { 'db.system': 'postgres' }, mix2_root: { 'http.method': 'GET' } }]
  },
  sel_by: {
    mixed: sets(
      [['mix_root'], 1, { 'by(.lvl)': strAttr('0') }, { mix_root: { svc: 'gateway' } }],
      [['mix_b', 'mix_a'], 2, { 'by(.lvl)': strAttr('1') }, { mix_b: { svc: 'api' }, mix_a: { svc: 'api' } }],
      [MIXED_LEAVES, 3, { 'by(.lvl)': strAttr('2') }, { mix_b1: { svc: 'db' }, mix_a2: { svc: 'cache' }, mix_a1: { svc: 'db' } }])
  },
  sel_ns_left: {
    tworoots: [TWO_NEWEST, 4, {}, { two_r2c: { nestedSetLeft: intAttr(6) }, two_r1c: { nestedSetLeft: intAttr(2) }, two_r2: { nestedSetLeft: intAttr(5) }, two_r1: { nestedSetLeft: intAttr(1) } }]
  },
  sel_ns_right: {
    tworoots: [TWO_NEWEST, 4, {}, { two_r2c: { nestedSetRight: intAttr(7) }, two_r1c: { nestedSetRight: intAttr(3) }, two_r2: { nestedSetRight: intAttr(8) }, two_r1: { nestedSetRight: intAttr(4) } }]
  },
  sel_ns_parent: {
    tworoots: [TWO_NEWEST, 4, {}, { two_r2c: { nestedSetParent: intAttr(5) }, two_r1c: { nestedSetParent: intAttr(1) }, two_r2: { nestedSetParent: intAttr(-1) }, two_r1: { nestedSetParent: intAttr(-1) } }]
  },
  sel_ns_all: {
    orphan: [['orph_o2', 'orph_o1', 'orph_child', 'orph_root'], 4, {}, {
      orph_o2: ns(0, 0, 0), orph_o1: ns(0, 0, 0), orph_child: ns(2, 3, 1), orph_root: ns(1, 4, -1)
    }]
  },
  sel_ns_attrs: {
    mixed: [['mix_b1', 'mix_a2', 'mix_a1', 'mix_b', 'mix_a', 'mix_root'], 6, {}, {
      mix_b1: { svc: 'db', nestedSetLeft: intAttr(9), nestedSetRight: intAttr(10) },
      mix_a2: { svc: 'cache', nestedSetLeft: intAttr(5), nestedSetRight: intAttr(6) },
      mix_a1: { svc: 'db', nestedSetLeft: intAttr(3), nestedSetRight: intAttr(4) },
      mix_b: { svc: 'api', nestedSetLeft: intAttr(8), nestedSetRight: intAttr(11) },
      mix_a: { svc: 'api', nestedSetLeft: intAttr(2), nestedSetRight: intAttr(7) },
      mix_root: { svc: 'gateway', nestedSetLeft: intAttr(1), nestedSetRight: intAttr(12) }
    }]
  },
  sel_ns_mid_pipeline: {
    tworoots: [TWO_NEWEST, 4, { 'count()': intAttr(4) }, {
      two_r2c: { '#name': 'two_r2c', nestedSetParent: intAttr(5) },
      two_r1c: { '#name': 'two_r1c', nestedSetParent: intAttr(1) },
      two_r2: { '#name': 'two_r2', nestedSetParent: intAttr(-1) },
      two_r1: { '#name': 'two_r1', nestedSetParent: intAttr(-1) }
    }]
  },
  sel_ns_rootless_first_push: {
    mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1', 'mix2_b', 'mix2_a'], 5, {}, {
      mix2_b1: ns(0, 0, 0), mix2_a2: ns(0, 0, 0), mix2_a1: ns(0, 0, 0), mix2_b: ns(0, 0, 0), mix2_a: ns(0, 0, 0)
    }]
  },
  // Nested-set filters on the mixed tree: root 1/12/-1, a 2/7/1, a1 3/4/2,
  // a2 5/6/2, b 8/11/1, b1 9/10/8.
  ns_f_left_eq: { mixed: [['mix_a'], 1] },
  ns_f_left_ne: { mixed: [['mix_a', 'mix_b', ...MIXED_LEAVES], 5] },
  ns_f_left_gt: { mixed: [['mix_b', 'mix_b1'], 2] },
  ns_f_left_ge: { mixed: [['mix_b', 'mix_b1'], 2] },
  ns_f_left_lt: { mixed: [['mix_root', 'mix_a'], 2] },
  ns_f_left_le: { mixed: [['mix_root', 'mix_a', 'mix_a1'], 3] },
  ns_f_right_eq: { mixed: [['mix_root'], 1] },
  ns_f_right_ne: { mixed: [['mix_a', 'mix_b', ...MIXED_LEAVES], 5] },
  ns_f_right_gt: { mixed: [['mix_root', 'mix_b'], 2] },
  ns_f_right_ge: { mixed: [['mix_root', 'mix_b', 'mix_b1'], 3] },
  ns_f_right_lt: { mixed: [['mix_a1'], 1] },
  ns_f_right_le: { mixed: [['mix_a1', 'mix_a2'], 2] },
  ns_f_parent_eq: { mixed: [['mix_a', 'mix_b'], 2] },
  ns_f_parent_ne: { mixed: [['mix_a', 'mix_b', ...MIXED_LEAVES], 5] },
  ns_f_parent_gt: { mixed: [MIXED_LEAVES, 3] },
  ns_f_parent_ge: { mixed: [['mix_b1'], 1] },
  ns_f_parent_lt: { mixed: [['mix_root'], 1] },
  ns_f_parent_le: { mixed: [MIXED_EARLIEST, 3] },
  ns_f_parent_eq_root: { mixed: [['mix_root'], 1] },
  ns_f_leaves: { mixed: [MIXED_LEAVES, 3] },
  ns_f_orphan_zero: { orphan: [['orph_o1', 'orph_o2'], 2] },
  ns_f_rootless_not_root: { rootless: [['rl_a', 'rl_b', 'rl_c'], 3] },
  ns_f_rootless_root_filter: {},
  ns_f_root_operand_union_descendant: { mixed: [[...MIXED_EARLIEST, ...MIXED_LEAVES], 6] },
  ns_f_root_operand_descendant: { tworoots: [['two_r1c', 'two_r2c'], 2] },
  ns_by_parent: {
    tworoots: sets(
      [['two_r1', 'two_r2'], 2, { 'by(nestedSetParent)': intAttr(-1) }],
      [['two_r1c'], 1, { 'by(nestedSetParent)': intAttr(1) }],
      [['two_r2c'], 1, { 'by(nestedSetParent)': intAttr(5) }])
  },
  ns_agg_max_right: { mixed: [MIXED_EARLIEST, 6, { 'max(nestedSetRight)': intAttr(12) }] },
  sel_field_expression: { error: oracle.SELECT_ERROR },
  hints_ignored_by_search: { mixed: [MIXED_EARLIEST, 6] },
  echo_union_structural: {
    mixed: [['mix_b'], 1, {}, { mix_b: { svc: 'api', op: 'write' } }],
    mixed2: [['mix2_b'], 1, {}, { mix2_b: { svc: 'api', op: 'write' } }]
  },
  echo_intrinsics: { mixed: [['mix_a', 'mix_b'], 2, {}, { mix_a: { '#name': 'mix_a' }, mix_b: { '#name': 'mix_b', status: 'error' } }] },
  echo_ns_root_filter: {
    tworoots: [['two_r1', 'two_r2'], 2, {}, {
      two_r1: { nestedSetParent: intAttr(-1), shape: 'tworoots' },
      two_r2: { nestedSetParent: intAttr(-1), shape: 'tworoots' }
    }]
  },
  echo_ns_unnumbered: {
    orphan: [['orph_o1', 'orph_o2'], 2, {}, {
      orph_o1: { nestedSetLeft: intAttr(0), nestedSetRight: intAttr(0), shape: 'orphan' },
      orph_o2: { nestedSetLeft: intAttr(0), nestedSetRight: intAttr(0), shape: 'orphan' }
    }]
  },
  echo_listed_intrinsics: { mixed: [['mix_root'], 1] },
  echo_after_stage: { mixed: [['mix_b'], 1, { 'count()': intAttr(6) }, { mix_b: { shape: 'mixed', op: 'write' } }] }
}

// ECHO_CHECKED are the cases whose hand-checked selected values include the
// echoed filter keys; the other cases' hand-checks list select() values only.
const ECHO_CHECKED = ['echo_union_structural', 'echo_intrinsics', 'echo_ns_root_filter', 'echo_ns_unnumbered',
  'echo_listed_intrinsics', 'echo_after_stage']

// stripEcho drops the echoed filter keys that select() does not read from a
// search result, unless the case's hand-check lists them.
const stripEcho = (run, got) => {
  if (got.error || ECHO_CHECKED.includes(run.id)) return got
  const selected = new Set(oracle.selectKeys(run.ast.pipeline))
  const echoed = oracle.filterKeys(run.ast.pipeline).filter(k => !selected.has(k))
  const strip = (set) => ({
    ...set,
    selected: Object.fromEntries(Object.entries(set.selected)
      .map(([span, v]) => [span, Object.fromEntries(Object.entries(v).filter(([k]) => !echoed.includes(k)))])
      .filter(([, v]) => Object.keys(v).length))
  })
  return got.map(t => ({ ...strip(t), spanSets: t.spanSets.map(strip) }))
}

// namesEarliestFirst orders seed span names by start time, then span id.
const namesEarliestFirst = (names) => names.map(n => spans.find(s => s.name === n)).sort(oracle.earliestFirst).map(s => s.name)

describe('traceql oracle on hand-checked results', () => {
  const all = runs(FROM)
  it('has a hand-checked result for exactly the cases in cases.json', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(all.map(r => r.id).sort())
  })
  for (const run of all) {
    it(run.name, () => {
      const got = stripEcho(run, oracle.search(run.ast, spans, run))
      if (EXPECTED[run.id] && EXPECTED[run.id].error) return expect(got).toEqual(EXPECTED[run.id])
      const spss = run.spss || oracle.DEFAULT_SPSS
      const spanset = (e) => ({ spans: namesEarliestFirst(e[0]), matched: e[1], attributes: e[2] || {}, selected: e[3] || {} })
      const want = Object.entries(EXPECTED[run.id] || {}).map(([trace, e]) => {
        if (typeof e === 'number') {
          return { trace, spans: got.find(t => t.trace === trace)?.spans || [], matched: e, attributes: {}, selected: {}, spssCheck: Math.min(spss, e) }
        }
        if (e.sets) return { trace, ...spanset(e.sets[0]), spanSets: e.sets.map(spanset) }
        return { trace, ...spanset(e) }
      })
      for (const w of want.filter(w => w.spssCheck !== undefined)) expect(w.spans).toHaveLength(w.spssCheck)
      expect(diff(got, want)).toEqual([])
      for (const set of got.flatMap(t => t.spanSets)) {
        const order = set.spans.map(n => spans.find(s => s.name === n).start)
        expect(order).toEqual([...order].sort((a, b) => a - b))
      }
    })
  }
})

describe('traceql oracle rules', () => {
  const sel = (selector) => ({ pipeline: [{ selector }] })
  const named = (name) => ({ op: '=', lhs: { attr: 'name' }, rhs: { str: name } })
  const opts = { from: FROM, to: FROM + seed.WINDOW, limit: 100 }

  it('breaks start-time ties by span id ascending and trace id descending', () => {
    const tied = spans.map(s => ({ ...s, start: FROM + 1000 }))
    const got = oracle.search(sel(null), tied, { ...opts, limit: 1, spss: 2 })
    const lastTrace = [...new Set(spans.map(s => s.traceId))].sort().pop()
    expect(got[0].traceId).toEqual(lastTrace)
    const ids = tied.filter(s => s.traceId === lastTrace).map(s => s.spanId).sort()
    expect(got[0].spans).toEqual(ids.slice(0, 2).map(id => tied.find(s => s.spanId === id).name))
  })

  it('echoes the union of the filter keys, apart from select() and the listed intrinsics', () => {
    const q = (text) => runs(FROM).find(r => r.query === text)
    const keys = (r) => [oracle.selectKeys(r.ast.pipeline), oracle.filterKeys(r.ast.pipeline)]
    expect(keys(q('{ .svc = "gateway" } > { .op = "write" }'))).toEqual([[], ['svc', 'op']])
    expect(keys(q('{ status = error } && { name = "mix_a" }'))).toEqual([[], ['status', '#name']])
    expect(keys(q('{ .shape = "orphan" && nestedSetLeft = 0 } | select(nestedSetRight)'))).toEqual([['nestedSetRight'], ['shape', 'nestedSetLeft']])
    expect(keys(q('{ duration > 100ms && rootServiceName = "grid-mixed" }'))).toEqual([[], []])
    expect(keys(q('{ .shape = "mixed" } | count() > 5 | { .op = "write" }'))).toEqual([[], ['shape', 'op']])
  })
  it('rejects what it cannot evaluate', () => {
    expect(() => oracle.search({ pipeline: [{ spansetOp: '>>>', lhs: sel(null).pipeline[0], rhs: sel(null).pipeline[0] }] }, spans, opts)).toThrow(/unsupported/)
    expect(() => oracle.search(sel({ op: '=', lhs: { attr: 'foo' }, rhs: { str: 'x' } }), spans, opts)).toThrow(/attribute/)
    expect(oracle.search(sel(named('nope')), spans, opts)).toEqual([])
  })

  it('resolves ancestry up to 2^rounds spans deep', () => {
    const chain = (n) => ({ op: '=', lhs: { attr: '.chain' }, rhs: { str: String(n) } })
    const desc = (n) => ({ pipeline: [{ spansetOp: '>>', lhs: { selector: chain(n) }, rhs: { selector: chain(n) } }] })
    expect(oracle.ROUNDS).toEqual(3)
    expect(oracle.search(desc(8), spans, opts)).toHaveLength(1)
    expect(oracle.search(desc(9), spans, opts)).toEqual(oracle.UNRESOLVED)
    expect(oracle.search(desc(9), spans, { ...opts, rounds: 4 })[0].matched).toEqual(8)
    expect(oracle.search(desc(8), spans, { ...opts, rounds: 2 })).toEqual(oracle.UNRESOLVED)
  })

  it('treats a parent cycle as unresolved', () => {
    const cyclic = spans.map(s => s.name === 'mix_root' ? { ...s, parentId: spans.find(p => p.name === 'mix_a1').spanId } : s)
    const q = { pipeline: [{ spansetOp: '<<', lhs: sel(named('mix_a1')).pipeline[0], rhs: sel(named('mix_a')).pipeline[0] }] }
    expect(oracle.search(q, spans, opts)).toHaveLength(1)
    expect(oracle.search(q, cyclic, opts)).toEqual(oracle.UNRESOLVED)
  })

  it('evaluates only the landed pushes', () => {
    const root = { pipeline: [{ selector: named('mix2_root') }] }
    expect(oracle.search(root, spans, opts)).toHaveLength(1)
    expect(oracle.search(root, spans, { ...opts, pushes: 1 })).toEqual([])
  })

  it('parses durations', () => {
    expect(oracle.durationNs('1.5ms')).toEqual(1.5e6)
    expect(oracle.durationNs('2s')).toEqual(2e9)
    expect(() => oracle.durationNs('5')).toThrow()
  })

  it('formats durations like Go', () => {
    expect([0, 999, 1000, 500225, 56666666, 2e6, 1.5e9, 61e9, 3600e9, 3723.5e9].map(oracle.goDuration))
      .toEqual(['0s', '999ns', '1\u00b5s', '500.225\u00b5s', '56.666666ms', '2ms', '1.5s', '1m1s', '1h0m0s', '1h2m3.5s'])
  })

  it('evaluates scalar filters per spanset, skipping values that are not numbers', () => {
    const avg = (op, rhs) => ({
      pipeline: [sel({ op: '=', lhs: { attr: '.shape' }, rhs: { str: 'attrs' } }).pipeline[0],
        { scalarFilter: { op, lhs: { agg: 'avg', attr: '.v' }, rhs } }]
    })
    expect(oracle.search(avg('>', { num: 66 }), spans, opts).map(t => t.trace)).toEqual(['attrs'])
    expect(oracle.search(avg('>', { num: 67 }), spans, opts)).toEqual([])
    const zero = { pipeline: [sel(null).pipeline[0], { scalarFilter: { op: '<', lhs: { agg: 'count' }, rhs: { num: 1 } } }] }
    expect(oracle.search(zero, spans, opts)).toEqual([])
  })

  it('evaluates field expressions under the nil rule', () => {
    const span = { attrs: { a: '5', s: 'x', t: 'false' }, durationNs: 1e6 }
    const m = (f) => oracle.matches(span, f)
    const missing = { attr: '.missing' }
    expect(m({ op: '!=', lhs: missing, rhs: { num: 1 } })).toBe(false)
    expect(m({ op: '!~', lhs: missing, rhs: { str: 'y' } })).toBe(false)
    expect(m({ unary: '!', expr: { paren: { op: '=', lhs: missing, rhs: { num: 1 } } } })).toBe(true)
    expect(m({ unary: '!', expr: { attr: '.s' } })).toBe(false)
    expect(m({ unary: '!', expr: { attr: '.t' } })).toBe(true)
    expect(m({ op: '=', lhs: { op: '/', lhs: { attr: '.a' }, rhs: { num: 0 } }, rhs: { nil: true } })).toBe(true)
    expect(m({ op: '=', lhs: { op: '+', lhs: missing, rhs: { num: 1 } }, rhs: { nil: true } })).toBe(true)
    expect(m({ op: '!=', lhs: { attr: '.a' }, rhs: { attr: '.s' } })).toBe(false)
    expect(m({ op: '=', lhs: { attr: '.a' }, rhs: { str: '5' } })).toBe(true)
    expect(m({ op: '=', lhs: { attr: '.s' }, rhs: { num: 5 } })).toBe(false)
    expect(m({ op: '>', lhs: { attr: 'duration' }, rhs: { num: 999999 } })).toBe(true)
  })

  it('rejects a literal on the left of a scalar filter', () => {
    const flipped = { scalarFilter: { op: '<', lhs: { num: 1 }, rhs: { agg: 'count' } } }
    expect(() => oracle.search({ pipeline: [sel(null).pipeline[0], flipped] }, spans, opts)).toThrow(/aggregate/)
  })
})

describe('traceql result diff', () => {
  const t = (trace, spans, matched) => ({ trace, spans, matched })
  it('reads select() values from the listed spans and compares them', () => {
    const set = {
      matched: 2,
      spans: [
        { spanID: 's1', name: 'root', attributes: [{ key: 'a', value: { stringValue: '1' } }] },
        { spanID: 's2', attributes: [] }
      ]
    }
    const body = { traces: [{ traceID: 't1', spanSet: set, spanSets: [set] }] }
    const [got] = fromApi(body, { trace: { t1: 'tr' }, span: { s1: 'x', s2: 'y' } })
    expect(got.selected).toEqual({ x: { a: '1', '#name': 'root' } })
    const want = { trace: 'tr', spans: ['x', 'y'], matched: 2, selected: { x: { '#name': 'root', a: '1' } } }
    expect(diff([{ ...got, spanSets: undefined }], [want])).toEqual([])
    expect(diff([{ ...got, spanSets: undefined }], [{ ...want, selected: { x: { a: '2' } } }]))
      .toEqual(['tr selected [["x",[["#name","root"],["a","1"]]]], want [["x",[["a","2"]]]]'])
  })
  it('keeps a selected int value typed, so a string never matches it', () => {
    const set = (value) => ({ matched: 1, spans: [{ spanID: 's1', attributes: [{ key: 'nestedSetLeft', value }] }] })
    const read = (value) => fromApi({ traces: [{ traceID: 't1', spanSet: set(value), spanSets: [set(value)] }] },
      { trace: { t1: 'tr' }, span: { s1: 'x' } })[0].selected
    expect(read({ intValue: '3' })).toEqual({ x: { nestedSetLeft: { intValue: '3' } } })
    expect(read({ stringValue: '3' })).toEqual({ x: { nestedSetLeft: '3' } })
  })
  it('matches regardless of trace order, comparing listed spans in order', () => {
    expect(diff([t('b', ['x', 'y'], 2), t('a', ['z'], 1)], [t('a', ['z'], 1), t('b', ['x', 'y'], 2)])).toEqual([])
    expect(diff([t('b', ['y', 'x'], 2)], [t('b', ['x', 'y'], 2)])).toEqual(['b spans y,x, want x,y'])
  })
  it('reports extra, missing, span and matched mismatches', () => {
    expect(diff([t('a', ['x'], 1), t('c', ['w'], 1)], [t('a', ['y'], 2), t('b', ['z'], 1)])).toEqual([
      'a spans x, want y',
      'a matched 1, want 2',
      'b missing: want z matched 1',
      'c extra: w matched 1'
    ])
  })
  it('expects the unresolved-ancestry error', () => {
    const err = { status: 500, error: 'TraceQL structural query: a trace is deeper than the round limit of 3 rounds (8 spans) or its parent links form a cycle; raise GIGAPIPE_TRACEQL_ANCESTRY_ROUNDS' }
    expect(diff(err, oracle.UNRESOLVED)).toEqual([])
    expect(diff({ status: 500, error: 'boom' }, oracle.UNRESOLVED)).toEqual(['error 500: boom, want an unresolved-ancestry error'])
    expect(diff([t('a', ['x'], 1)], oracle.UNRESOLVED)).toEqual(['want an unresolved-ancestry error, got 1 traces'])
    expect(diff(err, [])).toEqual([`unexpected error 500: ${err.error}`])
  })
  it('compares attributes in order, doubles within rounding', () => {
    const a = (trace, attributes) => ({ ...t(trace, ['x'], 1), attributes })
    const want = [a('a', { 'count()': { intValue: '3' }, 'avg(.v)': { doubleValue: 0.1 + 0.2 } })]
    expect(diff([a('a', { 'count()': { intValue: '3' }, 'avg(.v)': { doubleValue: 0.3 } })], want)).toEqual([])
    expect(diff([a('a', { 'avg(.v)': { doubleValue: 0.3 }, 'count()': { intValue: '3' } })], want)).toHaveLength(1)
    expect(diff([a('a', { 'count()': { doubleValue: 3 }, 'avg(.v)': { doubleValue: 0.3 } })], want)).toHaveLength(1)
    expect(diff([a('a', {})], [a('a', {})])).toEqual([])
    expect(diff([a('a', { 'count()': { intValue: '3' } })], [a('a', {})]))
      .toEqual(['a attributes {"count()":{"intValue":"3"}}, want {}'])
  })
  it('reports a spanSet that differs from spanSets[0] and extra spansets', () => {
    const got = [{ ...t('a', ['x'], 1), spanSets: [t(undefined, ['x'], 1), t(undefined, ['y'], 1)], spanSetMatchesFirst: false }]
    expect(diff(got, [t('a', ['x'], 1)])).toEqual(['a has 2 spanSets, want 1', 'a spanSet differs from spanSets[0]'])
  })
  it('compares every spanset in order', () => {
    const set = (spans, matched) => ({ spans, matched, attributes: {} })
    const want = [{ ...t('a', ['x'], 1), spanSets: [set(['x'], 1), set(['y'], 2)] }]
    expect(diff([{ ...t('a', ['x'], 1), spanSets: [set(['x'], 1), set(['y'], 2)] }], want)).toEqual([])
    expect(diff([{ ...t('a', ['x'], 1), spanSets: [set(['x'], 1), set(['z'], 2)] }], want)).toEqual(['a spanSets[1] spans z, want y'])
    expect(diff([{ ...t('a', ['x'], 1), spanSets: [set(['x'], 1)] }], want)).toEqual(['a has 1 spanSets, want 2'])
  })
  it('expects an error by its text', () => {
    const err = { status: 400, error: `bad query: ${oracle.GROUPED.error}` }
    expect(diff(err, oracle.GROUPED)).toEqual([])
    expect(diff({ status: 400, error: 'boom' }, oracle.GROUPED))
      .toEqual([`error 400: boom, want the error "${oracle.GROUPED.error}"`])
    expect(diff(err, oracle.UNRESOLVED)).toEqual([`error 400: ${err.error}, want an unresolved-ancestry error`])
  })
})

// Hand-checked metrics results: range series by label key -> {minute after
// FROM: value}, or {second after FROM: value} for a step under a minute;
// instant and compare() series by label key -> value; or an error result. The
// mixed and mixed2 trees start in minute 2.
const COUNT = 'count_over_time'
const count = (byTime) => ({ [`__name__=${COUNT}`]: byTime })
// FANOUT_BY_10S counts the fanout spans per 10s bucket, by seconds after FROM.
const FANOUT_BY_10S = count({ 20: 2, 30: 7, 40: 7, 50: 6, 60: 7, 70: 7, 80: 6, 90: 7, 100: 7, 110: 6, 120: 7, 130: 2 })
// DESC_SPANS counts the result spans of `{ .svc = "gateway" } >> { .lvl > 0 }`:
// a, b, a1, a2 and b1 of both trees.
const DESC_SPANS = 10
const EXPECTED_METRICS = {
  m_mixed_child: count({ 2: 3 }),
  m_mixed_parent: count({ 2: 1 }),
  m_mixed_sibling: count({ 2: 2 }),
  m_mixed_not_child: count({ 2: 3 }),
  m_mixed_not_parent: count({ 2: 5 }),
  m_mixed_not_sibling: count({ 2: 4 }),
  m_mixed_union_child: count({ 2: 5 }),
  m_mixed_union_parent: count({ 2: 3 }),
  m_mixed_union_sibling: count({ 2: 2 }),
  m_mixed_descendant: count({ 2: 3 }),
  m_mixed_ancestor: count({ 2: 1 }),
  m_mixed_not_descendant: count({ 2: 3 }),
  m_mixed_not_ancestor: count({ 2: 5 }),
  m_mixed_union_descendant: count({ 2: 5 }),
  m_mixed_union_ancestor: count({ 2: 3 }),
  m_fn_rate: { '__name__=rate': { 2: DESC_SPANS / 60 } },
  m_fn_count_over_time: count({ 2: DESC_SPANS }),
  m_fn_avg_over_time: { '__name__=avg_over_time': { 2: 0.044 } },
  m_fn_min_over_time: { '__name__=min_over_time': { 2: 0.005 } },
  m_fn_max_over_time: { '__name__=max_over_time': { 2: 0.08 } },
  m_fn_sum_over_time: { '__name__=sum_over_time': { 2: 0.44 } },
  m_fn_quantile_over_time: { 'p=0.9': { 2: 0.08 } },
  m_fn_histogram_over_time: {
    '__bucket=0.134217728': { 2: 2 },
    '__bucket=0.067108864': { 2: 4 },
    '__bucket=0.033554432': { 2: 2 },
    '__bucket=0.008388608': { 2: 2 }
  },
  m_fn_by: {
    'resource.service.name=grid-mixed,span.svc=api': { 2: 2 },
    'resource.service.name=grid-mixed,span.svc=db': { 2: 2 },
    'resource.service.name=grid-mixed,span.svc=cache': { 2: 1 },
    'resource.service.name=grid-mixed2,span.svc=api': { 2: 2 },
    'resource.service.name=grid-mixed2,span.svc=db': { 2: 2 },
    'resource.service.name=grid-mixed2,span.svc=cache': { 2: 1 }
  },
  m_fn_rate_instant: { '': DESC_SPANS / 1800 },
  m_fn_by_instant: { 'span.svc=api': 4, 'span.svc=db': 4, 'span.svc=cache': 2 },
  m_or: count({ 2: 6 }),
  m_and: count({ 2: 4 }),
  m_boundary: count({ 3: 1, 30: 1 }),
  m_boundary_sibling: count({ 3: 1, 30: 1 }),
  m_uncapped: count({ 0: 21, 1: 40, 2: 9 }),
  m_unresolved: oracle.UNRESOLVED,
  m_agg_gate: count({ 2: 6 }),
  m_agg_gate_fails: {},
  m_agg_bare: count({ 0: 22, 1: 40, 2: 9 }),
  m_fe_attr_eq_attr: count({ 2: 2 }),
  m_fe_not: count({ 2: 7 }),
  m_nr_descendant: count({ 2: 4 }),
  m_nr_sibling: count({ 2: 4 }),
  m_nr_stage: count({ 2: 2 }),
  // a, b, a1 and b1 of both trees; groups are no series dimension.
  m_by_flatten: count({ 2: 8 }),
  m_by_labels: { 'span.lvl=1': { 2: 4 }, 'span.lvl=2': { 2: 6 } },
  m_by_grouped_error: oracle.GROUPED,
  m_select: count({ 2: 6 }),
  // The fanout spans whose span id hashes below 2^63: 31 of 71.
  m_sample_span: count({ 0: 11, 1: 17, 2: 3 }),
  // Traces whose id hashes below 2^63: chain8, mixed, rootless, mixed2,
  // attrs and edge_late. Children of mixed (5), mixed2 (5) and attrs (7);
  // rootless reaches no root and el_b starts out of range.
  m_sample_one_hop: count({ 2: 17 }),
  // mixed (6), mixed2 (6) and attrs (8); rootless (3) and edge_late (1) fail.
  m_sample_agg: count({ 2: 20 }),
  m_sample_ignored: count({ 2: 6 }),
  m_exemplars_n: FANOUT_BY_10S,
  m_exemplars_false: FANOUT_BY_10S,
  m_exemplars_by: {
    'span.role=root': { 20: 1 },
    'span.role=child': { 20: 1, 30: 5, 40: 5, 50: 4, 60: 5, 70: 5, 80: 4, 90: 5, 100: 5, 110: 4, 120: 5, 130: 2 },
    'span.role=grandchild': { 30: 2, 40: 2, 50: 2, 60: 2, 70: 2, 80: 2, 90: 2, 100: 2, 110: 2, 120: 2 }
  },
  // Root and children last 26 and 19ms, grandchildren 40ms.
  m_exemplars_histogram: {
    '__bucket=0.033554432': { 20: 2, 30: 5, 40: 5, 50: 4, 60: 5, 70: 5, 80: 4, 90: 5, 100: 5, 110: 4, 120: 5, 130: 2 },
    '__bucket=0.067108864': { 30: 2, 40: 2, 50: 2, 60: 2, 70: 2, 80: 2, 90: 2, 100: 2, 110: 2, 120: 2 }
  },
  m_exemplars_sampled: count({ 20: 2, 30: 5, 40: 2, 50: 2, 60: 2, 70: 4, 80: 3, 90: 3, 100: 2, 110: 3, 120: 3 }),
  // The mixed tree's left values; its right values average 50/6.
  m_ns_by_left: Object.fromEntries([1, 2, 3, 5, 8, 9].map(n => [`nestedSetLeft=int ${n}`, { 2: 1 }])),
  m_ns_avg_right: { '__name__=avg_over_time': { 2: 50 / 6 } },
  // a1 and b1 of both mixed trees, under a (left 2) and b (left 8).
  m_ns_by_parent_instant: { 'nestedSetParent=int 2': 2, 'nestedSetParent=int 8': 2 },
  m_ns_root_filter: count({ 2: 2 })
}

// Hand-checked exemplar buckets, in seconds after FROM, of the cases with an
// exemplars hint: N buckets of a series' K, bucket floor((2i+1)K / 2N).
const EXPECTED_EXEMPLARS = {
  m_exemplars_n: { [`__name__=${COUNT}`]: [40, 80, 120] },
  m_exemplars_false: { [`__name__=${COUNT}`]: [] },
  m_exemplars_by: { 'span.role=root': [20], 'span.role=child': [50, 110], 'span.role=grandchild': [50, 100] },
  m_exemplars_histogram: { '__bucket=0.033554432': [50, 110], '__bucket=0.067108864': [50, 100] },
  m_exemplars_sampled: { [`__name__=${COUNT}`]: [40, 100] }
}

// compare() over the DESC_SPANS spans with selection `.db.system = "postgres"` (mix_a1 and
// mix2_a1): 39 series, of which these.
const COMPARE = {
  total: 39,
  some: {
    '__meta_type=selection,svc=db': 2,
    '__meta_type=baseline,svc=db': 2,
    '__meta_type=baseline,svc=api': 4,
    '__meta_type=selection,db.system=postgres': 2,
    '__meta_type=baseline,db.system=mysql': 2,
    '__meta_type=baseline,lvl=1': 4,
    '__meta_type=selection,lvl=2': 2,
    '__meta_type=selection,name=mix2_a1': 1
  }
}
EXPECTED_METRICS.m_fn_compare = COMPARE
EXPECTED_METRICS.m_fn_compare_instant = COMPARE

describe('traceql metrics oracle on hand-checked results', () => {
  const all = metricsRuns(FROM)
  it('has a hand-checked result for exactly the metrics cases in cases.json', () => {
    expect(Object.keys(EXPECTED_METRICS).sort()).toEqual(all.map(r => r.id).sort())
  })
  for (const run of all) {
    it(run.name, () => {
      const got = metrics(run.ast, spans, run)
      const want = EXPECTED_METRICS[run.id]
      if (want.error) return expect(got).toEqual(want)
      const byKey = Object.fromEntries(got.map(s => [labelKey(s.labels), s]))
      if (run.kind === 'compare') {
        expect(got).toHaveLength(want.total)
        for (const [key, v] of Object.entries(want.some)) expect(byKey[key] && byKey[key].value).toEqual(v)
        return
      }
      expect(Object.keys(byKey).sort()).toEqual(Object.keys(want).sort())
      for (const [key, w] of Object.entries(want)) {
        if (run.kind === 'instant') {
          expect(byKey[key].value).toBeCloseTo(w, 12)
          continue
        }
        const unit = run.step < 60000 ? 1000 : 60000
        const times = Object.fromEntries(Object.entries(byKey[key].samples).map(([ts, v]) => [(ts - FROM) / unit, v]))
        expect(Object.keys(times).sort()).toEqual(Object.keys(w).sort())
        for (const [m, v] of Object.entries(w)) expect(times[m]).toBeCloseTo(v, 12)
        if (EXPECTED_EXEMPLARS[run.id]) {
          expect(byKey[key].exemplarBuckets.map(ts => (ts - FROM) / unit)).toEqual(EXPECTED_EXEMPLARS[run.id][key])
        }
      }
    })
  }
})

describe('traceql metrics oracle rules', () => {
  const desc = require('./cases.json').metrics.find(c => c.id === 'm_fn_count_over_time').ast
  const opts = { from: FROM, to: FROM + seed.WINDOW, step: 60000 }
  it('interpolates quantiles between ranks', () => {
    const q = (p) => metrics({ ...desc, metrics: { fn: 'quantile_over_time', attr: 'duration', q: p } }, spans, opts)[0].samples
    expect(Object.values(q(0.5))[0]).toBeCloseTo(0.045, 12)
    expect(Object.values(q(0.25))[0]).toBeCloseTo(0.03 * 0.75 + 0.03 * 0.25, 12)
    expect(Object.values(q(0))[0]).toBeCloseTo(0.005, 12)
  })
  it('buckets durations by their power-of-2 upper bound', () => {
    expect(histogramBucket({ durationNs: 1024 })).toEqual(1024)
    expect(histogramBucket({ durationNs: 1025 })).toEqual(2048)
    expect(histogramBucket({ durationNs: 0 })).toEqual(0)
  })
  it('keeps every result span with its bucket for the exemplar check', () => {
    const [s] = metrics({ ...desc, metrics: { fn: 'rate' } }, spans, opts)
    expect(Object.values(s.buckets).flat()).toHaveLength(DESC_SPANS)
  })
  it('rejects a compare() top-N cut through a tie', () => {
    const tie = { ...desc, metrics: { fn: 'compare', compare: { filter: null, count: 1 } } }
    expect(() => metrics(tie, spans, opts)).toThrow(/tie/)
  })
  it('returns no instant series for histogram_over_time', () => {
    expect(metrics({ ...desc, metrics: { fn: 'histogram_over_time', attr: 'duration' } }, spans, { ...opts, instant: true })).toEqual([])
  })
})

describe('traceql sample and exemplars hints', () => {
  it('hashes ids like ClickHouse cityHash64', () => {
    // SELECT cityHash64(unhex(id)::FixedString(n)) on ClickHouse 25.3.
    expect(cityHash64('7ace0000000000000000000000000001')).toEqual(15543003041861567031n)
    expect(cityHash64('7ace0000000000000000000000000004')).toEqual(1037906786352058612n)
    expect(cityHash64('0000000100000001')).toEqual(3971008439912734883n)
    expect(cityHash64('0000000100000003')).toEqual(14264788950805794301n)
  })
  it('bounds a sample at fraction·2^64', () => {
    expect(sampleThreshold(0.5)).toEqual(1n << 63n)
    expect(sampleThreshold(0.25)).toEqual(1n << 62n)
  })
  it('reads the first usable sample and exemplars hints', () => {
    expect(sampleFraction([['sample', 'true'], ['sample', '0.5']])).toEqual(0.5)
    expect(sampleFraction([['sample', '1']])).toBeNull()
    expect(sampleFraction([['sample', '0']])).toBeNull()
    expect(sampleFraction(undefined)).toBeNull()
    expect(exemplarLimit([['exemplars', 'true'], ['exemplars', '3']])).toEqual(3)
    expect(exemplarLimit([['exemplars', 'false']])).toEqual(0)
    expect(exemplarLimit([['exemplars', '1.5']])).toBeNull()
  })
  it('thins exemplars evenly', () => {
    const ten = [...Array(10).keys()]
    expect(thin(ten, null)).toEqual(ten)
    expect(thin(ten, 0)).toEqual([])
    expect(thin(ten, 1)).toEqual([5])
    expect(thin(ten, 3)).toEqual([1, 5, 8])
    expect(thin(ten, 12)).toEqual(ten)
  })
})

describe('traceql metrics diff', () => {
  const STEP = 60000
  const want = [{ labels: { __name__: COUNT }, samples: { 120000: 2 }, buckets: { 120000: [{ traceId: 't1', start: 121000 }, { traceId: 't2', start: 122000 }] } }]
  const ex = (trace, ts) => ({ labels: [{ key: 'trace:id', value: { stringValue: trace } }], value: 0, timestampMs: String(ts) })
  const resp = (exemplars, samples = [{ timestampMs: '60000' }, { timestampMs: '120000', value: 2 }]) => ({
    status: 200,
    data: { series: [{ labels: [{ key: '__name__', value: { stringValue: COUNT } }], samples, exemplars }] }
  })
  it('keeps an int label typed, so a string never matches it', () => {
    const inst = (value) => fromMetricsResponse({ status: 200, data: { series: [{ labels: [{ key: 'nestedSetLeft', value }], value: 1 }] } }, 'instant')
    const want = [{ labels: { nestedSetLeft: 'int 3' }, value: 1 }]
    expect(metricsDiff(inst({ intValue: '3' }), want, { kind: 'instant' })).toEqual([])
    expect(metricsDiff(inst({ stringValue: '3' }), want, { kind: 'instant' })).toEqual(['{nestedSetLeft=3} extra', '{nestedSetLeft=int 3} missing'])
  })
  it('matches equal series, ignoring zero samples', () => {
    expect(metricsDiff(fromMetricsResponse(resp([ex('t1', 121000)]), 'range'), want, { kind: 'range', step: STEP })).toEqual([])
  })
  it('wants an exemplar\'s trace and start time from one result span', () => {
    expect(metricsDiff(fromMetricsResponse(resp([ex('t1', 122000)]), 'range'), want, { kind: 'range', step: STEP }))
      .toEqual([`{__name__=${COUNT}} exemplar t1 at 122000 is not a result span of its bucket`])
  })
  it('reports values, series and exemplars that differ', () => {
    const got = fromMetricsResponse(resp([ex('t3', 121000), ex('t1', 125000)], [{ timestampMs: '120000', value: 3 }]), 'range')
    expect(metricsDiff(got, want, { kind: 'range', step: STEP })).toEqual([
      `{__name__=${COUNT}} at +120s: 3, want 2`,
      `{__name__=${COUNT}} has 2 exemplars, want 1`,
      `{__name__=${COUNT}} exemplar t3 at 121000 is not a result span of its bucket`,
      `{__name__=${COUNT}} exemplar t1 at 125000 is not a result span of its bucket`
    ])
    expect(metricsDiff([], want, { kind: 'range', step: STEP })).toEqual([`{__name__=${COUNT}} missing`])
  })
  it('wants exemplars only in the thinned buckets', () => {
    const thinned = [{ ...want[0], samples: { 120000: 2, 180000: 1 }, buckets: { ...want[0].buckets, 180000: [{ traceId: 't3', start: 181000 }] }, exemplarBuckets: [180000] }]
    const got = fromMetricsResponse(resp([ex('t1', 121000)], [{ timestampMs: '120000', value: 2 }, { timestampMs: '180000', value: 1 }]), 'range')
    expect(metricsDiff(got, thinned, { kind: 'range', step: STEP })).toEqual([
      `{__name__=${COUNT}} exemplar at 121000 is in bucket 120000, want one of 180000`
    ])
  })
  it('compares instant and compare() values', () => {
    const inst = fromMetricsResponse({ status: 200, data: { series: [{ labels: [], value: 0.5 }] } }, 'instant')
    expect(metricsDiff(inst, [{ labels: {}, value: 0.5 }], { kind: 'instant' })).toEqual([])
    const cmp = fromMetricsResponse({
      status: 200,
      data: { series: [{ labels: [{ key: '__meta_type', value: { stringValue: 'selection' } }, { key: 'svc', value: { stringValue: 'db' } }], samples: [{ timestampMs: '1', value: 2 }] }] }
    }, 'compare')
    expect(metricsDiff(cmp, [{ labels: { __meta_type: 'selection', svc: 'db' }, value: 3 }], { kind: 'compare' }))
      .toEqual(['{__meta_type=selection,svc=db} value 2, want 3'])
  })
  it('expects the unresolved-ancestry error', () => {
    const err = fromMetricsResponse({ status: 500, data: { error: 'TraceQL structural query: a trace is deeper than the round limit of 3 rounds (8 spans) or its parent links form a cycle; raise GIGAPIPE_TRACEQL_ANCESTRY_ROUNDS' } }, 'range')
    expect(metricsDiff(err, oracle.UNRESOLVED, { kind: 'range' })).toEqual([])
    expect(metricsDiff([], oracle.UNRESOLVED, { kind: 'range' })).toEqual(['want an unresolved-ancestry error, got 0 series'])
  })
})

// Hand-checked autocomplete results: the exact suggestions, or {superset} for
// a query that selects every span, or an error result.
const SEED_KEYS = ['chain', 'db.system', 'depth', 'http.method', 'idx', 'local_endpoint_service_name', 'lvl', 'name', 'op',
  'otel.status_code', 'role', 'service.name', 'shape', 'status', 'suite', 'svc', 'test_id', 'v', 'w']
const SPAN_KEYS = ['local_endpoint_service_name', 'name', 'service.name', 'shape', 'suite', 'test_id']
const SERVICES = ['attrs', 'chain', 'edge', 'fanout', 'mixed', 'mixed2', 'orphan', 'rootless', 'tworoots'].map(s => `grid-${s}`)
const EXPECTED_AUTOCOMPLETE = {
  ac_tags_no_query: { superset: SEED_KEYS },
  ac_values_no_query: { superset: ['api', 'cache', 'db', 'gateway'] },
  ac_tags_empty_selector: { superset: SEED_KEYS },
  ac_values_empty_selector: { superset: SERVICES },
  ac_tags_selector: [...SPAN_KEYS, 'db.system', 'lvl', 'svc'],
  ac_values_selector: ['api', 'cache', 'db', 'gateway'],
  ac_tags_child: [...SPAN_KEYS, 'lvl', 'op', 'otel.status_code', 'status', 'svc'],
  ac_values_child: ['mix2_a', 'mix2_b', 'mix_a', 'mix_b'],
  ac_values_child_pushes: ['mix_a', 'mix_b'],
  ac_values_union_child: ['mix2_a', 'mix2_b', 'mix2_root', 'mix_a', 'mix_b', 'mix_root'],
  ac_values_not_descendant: ['mix_root'],
  ac_values_ancestor: ['mix2_a', 'mix2_b', 'mix2_root'],
  ac_values_sibling: ['eb_mid', 'eb_to'],
  ac_values_or: ['mix2_a2', 'mix2_b1', 'mix_a2', 'mix_b1'],
  ac_tags_or: [...SPAN_KEYS, 'role'],
  ac_values_and: ['orph_o1', 'orph_o2', 'orph_root'],
  ac_values_or_structural: ['mix2_a', 'mix2_b', 'mix_a', 'mix_b', 'rl_a'],
  ac_values_limit: ['fan_c00', 'fan_c00_g0', 'fan_c00_g1'],
  ac_values_range: ['eb_from', 'eb_root', 'ec_mid'],
  ac_tags_unresolved: oracle.UNRESOLVED,
  ac_values_agg: ['mix_a1', 'mix_a2', 'mix_b1'],
  ac_values_field: ['am_int', 'am_str'],
  ac_values_narrowed: ['mix2_a1', 'mix2_a2', 'mix2_b1', 'mix_a1', 'mix_a2', 'mix_b1'],
  ac_tags_narrowed: [...SPAN_KEYS, 'db.system', 'lvl', 'svc'],
  ac_values_by: ['mix2_a', 'mix2_a1', 'mix2_b', 'mix2_b1', 'mix_a', 'mix_a1', 'mix_b', 'mix_b1'],
  ac_tags_ns_root_filter: [...SPAN_KEYS, 'http.method', 'lvl', 'svc'],
  ac_values_ns_left: []
}

describe('traceql autocomplete oracle on hand-checked results', () => {
  const all = autocompleteRuns(FROM)
  it('has a hand-checked result for exactly the autocomplete cases in cases.json', () => {
    expect(Object.keys(EXPECTED_AUTOCOMPLETE).sort()).toEqual(all.map(r => r.id).sort())
  })
  for (const run of all) {
    it(run.name, () => {
      const got = autocomplete(run.ast, spans, run)
      const want = EXPECTED_AUTOCOMPLETE[run.id]
      if (want.error) return expect(got).toEqual(want)
      if (want.superset) return expect(got).toEqual({ values: [...want.superset].sort(), superset: true })
      expect(got).toEqual({ values: [...want].sort(), superset: false })
    })
  }
})

describe('traceql autocomplete oracle rules', () => {
  const opts = { from: FROM, to: FROM + seed.WINDOW }
  const mixed = { op: '=', lhs: { attr: '.shape' }, rhs: { str: 'mixed' } }
  const desc = { pipeline: [{ spansetOp: '>>', lhs: { selector: mixed }, rhs: { selector: null } }] }
  it('reads every span only without a selector or for a lone {}', () => {
    expect(selectsEverySpan({ pipeline: [] })).toBe(true)
    expect(selectsEverySpan({ pipeline: [{ paren: { selector: null } }] })).toBe(true)
    expect(selectsEverySpan(desc)).toBe(false)
  })
  it('suggests the values of a scoped tag and of status', () => {
    expect(autocomplete(desc, spans, { ...opts, tag: 'status' }).values).toEqual(['ERROR'])
    expect(autocomplete(desc, spans, { ...opts, tag: 'resource.service.name' }).values).toContain('grid-mixed')
    expect(autocomplete(desc, spans, { ...opts, tag: '.svc' }).values).toEqual(['api', 'cache', 'db'])
  })
})

describe('traceql autocomplete diff', () => {
  const tags = (scopes) => ({ status: 200, data: { scopes } })
  it('reads the resource and span scopes of tags v2, sorted', () => {
    const resp = tags([{ name: 'resource', tags: ['service.name'] }, { name: 'span', tags: ['b', 'a'] }, { name: 'intrinsic', tags: ['duration'] }])
    expect(fromAutocompleteResponse(resp, true)).toEqual(['a', 'b', 'service.name'])
    expect(fromAutocompleteResponse({ status: 200, data: { tagValues: [{ type: 'string', value: 'y' }, { type: 'string', value: 'x' }] } }, false)).toEqual(['x', 'y'])
  })
  it('reports missing and extra suggestions, extras only when exact', () => {
    expect(autocompleteDiff(['a', 'c'], { values: ['a', 'b'], superset: false })).toEqual(['missing b', 'extra c'])
    expect(autocompleteDiff(['a', 'b', 'c'], { values: ['a', 'b'], superset: true })).toEqual([])
    expect(autocompleteDiff(['a', 'a'], { values: ['a'], superset: false })).toEqual(['duplicate suggestions: a,a'])
  })
  it('expects the unresolved-ancestry error', () => {
    const err = fromAutocompleteResponse({ status: 500, data: { error: 'TraceQL structural query: a trace is deeper than the round limit of 3 rounds (8 spans) or its parent links form a cycle; raise GIGAPIPE_TRACEQL_ANCESTRY_ROUNDS' } }, true)
    expect(autocompleteDiff(err, oracle.UNRESOLVED)).toEqual([])
    expect(autocompleteDiff([], oracle.UNRESOLVED)).toEqual(['want an unresolved-ancestry error, got 0 suggestions'])
  })
})

describe('traceql nested-set oracle', () => {
  // numbers maps span name -> [left, right, parent] for the given pushes.
  const numbers = (trace, pushes) => {
    const landed = pushes === undefined ? spans : spans.filter(s => s.push < pushes)
    const got = oracle.nestedSet(landed)
    return Object.fromEntries(landed.filter(s => s.trace === trace)
      .map(s => { const n = got.get(`${s.traceId}/${s.spanId}`); return [s.name, [n.left, n.right, n.parent]] }))
  }

  it('numbers depth-first with one counter across roots, ties by span id, a duplicate id by its earliest copy', () => {
    expect(numbers('nested')).toEqual({
      ns_r1: [1, 8, -1],
      ns_late: [2, 3, 1],
      ns_a: [4, 5, 1],
      ns_b: [6, 7, 1],
      ns_r2: [9, 16, -1],
      ns_dup: [10, 13, 9],
      ns_dup_early: [10, 13, 9],
      ns_dup_c: [11, 12, 10],
      ns_r2c: [14, 15, 9],
      ns_self: [0, 0, 0],
      ns_cyc1: [0, 0, 0],
      ns_cyc2: [0, 0, 0],
      ns_cyc_c: [0, 0, 0]
    })
  })

  it('renumbers the trace when the late span lands', () => {
    expect(numbers('nested', 2)).toMatchObject({ ns_r1: [1, 6, -1], ns_a: [2, 3, 1], ns_r2: [7, 14, -1], ns_dup: [8, 11, 7] })
    expect(numbers('nested', 2).ns_late).toBeUndefined()
  })

  it('reads 0/0/0 for orphans, root-less traces and a trace whose root has not landed', () => {
    expect(numbers('orphan')).toEqual({ orph_root: [1, 4, -1], orph_child: [2, 3, 1], orph_o1: [0, 0, 0], orph_o2: [0, 0, 0] })
    expect(Object.values(numbers('rootless'))).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0]])
    expect(new Set(Object.values(numbers('mixed2', 1)).map(String))).toEqual(new Set(['0,0,0']))
    expect(numbers('mixed2').mix2_root).toEqual([1, 12, -1])
  })

  it('numbers two roots with one counter', () => {
    expect(numbers('tworoots')).toEqual({ two_r1: [1, 4, -1], two_r1c: [2, 3, 1], two_r2: [5, 8, -1], two_r2c: [6, 7, 5] })
  })

  it('reads selected nested-set values from a search response', () => {
    const span = (spanID, l, r, p) => ({ spanID, attributes: [
      { key: 'nestedSetLeft', value: { intValue: l } }, { key: 'nestedSetParent', value: { intValue: p } },
      { key: 'nestedSetRight', value: { stringValue: r } }] })
    const set = { matched: 2, spans: [span('s1', '1', '4', '-1'), span('s2', '2', '3', '1')] }
    expect(nestedSetRows({ traces: [{ traceID: 't1', spanSet: set, spanSets: [set] }] })).toEqual([
      { traceId: 't1', spanId: 's1', left: '1', right: 'string 4', parent: '-1' },
      { traceId: 't1', spanId: 's2', left: '2', right: 'string 3', parent: '1' }
    ])
  })

  it('diffs stored values against the oracle', () => {
    const two = spans.filter(s => s.trace === 'tworoots')
    const row = (name, left, right, parent) => {
      const { traceId, spanId } = two.find(s => s.name === name)
      return { traceId, spanId, left, right, parent }
    }
    const rows = [row('two_r1', 1, 4, -1), row('two_r1c', 2, 3, 1), row('two_r2', 5, 8, -1), row('two_r2c', 6, 7, 5)]
    expect(nestedSetDiff(rows, two)).toEqual([])
    expect(nestedSetDiff([rows[0], row('two_r1c', 0, 0, 0), rows[2]], two))
      .toEqual(['two_r1c: got 0/0/0, want 2/3/1', 'two_r2c: missing, want 6/7/5'])
  })
})

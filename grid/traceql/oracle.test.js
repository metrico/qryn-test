// TraceQL oracle self-check, run without a gigapipe stack: the seed holds the
// nine fixture shapes, every case's query prints from its AST, and the oracle
// reproduces hand-checked results for every search, metrics and autocomplete
// case.

const seed = require('./seed')
const oracle = require('./oracle')
const { metrics, labelKey, histogramBucket } = require('./metrics')
const { autocomplete, selectsEverySpan } = require('./autocomplete')
const { print } = require('./ast')
const { runs, metricsRuns, autocompleteRuns } = require('./cases')
const { diff, metricsDiff, fromMetricsResponse, fromAutocompleteResponse, autocompleteDiff } = require('./compare')

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
    const ids = [...file.cases, ...file.metrics, ...file.autocomplete].map(c => c.id)
    expect(new Set(ids).size).toEqual(ids.length)
  })
  for (const c of [...file.cases, ...file.metrics, ...file.autocomplete]) {
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

// The three newest spans of the mixed trees and of the attribute matrix.
const MIXED_NEWEST = ['mix_b1', 'mix_a2', 'mix_a1']
const MIXED2_NEWEST = ['mix2_b1', 'mix2_a2', 'mix2_a1']
const ATTRS_NEWEST = ['am_dur', 'am_bool', 'am_str']

// Hand-checked results per case: trace -> [listed spans, matched,
// attributes?], or just matched when the listed spans are the trace's spss
// newest; UNRESOLVED when ancestry does not resolve within the round limit.
// Attributes map a name to its OTLP value and default to none.
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
    fanout: [['fan_c49', 'fan_c48', 'fan_c47'], 50],
    orphan: [['orph_child'], 1],
    tworoots: [['two_r2c', 'two_r1c'], 2],
    rootless: [['rl_c', 'rl_b'], 2]
  },
  hop_rootless_sibling: {},
  hop_roots_siblings: { tworoots: [['two_r2', 'two_r1'], 2] },
  hop_root_children: {
    fanout: [['fan_c49', 'fan_c48', 'fan_c47'], 50],
    orphan: [['orph_child'], 1],
    tworoots: [['two_r2c', 'two_r1c'], 2]
  },
  hop_fanout_union_spss: { fanout: [['fan_c45_g1', 'fan_c45_g0', 'fan_c45'], 30] },
  hop_fanout_grandchild_siblings: { fanout: [['fan_c45_g1', 'fan_c45_g0', 'fan_c40_g1'], 20] },
  hop_fanout_siblings_spss_5: { fanout: [['fan_c49', 'fan_c48', 'fan_c47', 'fan_c46', 'fan_c45'], 50] },
  hop_db_parent_any: { mixed: [['mix_b1', 'mix_a1'], 2], mixed2: [['mix2_b1', 'mix2_a1'], 2] },
  hop_attrs_sibling: { attrs: [['am_str'], 1] },
  hop_attrs_union_parent: { attrs: [['am_str', 'am_root'], 2] },
  hop_edge_siblings: { edge_bound: [['eb_to', 'eb_mid'], 2] },
  hop_edge_out_of_range_parent: {},
  hop_edge_wider_parent: { edge_chain: [['ec_leaf'], 1] },
  hop_edge_late_child: {},
  and_empty_operand: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 6], mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 6] },
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
  tr_fanout_descendant_spss: { fanout: [['fan_c45_g1', 'fan_c45_g0', 'fan_c40_g1'], 20] },
  tr_fanout_ancestor: {
    fanout: [['fan_root', 'fan_c00', 'fan_c05', 'fan_c10', 'fan_c15', 'fan_c20', 'fan_c25', 'fan_c30', 'fan_c35', 'fan_c40', 'fan_c45'], 11]
  },
  tr_fanout_union_descendant: { fanout: [['fan_c45_g1', 'fan_c45_g0', 'fan_c40_g1'], 21] },
  tr_attrs_ancestor: { attrs: [['am_root'], 1] },
  tr_empty_lhs_not_ancestor: { mixed: [['mix_b1', 'mix_a2', 'mix_a1'], 6] },
  tr_edge_out_of_range_ancestors: {},
  tr_edge_wider: { edge_chain: [['ec_leaf', 'ec_mid'], 2], edge_bound: [['eb_to', 'eb_mid', 'eb_from'], 3] },
  tr_edge_not_descendant: { edge_chain: [['ec_leaf'], 1] },
  tr_late_parent_before: {},
  tr_late_parent_before_not: { mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 5] },
  tr_late_parent_after: { mixed2: [['mix2_b1', 'mix2_a2', 'mix2_a1'], 3] },
  // Scalar filters. The api spans' descendants below level 0 are a1, a2 and
  // b1; the mixed tree's durations are 120, 80, 60, 30, 5 and 45ms; the
  // attribute matrix's numeric v are 200, -3 and 1.5.
  agg_desc_count: {
    mixed: [MIXED_NEWEST, 3, { 'count()': intAttr(3) }],
    mixed2: [MIXED2_NEWEST, 3, { 'count()': intAttr(3) }]
  },
  agg_desc_count_fails: {},
  agg_bare_count: { fanout: [['fan_c49', 'fan_c48', 'fan_c47'], 71, { 'count()': intAttr(71) }] },
  agg_bare_count_eq: {
    chain8: [['c8_7', 'c8_6', 'c8_5'], 8, { 'count()': intAttr(8) }],
    attrs: [ATTRS_NEWEST, 8, { 'count()': intAttr(8) }]
  },
  agg_chained: { mixed: [MIXED_NEWEST, 6, { 'count()': intAttr(6), 'avg(duration)': durationAttr('56.666666ms') }] },
  agg_chained_fails: {},
  agg_nil_skipped: { attrs: [ATTRS_NEWEST, 8, { 'avg(.v)': doubleAttr(198.5 / 3) }] },
  agg_all_nil_dropped: {},
  agg_count_zero: {},
  agg_number_vs_duration: { attrs: [ATTRS_NEWEST, 8, { 'max(duration)': durationAttr('500ms') }] },
  agg_int_vs_float: { mixed: [MIXED_NEWEST, 6, { 'count()': intAttr(6) }] },
  agg_sum_float: { attrs: [ATTRS_NEWEST, 8, { 'sum(.v)': doubleAttr(198.5) }] },
  agg_min_int: { attrs: [ATTRS_NEWEST, 8, { 'min(.v)': intAttr(-3) }] },
  agg_max_float: { attrs: [ATTRS_NEWEST, 5, { 'max(.v)': doubleAttr(1.5) }] },
  agg_union_descendant_sum: {
    mixed: [['mix_b1', 'mix_a1', 'mix_b'], 4, { 'sum(duration)': durationAttr('215ms') }],
    mixed2: [['mix2_b1', 'mix2_a1', 'mix2_b'], 4, { 'sum(duration)': durationAttr('215ms') }]
  },
  agg_chain8_depth: { chain8: [['c8_7', 'c8_6', 'c8_5'], 7, { 'max(.depth)': intAttr(7), 'min(.depth)': intAttr(1) }] },
  agg_paren_operand: { mixed: [MIXED_NEWEST, 6] },
  agg_paren_operand_fails: {},
  agg_unresolved: oracle.UNRESOLVED
}

describe('traceql oracle on hand-checked results', () => {
  const all = runs(FROM)
  it('has a hand-checked result for exactly the cases in cases.json', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(all.map(r => r.id).sort())
  })
  for (const run of all) {
    it(run.name, () => {
      const got = oracle.search(run.ast, spans, run)
      if (EXPECTED[run.id] === oracle.UNRESOLVED) return expect(got).toEqual(oracle.UNRESOLVED)
      const spss = run.spss || oracle.DEFAULT_SPSS
      const want = Object.entries(EXPECTED[run.id] || {}).map(([trace, e]) => typeof e === 'number'
        ? { trace, spans: got.find(t => t.trace === trace)?.spans || [], matched: e, attributes: {}, spssCheck: Math.min(spss, e) }
        : { trace, spans: e[0], matched: e[1], attributes: e[2] || {} })
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
    const avg = (op, rhs) => ({ pipeline: [sel({ op: '=', lhs: { attr: '.shape' }, rhs: { str: 'attrs' } }).pipeline[0],
      { scalarFilter: { op, lhs: { agg: 'avg', attr: '.v' }, rhs } }] })
    expect(oracle.search(avg('>', { num: 66 }), spans, opts).map(t => t.trace)).toEqual(['attrs'])
    expect(oracle.search(avg('>', { num: 67 }), spans, opts)).toEqual([])
    const zero = { pipeline: [sel(null).pipeline[0], { scalarFilter: { op: '<', lhs: { agg: 'count' }, rhs: { num: 1 } } }] }
    expect(oracle.search(zero, spans, opts)).toEqual([])
  })

  it('rejects a spanset filter after a pipeline stage and a literal on the left', () => {
    const count = { scalarFilter: { op: '>', lhs: { agg: 'count' }, rhs: { num: 1 } } }
    expect(() => oracle.search({ pipeline: [sel(null).pipeline[0], count, sel(null).pipeline[0]] }, spans, opts)).toThrow(/unsupported/)
    const flipped = { scalarFilter: { op: '<', lhs: { num: 1 }, rhs: { agg: 'count' } } }
    expect(() => oracle.search({ pipeline: [sel(null).pipeline[0], flipped] }, spans, opts)).toThrow(/aggregate/)
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
    const got = [{ ...t('a', ['x'], 1), spanSets: 2, spanSetMatchesFirst: false }]
    expect(diff(got, [t('a', ['x'], 1)])).toEqual(['a has 2 spanSets, want 1', 'a spanSet differs from spanSets[0]'])
  })
})

// Hand-checked metrics results: range series by label key -> {minute after
// FROM: value}; instant and compare() series by label key -> value; or
// UNRESOLVED. The mixed and mixed2 trees start in minute 2.
const COUNT = 'count_over_time'
const count = (byMinute) => ({ [`__name__=${COUNT}`]: byMinute })
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
  m_agg_bare: count({ 0: 22, 1: 40, 2: 9 })
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
      if (want === oracle.UNRESOLVED) return expect(got).toEqual(oracle.UNRESOLVED)
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
        const minutes = Object.fromEntries(Object.entries(byKey[key].samples).map(([ts, v]) => [(ts - FROM) / 60000, v]))
        expect(Object.keys(minutes).sort()).toEqual(Object.keys(w).sort())
        for (const [m, v] of Object.entries(w)) expect(minutes[m]).toBeCloseTo(v, 12)
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

describe('traceql metrics diff', () => {
  const STEP = 60000
  const want = [{ labels: { __name__: COUNT }, samples: { 120000: 2 }, buckets: { 120000: [{ traceId: 't1', start: 121000 }, { traceId: 't2', start: 122000 }] } }]
  const ex = (trace, ts) => ({ labels: [{ key: 'trace:id', value: { stringValue: trace } }], value: 0, timestampMs: String(ts) })
  const resp = (exemplars, samples = [{ timestampMs: '60000' }, { timestampMs: '120000', value: 2 }]) => ({
    status: 200,
    data: { series: [{ labels: [{ key: '__name__', value: { stringValue: COUNT } }], samples, exemplars }] }
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
// a query that selects every span, or UNRESOLVED.
const SEED_KEYS = ['chain', 'db.system', 'depth', 'http.method', 'idx', 'local_endpoint_service_name', 'lvl', 'name', 'op',
  'otel.status_code', 'role', 'service.name', 'shape', 'status', 'suite', 'svc', 'test_id', 'v']
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
  ac_values_agg: ['mix_a1', 'mix_a2', 'mix_b1']
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
      if (want === oracle.UNRESOLVED) return expect(got).toEqual(oracle.UNRESOLVED)
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

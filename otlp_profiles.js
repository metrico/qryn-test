// Helpers for building OTLP profiles (profiles/v1development) export requests.
//
// The pprof e2e tests replay pre-recorded base64 bodies, but OTLP profiles
// carry their timestamp *inside* the payload (Profile.time_unix_nano) rather
// than in query params, so a frozen blob would always fall outside the test's
// query window. These helpers build the payload instead, which also lets the
// tests vary labels/sample types per request.

const protobuf = require('protobufjs')
const path = require('path')

// keepCase so the JS object keys are the snake_case proto field names, which
// keeps this file cross-referenceable against the .proto and the Go side.
const root = new protobuf.Root()
root.loadSync(path.join(__dirname, 'otlp_profiles.proto'), { keepCase: true })
const pkg = 'opentelemetry.proto.profiles.v1development'
const ExportProfilesServiceRequest =
  root.lookupType(`${pkg}.ExportProfilesServiceRequest`)

/**
 * Interning builder for the request-level ProfilesDictionary. Every profile in
 * an export request references this one shared dictionary by index; gigapipe
 * prunes it to the per-profile reachable set at write time.
 */
class Dictionary {
  constructor () {
    // index 0 is conventionally the empty string
    this.string_table = ['']
    this.function_table = []
    this.location_table = []
    this.stack_table = []
    this.mapping_table = []
    this.attribute_table = []
    this.link_table = []
    this._strings = { '': 0 }
    this._functions = {}
  }

  str (s) {
    if (!(s in this._strings)) {
      this._strings[s] = this.string_table.length
      this.string_table.push(s)
    }
    return this._strings[s]
  }

  /**
   * @param name {string}
   * @param opts {{filename?: string, startLine?: number}}
   * @returns {number} function_table index
   */
  fn (name, opts) {
    opts = opts || {}
    if (name in this._functions) {
      return this._functions[name]
    }
    const idx = this.function_table.length
    this.function_table.push({
      name_strindex: this.str(name),
      system_name_strindex: this.str(name),
      filename_strindex: this.str(opts.filename || 'app.go'),
      start_line: opts.startLine || 0
    })
    this._functions[name] = idx
    return idx
  }

  /**
   * A location with a single line, i.e. a symbolized frame.
   * @returns {number} location_table index
   */
  location (name, opts) {
    opts = opts || {}
    const idx = this.location_table.length
    this.location_table.push({
      mapping_index: opts.mappingIndex || 0,
      address: opts.address || 0,
      lines: [{ function_index: this.fn(name, opts), line: opts.line || 0, column: 0 }],
      attribute_indices: opts.attributeIndices || []
    })
    return idx
  }

  /**
   * An *unsymbolized* location: no lines, address only. gigapipe names these
   * "<mapping filename>+0x<addr>", with "@<build id>" inserted when the mapping
   * carries one. Pass opts.mappingIndex to choose the binary; it defaults to 0,
   * which is the first mapping registered, not "no mapping".
   * @returns {number} location_table index
   */
  addressLocation (address, opts) {
    opts = opts || {}
    this.location_table.push({
      mapping_index: opts.mappingIndex || 0,
      address: address,
      lines: [],
      attribute_indices: []
    })
    return this.location_table.length - 1
  }

  /**
   * @param frames {string[]} frame names, LEAF FIRST (pprof convention:
   *   location_indices[0] is the leaf, the last entry is the root)
   * @returns {number} stack_table index
   */
  stack (frames) {
    this.stack_table.push({
      location_indices: frames.map(f => this.location(f))
    })
    return this.stack_table.length - 1
  }

  /** @param locationIndices {number[]} leaf first */
  stackOfLocations (locationIndices) {
    this.stack_table.push({ location_indices: locationIndices })
    return this.stack_table.length - 1
  }

  mapping (filename) {
    this.mapping_table.push({
      memory_start: 0,
      memory_limit: 0,
      file_offset: 0,
      filename_strindex: this.str(filename),
      attribute_indices: []
    })
    return this.mapping_table.length - 1
  }

  attr (key, value, unit) {
    this.attribute_table.push({
      key_strindex: this.str(key),
      value: { string_value: value },
      unit_strindex: this.str(unit || '')
    })
    return this.attribute_table.length - 1
  }

  link (traceId, spanId) {
    this.link_table.push({
      trace_id: Buffer.from(traceId, 'hex'),
      span_id: Buffer.from(spanId, 'hex')
    })
    return this.link_table.length - 1
  }
}

// Nanosecond timestamps exceed 2^53, so they must be handed to protobufjs as
// Long rather than as a JS number.
const u64 = (s) => protobuf.util.Long.fromString(String(s), true)

const attrs = (obj) => Object.entries(obj)
  .map(([key, value]) => ({ key, value: { string_value: value } }))

/**
 * @param opts {{
 *   sampleType: [string, string],
 *   periodType: [string, string],
 *   timeUnixNanoStr: string,
 *   durationNano?: number,
 *   period?: number,
 *   samples: {stack: number, values: number[], attributeIndices?: number[]}[],
 *   attributeIndices?: number[]
 * }}
 * @param dict {Dictionary}
 */
const profile = (dict, opts) => ({
  sample_type: {
    type_strindex: dict.str(opts.sampleType[0]),
    unit_strindex: dict.str(opts.sampleType[1])
  },
  period_type: {
    type_strindex: dict.str(opts.periodType[0]),
    unit_strindex: dict.str(opts.periodType[1])
  },
  time_unix_nano: u64(opts.timeUnixNanoStr),
  duration_nano: opts.durationNano || 10000000000,
  period: opts.period || 0,
  attribute_indices: opts.attributeIndices || [],
  samples: opts.samples.map(s => ({
    stack_index: s.stack,
    values: s.values,
    link_index: 0,
    attribute_indices: s.attributeIndices || [],
    timestamps_unix_nano: []
  }))
})

/**
 * @param res {{
 *   resourceAttrs: Object<string,string>,
 *   scopeName?: string,
 *   scopeAttrs?: Object<string,string>,
 *   profiles: Object[]
 * }}
 */
const resourceProfiles = (res) => ({
  resource: { attributes: attrs(res.resourceAttrs || {}) },
  scope_profiles: [{
    scope: {
      name: res.scopeName || 'qryn-e2e',
      version: '1.0.0',
      attributes: attrs(res.scopeAttrs || {})
    },
    profiles: res.profiles
  }]
})

/**
 * Builds one export request. Pass either a single resource inline
 * (resourceAttrs/scopeName/scopeAttrs/profiles) or several in `resources`; all
 * of them share `dict`, as in a real batched export.
 *
 * @param opts {{
 *   dict: Dictionary,
 *   resourceAttrs?: Object<string,string>,
 *   scopeName?: string,
 *   scopeAttrs?: Object<string,string>,
 *   profiles?: Object[],
 *   resources?: Object[]
 * }}
 * @returns {Buffer} serialized ExportProfilesServiceRequest
 */
const encodeRequest = (opts) => {
  const dict = opts.dict
  const resources = opts.resources || [opts]
  const msg = {
    dictionary: {
      string_table: dict.string_table,
      function_table: dict.function_table,
      location_table: dict.location_table,
      stack_table: dict.stack_table,
      mapping_table: dict.mapping_table,
      attribute_table: dict.attribute_table,
      link_table: dict.link_table
    },
    resource_profiles: resources.map(resourceProfiles)
  }
  const err = ExportProfilesServiceRequest.verify(msg)
  if (err) {
    throw new Error(`invalid OTLP profiles request: ${err}`)
  }
  return Buffer.from(
    ExportProfilesServiceRequest.encode(msg).finish())
}

module.exports = {
  Dictionary,
  profile,
  encodeRequest,
  ExportProfilesServiceRequest
}

const axios = require('axios')
const {EventEmitter} = require("events");
/**
 *
 * @param id {string}
 * @param frequencySec {number}
 * @param startMs {number}
 * @param endMs {number}
 * @param extraLabels {Object}
 * @param msgGen? {(function(number): String)}
 * @param valGen? {(function(number): number)}
 * @param points {Object}
 */
module.exports.createPoints = (id, frequencySec,
  startMs, endMs,
  extraLabels, points, msgGen, valGen) => {
  const streams = {
    test_id: id,
    freq: frequencySec.toString(),
    ...extraLabels
  }
  msgGen = msgGen || ((i) => `FREQ_TEST_${i}`)
  const values = new Array(Math.floor((endMs - startMs) / frequencySec / 1000)).fill(0)
    .map((v, i) => valGen
      ? [((startMs + frequencySec * i * 1000) * 1000000).toString(), msgGen(i), valGen(i)]
      : [((startMs + frequencySec * i * 1000) * 1000000).toString(), msgGen(i)])
  points = { ...points }
  points[JSON.stringify(streams)] = {
    stream: streams,
    values: values
  }
  return points
}

/**
 *
 * @param points {Object<string, {stream: Object<string, string>, values: [string, string]}>}
 * @param endpoint {string}
 * @returns {Promise<void>}
 */
module.exports.sendPoints = async (endpoint, points) => {
  try {
    console.log(`${endpoint}/loki/api/v1/push`)
    await axios.post(`${endpoint}/loki/api/v1/push`, {
      streams: Object.values(points)
    }, {
      headers: { 'Content-Type': 'application/json', "X-Scope-OrgID": "1", 'X-Shard': shard }
    })
  } catch (e) {
    console.log(e.response)
    throw e
  }
}
const e2e = () => process.env.INTEGRATION_E2E || process.env.INTEGRATION

const clokiExtUrl = process.env.CLOKI_EXT_URL || 'localhost:3100'
const clokiWriteUrl = process.env.CLOKI_WRITE_URL || process.env.CLOKI_EXT_URL || 'localhost:3100'

jest.setTimeout(300000)

const _it = (() => {
  const finished = {}
  const emitter = new EventEmitter()
  const onFinish = (name) => {
    if (finished[name]) {
      return Promise.resolve()
    }
    return new Promise(f => emitter.once(name, f))
  }
  const fireFinish = (name) => {
    finished[name] = true
    emitter.emit(name)
  }
  return (name, fn, deps) => {
    it(name, async () => {
      try {
        if (!e2e) {
          return
        }
        if (deps) {
          await Promise.all(deps.map(d => onFinish(d)))
        }
        await fn()
      } finally {
        fireFinish(name)
      }
    })
  }
})()

const testID = Math.random() + ''
const start = Math.floor((Date.now() - 60 * 1000 * 10) / 60 / 1000) * 60 * 1000
const end = Math.floor(Date.now() / 60 / 1000) * 60 * 1000

beforeAll(() => {
  jest.setTimeout(300000)
})

afterAll(() => {
  if (!e2e()) {
    return
  }
})

const axiosGet = async (req) => {
  try {
    return await axios.get(req, {headers: {'X-Scope-OrgID': '1'}})
  } catch(e) {
    console.log(req)
    throw new Error(e)
  }
}

const shard = -1

const storage = {}

module.exports = {
  ...module.exports,
  clokiWriteUrl,
  clokiExtUrl,
  _it,
  testID,
  start,
  end,
  axiosGet,
  storage,
  shard
}

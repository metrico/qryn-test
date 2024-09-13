const axios = require('axios')
const {EventEmitter} = require("events");
const http = require('http')
const https = require('https')
//const got = require('got')
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
    return await axiosPost(`${endpoint}/loki/api/v1/push`, {
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

const testID = 'id' + (Math.random() + '').substring(2)
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

const auth = () => {
  return process.env.QRYN_LOGIN ? {
    'Authorization':
      `Basic ${Buffer.from(`${process.env.QRYN_LOGIN}:${process.env.QRYN_PASSWORD}`).toString('base64')}`,
  } : {}
}

const axiosGet = async (req, conf) => {
  try {
    conf = conf || {}
    return await axios.get(req, {...conf, timeout: 30000, headers: {
      'X-Scope-OrgID': '1',
      ...auth(),
      ...extraHeaders,
      ...(conf.headers || {})
    }})
  } catch(e) {
    console.log(req)
    throw new Error(e)
  }
}

const rawGet = (url, conf) => new Promise((resolve, reject) => {
  const client = url.startsWith('https')? https : http
  const options = {
    headers: {
      'X-Scope-OrgID': '1',
      ...auth(),
      ...extraHeaders,
      ...(conf?.headers || {})
    }
  }

  const req = client.get(url, options, (res) => {
    let responseBody = Buffer.from(new Uint8Array(0));
    res.on('data', (chunk) => {
      responseBody = Buffer.concat([responseBody, chunk])
    });
    res.on('end', () => resolve({
      code: res.statusCode,
      data: responseBody
    }));
  });

  req.on('error', (err) => reject(err));
  req.end();
})

const axiosPost = async (req, data, conf) => {
  try {
    return await axios.post(req, data, {
      ...(conf || {}),
      headers: {
        'X-Scope-OrgID': '1',
        ...auth(),
        ...extraHeaders,
        ...(conf?.headers || {})
      }
    })
  } catch(e) {
    console.log(req)
    throw new Error(e)
  }
}

const axiosDelete = async (req, conf) => {
  try {
    return await axios.delete(req, {
      ...(conf || {}),
      headers: {
        'X-Scope-OrgID': '1',
        ...auth(),
        ...extraHeaders,
        ...(conf?.headers || {})
      }
    })
  } catch(e) {
    console.log(req)
    throw new Error(e)
  }
}

const extraHeaders = (() => {
  const res = auth()
  if (process.env.DSN) {
    res['X-CH-DSN'] = process.env.DSN
  }
  return res
})()

const shard = -1

const storage = {}
const otelCollectorUrl = process.env.OTEL_COLLECTOR_URL || null

module.exports = {
  ...module.exports,
  clokiWriteUrl,
  clokiExtUrl,
  otelCollectorUrl,
  _it,
  testID,
  start,
  end,
  axiosGet,
  axiosPost,
  axiosDelete,
  extraHeaders,
  storage,
  shard,
  rawGet
}

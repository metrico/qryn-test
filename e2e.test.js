const axios = require('axios')
const yaml = require('yaml')
const {clokiWriteUrl, clokiExtUrl, axiosGet } = require('./common')

it('qryn should work', async () => {
  let retries = 0
  while (true) {
    try {
      await axiosGet(`http://${clokiWriteUrl}/ready`)
      await axiosGet(`http://${clokiExtUrl}/ready`)
      return
    } catch (e) {
      if (retries >= 10) {
        throw e;
      }
      retries++
      await new Promise(f => setTimeout(f, 1000))
    }
  }
})

require('./e2e.writer')
require('./e2e.logql.reader')
require('./e2e.tempo.reader')
require('./e2e.prom.reader')
require('./e2e.misc')
require('./e2e.alert.config')
require('./e2e.traceql')

const checkAlertConfig = async () => {
  try {
    expect(await axios({
      method: 'POST',
      url: 'http://localhost:3100/api/prom/rules/test_ns',
      data: yaml.stringify({
        name: 'test_group',
        interval: '1s',
        rules: [{
          alert: 'test_rul',
          for: '1m',
          annotations: { summary: 'ssssss' },
          labels: { lllll: 'vvvvv' },
          expr: '{test_id="alert_test"}'
        }]
      }),
      headers: {
        'Content-Type': 'application/yaml'
      }
    })).toHaveProperty('data', { msg: 'ok' })
    expect(yaml.parse((await axios.get('http://localhost:3100/api/prom/rules')).data))
        .toHaveProperty('test_ns', [{
          name: 'test_group',
          interval: '1s',
          rules: [{
            alert: 'test_rul',
            for: '1m',
            annotations: { summary: 'ssssss' },
            labels: { lllll: 'vvvvv' },
            expr: '{test_id="alert_test"}'
          }]
        }])
    await axios.delete('http://localhost:3100/api/prom/rules/test_ns').catch(console.log)
  } catch (e) {
    await axios.delete('http://localhost:3100/api/prom/rules/test_ns').catch(console.log)
    throw e
  }
}

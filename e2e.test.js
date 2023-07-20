const axios = require('axios')
const yaml = require('yaml')

require('./e2e.writer')
require('./e2e.logql.reader')
require('./e2e.tempo.reader')
require('./e2e.prom.reader')
require('./e2e.misc')
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

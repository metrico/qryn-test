const {_it, clokiExtUrl} = require("./common");
const axios = require('axios')
const yaml = require('yaml')

_it('should send alerts', async () => {
    expect(await axios({
        method: 'POST',
        url: `http://${clokiExtUrl}/api/prom/rules/test_ns`,
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
})

_it('should read alerts', async () => {
    expect(yaml.parse((await axios.get(`http://${clokiExtUrl}/api/prom/rules`)).data))
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
}, ['should send alerts'])

_it('should remove alerts', async () => {
    expect(await axios.delete(`http://${clokiExtUrl}/api/prom/rules/test_ns`))
        .toHaveProperty('status', 200)
}, ['should read alerts', 'should send alerts']);

const {_it, clokiExtUrl, axiosGet, axiosDelete, axiosPost } = require("./common");
const yaml = require('yaml')
/* TODO: not supported by qryn-go
_it('should send alerts', async () => {
    expect(await axiosPost(`http://${clokiExtUrl}/api/prom/rules/test_ns`,yaml.stringify({
        name: 'test_group',
        interval: '1s',
        rules: [{
            alert: 'test_rul',
            for: '1m',
            annotations: { summary: 'ssssss' },
            labels: { lllll: 'vvvvv' },
            expr: '{test_id="alert_test"}'
        }]
    }), {
        headers: {
            'Content-Type': 'application/yaml'
        }
    })).toHaveProperty('data', { msg: 'ok' })
})

_it('should read alerts', async () => {
    expect(yaml.parse((await axiosGet(`http://${clokiExtUrl}/api/prom/rules`)).data))
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
    expect(await axiosDelete(`http://${clokiExtUrl}/api/prom/rules/test_ns`))
        .toHaveProperty('status', 200)
}, ['should read alerts', 'should send alerts']);
*/

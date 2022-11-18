const {_it, axiosGet, clokiExtUrl} = require("./common");

_it('should get /ready', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/ready`)).status).toEqual(200)
})

_it('should get /metrics', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/metrics`)).status).toEqual(200)
})

/* _it('should get /influx/health', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/influx/health`)).status).toEqual(200)
}) */

_it('should get /config', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/config`)).status).toEqual(200)
})

_it('should get /api/v1/rules', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/api/v1/rules`)).status).toEqual(200)
})


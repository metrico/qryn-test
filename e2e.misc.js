const {_it, axiosGet, clokiExtUrl, clokiWriteUrl} = require("./common");

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

_it('should get /api/v1/metadata', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/api/v1/metadata`)).status).toEqual(200)
})

_it('should get /api/v1/status/buildinfo', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/api/v1/status/buildinfo`)).status).toEqual(200)
})

_it('should get /influx/api/v2/write/health', async () => {
    expect((await axiosGet(`http://${clokiWriteUrl}/influx/api/v2/write/health`)).status).toEqual(200)
})

_it('should get /influx/health', async () => {
    expect((await axiosGet(`http://${clokiWriteUrl}/influx/health`)).status).toEqual(200)
})

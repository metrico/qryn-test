const {_it, axiosGet, clokiExtUrl} = require("./common");

_it('should get /ready', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/ready`)).status).toEqual(200)
})

_it('should get /metrics', async () => {
    expect((await axiosGet(`http://${clokiExtUrl}/metrics`)).status).toEqual(200)
})
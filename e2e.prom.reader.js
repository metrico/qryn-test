const axios = require('axios')
const {clokiExtUrl, _it, testID, clokiWriteUrl, shard} = require('./common')
const {pushTimeseries} = require("prometheus-remote-write");
const fetch = require("node-fetch");

_it('should post /api/v1/labels', async () => {
    const {pushTimeseries} = require('prometheus-remote-write')
    const res = await pushTimeseries({
        labels: {
            [`${testID}_LBL'`]: 'ok'
        },
        samples: [
            {
                value: 123,
                timestamp: Date.now(),
            },
        ],
    }, {
        url: `http://${clokiWriteUrl}/v1/prom/remote/write`,
        fetch: (input, opts) => {
            opts.headers['X-Scope-OrgID'] = '1'
            opts.headers['X-Shard'] = shard
            return fetch(input, opts)
        }
    })
    expect(res.status).toEqual(204)
    const fd = new URLSearchParams()
    await new Promise(resolve => setTimeout(resolve, 1000))
    fd.append('start', `${Math.floor(Date.now() / 1000) - 10}`)
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    const labels = await axios.post(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Shard': shard
        }
    })
    console.log(labels.data.data)
    expect(labels.data.data.find(d => d===`${testID}_LBL'`)).toBeTruthy()
})

//TODO: uncomment after issue fix
/*
_it('should post /api/v1/labels with empty result', async () => {
    const fd = new URLSearchParams()
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    const labels = await axios.post(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    console.log(labels.data.data)
    expect(labels.data.data.find(d => d===`${testID}_LBL'`)).toBeFalsy()
}, ['should post /api/v1/labels']) */

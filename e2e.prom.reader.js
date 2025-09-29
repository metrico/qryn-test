const axios = require('axios')
const {clokiExtUrl, _it, testID, clokiWriteUrl, shard, axiosGet, extraHeaders, start, end} = require('./common')

/* TODO: implement _it('should post /api/v1/labels with empty result', async () => {
    let fd = new URLSearchParams()
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 1 * 3600 * 1000) / 1000)}`)
    let labels = await axiosPost(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    labels = await axiosPost(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
}, ['should post /api/v1/labels']) */

/* TODO: implement _it('should get /api/v1/labels with empty result', async () => {
    let fd = new URLSearchParams()
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 3600 * 1000) / 1000)}`)
    let labels = await axios.get(`http://${clokiExtUrl}/api/v1/labels?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    console.log(`--------------------- http://${clokiExtUrl}/api/v1/labels?${fd}`)
    labels = await axios.get(`http://${clokiExtUrl}/api/v1/labels?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
}, ['should post /api/v1/labels']) */

/* TODO: implement _it('should post /api/v1/series with time context', async () => {
    let fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 3600 * 1000) / 1000)}`)
    let labels = await axiosPost(`http://${clokiExtUrl}/api/v1/series`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    labels = await axiosPost(`http://${clokiExtUrl}/api/v1/series`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeFalsy()
}, ['should post /api/v1/labels'])*/

/* TODO: implement _it('should get /api/v1/series with time context', async () => {
    let fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    fd.append('start', `${Math.floor((Date.now() - 3600 * 1000) / 1000)}`)
    let labels = await axios.get(`http://${clokiExtUrl}/api/v1/series?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeTruthy()

    fd = new URLSearchParams()
    fd.append('match[]', `{test_id="${testID}"}`)
    fd.append('start', `${Math.floor((Date.now() - 25 * 3600 * 1000) / 1000)}`)
    fd.append('end', `${Math.floor((Date.now() - 24 * 3600 * 1000) / 1000)}`)
    labels = await axios.get(`http://${clokiExtUrl}/api/v1/series?${fd}`, {
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeFalsy()
}, ['should post /api/v1/labels'])
*/

const adjustPromMatrixResponse = (data) => {
    data.data.result.forEach(ts => {
        expect(ts.metric.test_id).toEqual(`${testID}_RWR`)
        ts.metric.test_id = "TEST_ID"
        ts.values.forEach(v => {v[0] -= Math.floor(start / 1000)})
    })
    return data
}

const _itShouldReadPromMatrix = (name, queryOrConf) => _it(name, async () => {
    let conf = typeof queryOrConf == 'string' ? {query: queryOrConf} : queryOrConf
    conf = {
        start: start,
        end: end,
        step: 15,
        ...conf,
    }
    let fd = new URLSearchParams()
    fd.append('query',  conf.query)
    fd.append('start', Math.floor(conf.start / 1000))
    fd.append('end', Math.floor(conf.end / 1000))
    fd.append('step', conf.step)
    const resp = await axiosGet(`http://${clokiExtUrl}/api/v1/query_range?${fd}`, {
        headers: conf.headers || {}
    })
    expect(resp.status).toEqual(200)
    expect(adjustPromMatrixResponse(resp.data)).toMatchSnapshot()
}, ['should send prometheus.remote.write'])

_itShouldReadPromMatrix(`prometheus: should read gauge`, `test_metric{test_id="${testID}_RWR"}`)
_itShouldReadPromMatrix(`prometheus: should read counter`, `test_counter{test_id="${testID}_RWR"}`)
_itShouldReadPromMatrix(`prometheus: should read rate`, `rate(test_counter{test_id="${testID}_RWR"}[1m])`)
_itShouldReadPromMatrix(`prometheus: should read sum`,
    `sum by (test_id) (test_counter{test_id="${testID}_RWR"})`)
_itShouldReadPromMatrix(`prometheus: should sum + rate`,
    `sum by (test_id) (rate(test_counter{test_id="${testID}_RWR"}[1m]))`)

/*_itShouldReadPromMatrix(`prometheus exp: should sum + rate`,
    {
        query:`sum by (test_id) (rate(test_counter{test_id="${testID}_RWR"}[1m]))`,
        headers: {'X-Experimental': '1'}
})*/
const axios = require('axios')
const {clokiExtUrl, _it, testID, clokiWriteUrl, shard, axiosPost, extraHeaders, start, end} = require('./common')

_it('should post /api/v1/labels with empty result', async () => {
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
}, ['should post /api/v1/labels'])

_it('should get /api/v1/labels with empty result', async () => {
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
}, ['should post /api/v1/labels'])

_it('should post /api/v1/series with time context', async () => {
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
}, ['should post /api/v1/labels'])

_it('should get /api/v1/series with time context', async () => {
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

_it('should read datadog metrics', async () => {
    const fd = new URLSearchParams()
    fd.append('query', `DDMetric_${testID}{}`)
    fd.append('end', Math.floor(Date.now()/1000+1))
    fd.append('start', Math.floor(Date.now() / 1000 - 600))
    fd.append('step', '15s')
    let res = null
    console.log(`http://${clokiExtUrl}/api/v1/query_range?${fd}`)
    try {
        res = await axios.get(`http://${clokiExtUrl}/api/v1/query_range?${fd}`, {
            headers: {
                'X-Scope-OrgID': '1',
                ...extraHeaders
            }
        })
        expect(res.status).toEqual(200)
        res.data.data.stats = null;
        res.data.data.result.forEach(r => {
            expect(r.metric.__name__).toEqual(`DDMetric_${testID}`)
            r.metric.__name__ = null
            r.values.forEach(v => {
                v[0] = 0
                expect(parseFloat(v[1])).toEqual(0.7)
            })
            r.values = [r.values[0]]
        })
        expect(res.data).toMatchSnapshot()
    } catch (e) {
        console.log(JSON.stringify(e.response?.data, null, 1))
        throw e
    }
}, ['should send datadog metrics'])

_it('should read datadog metrics', async () => {
    const fd = new URLSearchParams()
    fd.append('query', `DDMetric_${testID}{}`)
    fd.append('end', Math.floor(Date.now()/1000+1))
    fd.append('start', Math.floor(Date.now() / 1000 - 600))
    fd.append('step', '15s')
    let res = null
    console.log(`http://${clokiExtUrl}/api/v1/query_range?${fd}`)
    try {
        res = await axios.get(`http://${clokiExtUrl}/api/v1/query_range?${fd}`, {
            headers: {
                'X-Scope-OrgID': '1',
                ...extraHeaders
            }
        })
        expect(res.status).toEqual(200)
        res.data.data.stats = null;
        res.data.data.result.forEach(r => {
            expect(r.metric.__name__).toEqual(`DDMetric_${testID}`)
            r.metric.__name__ = null
            r.values.forEach(v => {
                v[0] = 0
                expect(parseFloat(v[1])).toEqual(0.7)
            })
            r.values = [r.values[0]]
        })
        expect(res.data).toMatchSnapshot()
    } catch (e) {
        console.log(JSON.stringify(e.response?.data, null, 1))
        throw e
    }
}, ['should send datadog metrics'])

_it ('should read prometheus.remote.write', async () => {
    const fd = new URLSearchParams()
    fd.append('query', `{test_id="${testID}_RWR",route="v1/prom/remote/write"}`)
    fd.append('end', Math.floor(end/1000+1))
    fd.append('start', Math.floor(start / 1000))
    fd.append('step', '15s')
    let res = null
    console.log(`http://${clokiExtUrl}/api/v1/query_range?${fd}`)
    try {
        res = await axios.get(`http://${clokiExtUrl}/api/v1/query_range?${fd}`, {
            headers: {
                'X-Scope-OrgID': '1',
                ...extraHeaders
            }
        })
        expect(res.status).toEqual(200)
        res.data.data.stats = null;
        res.data.data.result.forEach(r => {
            expect(r.metric.test_id).toEqual(`${testID}_RWR`)
            r.metric.test_id = null
            r.values.forEach(v => {
                v[0] = Math.floor(v[0]) - Math.floor(start / 1000)
                expect(parseFloat(v[1])).toEqual(123)
            })
            r.values = [r.values[0]]
        })
        expect(res.data).toMatchSnapshot()
    } catch (e) {
        console.log(JSON.stringify(e.response?.data, null, 1))
        throw e
    }
}, ['should send prometheus.remote.write'])

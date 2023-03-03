const axios = require('axios')
const {clokiExtUrl, _it, testID, clokiWriteUrl, shard, axiosPost, extraHeaders} = require('./common')

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
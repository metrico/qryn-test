const {
    _it, start, end, testID, clokiExtUrl, createPoints, sendPoints,
    clokiWriteUrl, axiosGet, axiosPost, extraHeaders, rawGet, kOrder
} = require("./common");
const {WebSocket} = require("ws");
const zlib = require("zlib");


const runRequestFunc = (start, end) => async (req, _step, _start, _end, oid, limit) => {
    console.log(req)
    oid = oid || "1"
    limit = limit || 2000
    try {
        _start = _start || start
        _end = _end || end
        _step = _step || 2
        return await axiosGet(
            `http://${clokiExtUrl}/loki/api/v1/query_range?direction=BACKWARD&limit=${limit}&query=${encodeURIComponent(req)}&start=${_start}000000&end=${_end}000000&step=${_step}`,
            {
                headers: {
                    "X-Scope-OrgID": oid,
                    ...extraHeaders
                }
            }
        )
    } catch (e) {
        throw new Error(`${e.message}; req: ${req}`)
    }
}



const adjustResultFunc = (start, testID) => (resp, id, _start) => {
    _start = _start || start
    id = id || testID
    resp.data.data.result = resp.data.data.result.map(stream => {
        expect((stream.stream.test_id || '').substring(0, id.length)).toEqual(id)
        stream.stream.test_id = 'TEST_ID'
        stream.values = stream.values.map(v => [v[0] - _start * 1000000, v[1]])
        return stream
    })
}

const runRequest = runRequestFunc(start, end)
const adjustResult = adjustResultFunc(start, testID)
const adjustMatrixResult = (resp, id) => {
    id = id || testID
    resp.data.data.result = resp.data.data.result.map(stream => {
        expect((stream.metric.test_id || '').substring(0, id.length)).toEqual(id)
        stream.metric.test_id = 'TEST_ID'
        stream.values = stream.values.map(v => [v[0] - Math.floor(start / 1000), v[1]])
        return stream
    })
}
/**
 *
 * @param optsOrName {{
 *   name: string,
 *   req: string,
 *   step: number|undefined,
 *   start: number|undefined,
 *   end: number|undefined,
 *   testID: string|undefined | string,
 *   oid: {string},
 *   limit: {number},
 *   deps: {[string]}
 * } | string}
 * @param req {string | undefined}
 * @private
 */
const _itShouldStdReq = (optsOrName, req) => {
    const opts = {
        ...(typeof optsOrName === 'object' ? optsOrName : {}),
        name: typeof optsOrName === 'object' ? optsOrName.name : optsOrName,
        req: typeof optsOrName === 'object' ? optsOrName.req : req
    }
    _it (opts.name, async () => {
        let resp = await runRequest(opts.req, opts.step, opts.start, opts.end, opts.oid, opts.limit)
        adjustResult(resp)
        resp.data.data.result.sort((a, b) => {
            const s1 = Object.entries(a.stream)
            s1.sort()
            const s2 = Object.entries(b.stream)
            s2.sort()
            return JSON.stringify(s2).localeCompare(JSON.stringify(s1))
        })
        expect(resp.data).toMatchSnapshot()
    }, opts.deps || ['push logs http'])
}

/**
 *
 * @param optsOrName {{
 *   name: string,
 *   req: string,
 *   step: number|undefined,
 *   start: number|undefined,
 *   end: number|undefined,
 *   testID: string|undefined,
 *   deps: string[]
 * } | string}
 * @param req {string | undefined}
 * @private
 */
const _itShouldMatrixReq = (optsOrName, req) => {
    const opts = {
        ...(typeof optsOrName === 'object' ? optsOrName : {}),
        name: typeof optsOrName === 'object' ? optsOrName.name : optsOrName,
        req: typeof optsOrName === 'object' ? optsOrName.req : req,
        deps: typeof optsOrName === 'object' ? optsOrName.deps || ['push logs http'] : ['push logs http']
    }
    _it (opts.name, async () => {
        let resp = await runRequest(opts.req, opts.step, opts.start, opts.end)
        adjustMatrixResult(resp)
        expect(resp.data).toMatchSnapshot()
    }, opts.deps)
}

_itShouldStdReq({name: 'ok limited res', limit: 2002, req: `{test_id="${testID}"}`})
_itShouldStdReq({
    name:'empty res',
    req: `{test_id="${testID}"}`,
    step: 2,
    start: start - 3600 * 1000,
    end: end - 3600 * 1000
})

_itShouldStdReq('two clauses', `{test_id="${testID}", freq="2"}`)
_itShouldStdReq('two clauses and filter', `{test_id="${testID}", freq="2"} |~ "2[0-9]$"`)
_itShouldMatrixReq('aggregation', `rate({test_id="${testID}", freq="2"} |~ "2[0-9]$" [1s])`)
_itShouldMatrixReq('aggregation 1m', `rate({test_id="${testID}", freq="2"} [1m])`)

_it('should hammer aggregation', async () => {
    for (const fn of ['count_over_time', 'bytes_rate', 'bytes_over_time']) {
        const resp = await runRequest(`${fn}({test_id="${testID}", freq="2"} |~ "2[0-9]$" [1s])`)
        expect(resp.data.data.result.length).toBeTruthy()
    }
}, ['push logs http'])

_itShouldMatrixReq('aggregation operator',
    `sum by (test_id) (rate({test_id="${testID}"} |~ "2[0-9]$" [1s]))`)

_it('should hammer aggregation operator', async () => {
    for (const fn of ['min', 'max', 'avg', 'stddev', 'stdvar', 'count']) {
        resp = await runRequest(`${fn} by (test_id) (rate({test_id="${testID}"} |~ "2[0-9]$" [1s]))`)
        expect(resp.data.data.result.length).toBeTruthy()
    }
}, ['push logs http'])

_itShouldMatrixReq({
    name: 'aggregation empty',
    req: `rate({test_id="${testID}", freq="2"} |~ "2[0-9]$" [1s])`,
    step: 2, start: start - 3600 * 1000,
    end: end - 3600 * 1000
})

_itShouldMatrixReq({
    name:'aggregation operator empty',
    req: `sum by (test_id) (rate({test_id="${testID}"} |~ "2[0-9]$" [1s]))`,
    step: 2,
    start: start - 3600 * 1000,
    end: end - 3600 * 1000
})

_itShouldStdReq('json no params', `{test_id="${testID}_json"}|json`)
_itShouldStdReq('json params', `{test_id="${testID}_json"}|json lbl_repl="new_lbl"`)

_itShouldStdReq('json with params / stream_selector',
    `{test_id="${testID}_json"}|json lbl_repl="new_lbl"|lbl_repl="new_val"`)

_itShouldStdReq('json with params / stream_selector 2',
    `{test_id="${testID}_json"}|json lbl_repl="new_lbl"|fmt="json"`)

_itShouldStdReq('json with no params / stream_selector',
    `{test_id="${testID}_json"}|json|fmt=~"[jk]son"`)

_itShouldStdReq('json with no params / stream_selector 2',
    `{test_id="${testID}_json"}|json|lbl_repl="REPL"`)
_itShouldMatrixReq('unwrap', `sum_over_time({test_id="${testID}_json"}|json` +
    '|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)')

_it('should hammer unwrap', async () => {
    for (const fn of ['rate', 'sum_over_time', 'avg_over_time', 'max_over_time', 'min_over_time',
        'first_over_time', 'last_over_time'
        // , 'stdvar_over_time', 'stddev_over_time', 'quantile_over_time', 'absent_over_time'
    ]) {
        resp = await runRequest(`${fn}({test_id="${testID}_json"}|json` +
            '|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)')
        try {
            expect(resp.data.data.result.length).toBeTruthy()
        } catch (e) {
            console.log(`${fn}({test_id="${testID}_json"}|json` +
                '|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)')
            throw e
        }
    }
}, ['push logs http'])

_itShouldMatrixReq(`unwrap + json params`,
    `sum_over_time({test_id="${testID}_json"}|json lbl_int1="int_val"` +
    '|lbl_repl="val_repl"|unwrap lbl_int1 [3s]) by (test_id, lbl_repl)')
_itShouldStdReq({name: 'lineFmt', limit: '2001', req: `{test_id="${testID}"}| line_format ` +
    '"{ \\"str\\":\\"{{._entry}}\\", \\"freq2\\": {{div .freq 2}} }"'})
_it('linefmt + json + unwrap', async() => {
    const resp = await runRequest(`rate({test_id="${testID}"}` +
        '| line_format "{ \\"str\\":\\"{{._entry}}\\", \\"freq2\\": {{div .freq 2}} }"' +
        '| json|unwrap freq2 [1s]) by (test_id, freq2)')
    adjustMatrixResult(resp, testID)
    resp.data.data.result.sort((a,b) => {
        return JSON.stringify(kOrder(a.metric)).localeCompare(JSON.stringify(kOrder(b.metric)))
    })
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('linefmt + json + unwrap + step', async() => {
    const resp = await runRequest(`rate({test_id="${testID}"}` +
        '| line_format "{ \\"str\\":\\"{{._entry}}\\", \\"freq2\\": {{div .freq 2}} }"' +
        '| json|unwrap freq2 [1s]) by (test_id, freq2)', 60)
    adjustMatrixResult(resp, testID)
    resp.data.data.result.sort((a,b) => {
        return JSON.stringify(kOrder(a.metric)).localeCompare(JSON.stringify(kOrder(b.metric)))
    })
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_itShouldStdReq('2xjson', `{test_id="${testID}_json"}|json|json int_lbl2="int_val"`)
_itShouldStdReq('json + linefmt', `{test_id="${testID}_json"}| line_format "{{ div .test_id 2  }}"`)
_itShouldMatrixReq('linefmt + unwrap entry + agg-op',
    `rate({test_id="${testID}_json"}| line_format "{{ div .int_lbl 2  }}" | unwrap _entry [1s])`)
_itShouldMatrixReq('json + LRA + agg-op',
    `sum(rate({test_id="${testID}_json"}| json [5s])) by (test_id)`)
_itShouldMatrixReq('json + params + LRA + agg-op',
    `sum(rate({test_id="${testID}_json"}| json lbl_rrr="lbl_repl" [5s])) by (test_id, lbl_rrr)`)
_itShouldMatrixReq('json + unwrap + 2 x agg-op',
    `sum(sum_over_time({test_id="${testID}_json"}| json | unwrap int_val [10s]) by (test_id, str_id)) by (test_id)`)
_itShouldMatrixReq('value comparison + LRA', `rate({test_id="${testID}"} [1s]) == 2`)
_itShouldMatrixReq('value comp + LRA + agg-op',
    `sum(rate({test_id="${testID}"} [1s])) by (test_id) > 4`)
_itShouldMatrixReq('value_comp + json + unwrap + 2 x agg-op',
    `sum(sum_over_time({test_id="${testID}_json"}| json | unwrap str_id [10s]) by (test_id, str_id)) by (test_id) > 1000`)
_itShouldMatrixReq('value comp + linefmt + LRA',
    `rate({test_id="${testID}"} | line_format "12345" [1s]) == 2`)
_itShouldStdReq('label comp', `{test_id="${testID}"} | freq >= 4`)
_itShouldStdReq('label cmp + json + params',
    `{test_id="${testID}_json"} | json sid="str_id" | sid >= 598`)
_itShouldStdReq('label cmp + json', `{test_id="${testID}_json"} | json | str_id >= 598`)
_itShouldStdReq({
    name: 'regexp',
    req: `{test_id="${testID}"} | regexp "^(?P<e>[^0-9]+)[0-9]+$"`,
    limit: 2002
})
_itShouldStdReq({
    name: 'regexp 2',
    req: `{test_id="${testID}"} | regexp "^[^0-9]+(?P<e>[0-9])+$"`,
    limit: 2002
})
_itShouldStdReq({
    name: 'regexp 3',
    req: `{test_id="${testID}"} | regexp "^[^0-9]+([0-9]+(?P<e>[0-9]))$"`,
    limit: 2002
})
_itShouldMatrixReq({
    name: 'regexp + unwrap + agg-op',
    req: `first_over_time({test_id="${testID}", freq="0.5"} | regexp "^[^0-9]+(?P<e>[0-9]+)$" | unwrap e [1s]) by(test_id)`,
    step: 1
})

_it('should ws', async () => {
    let auth = process.env.QRYN_LOGIN || ''
    auth = auth ? auth + ':' + process.env.QRYN_PASSWORD + '@' : ''
    const ws = new WebSocket(`ws://${auth}${clokiExtUrl}/loki/api/v1/tail?query={test_id="${testID}_ws"}&X-Scope-OrgID=1` +
        (process.env.DSN ? '&dsn='+encodeURIComponent(process.env.DSN) : ''))
    const resp = {
        data: {
            data: {
                result: []
            }
        }
    }
    const wsListener = (msg) => {
        console.log("GOT MESSAGE!!!!")
        if (!msg || msg === 'undefined') {
            return
        }
        try {
            const _msg = JSON.parse(msg)
            for (const stream of _msg.streams) {
                let _stream = resp.data.data.result.find(res =>
                    JSON.stringify(res.stream) === JSON.stringify(kOrder(stream.stream))
                )
                if (!_stream) {
                    _stream = {
                        stream: kOrder(stream.stream),
                        values: []
                    }
                    resp.data.data.result.push(_stream)
                }
                _stream.values.push(...stream.values)
            }
        } catch (e) {
            console.log(msg.toString())
            console.log(e)
        }
    }
    ws.on('message', wsListener)
    await new Promise(resolve => setTimeout(resolve, 1000))
    const wsStart = Math.floor(Date.now() / 1000) * 1000
    for (let i = 0; i < 5; i++) {
        const points = createPoints(testID + '_ws', 1, wsStart + i * 1000, wsStart + i * 1000 + 1000, {}, {},
            () => `MSG_${i}`)
        await sendPoints(`http://${clokiWriteUrl}`, points)
        await new Promise(resolve => setTimeout(resolve, 1000))
    }
    await new Promise(resolve => setTimeout(resolve, 2000))
    ws.off('message', wsListener)
    ws.close()
    ws.terminate()
    for (const res of resp.data.data.result) {
        res.values.sort()
    }
    console.log(JSON.stringify(resp, ' '))
    adjustResult(resp, testID + '_ws', wsStart)
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('should /series/match', async () => {
    const resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/series?match[]={test_id="${testID}"}&start=${start}000000&end=${end}000000`)
    resp.data.data = resp.data.data.map(l => {
        expect(l.test_id).toEqual(testID)
        return { ...l, test_id: 'TEST' }
    })
    resp.data.data.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('should multiple /series/match', async () => {
    resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/series?match[]={test_id="${testID}"}&match[]={test_id="${testID}_json"}&start=${start}000000&end=${end}000000`)
    resp.data.data = resp.data.data.map(l => {
        expect(l.test_id.startsWith(testID))
        return { ...l, test_id: l.test_id.replace(testID, 'TEST') }
    })
    resp.data.data.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('should /series/match gzipped', async () => {
    const resp = await rawGet(
      `http://${clokiExtUrl}/loki/api/v1/series?match[]={test_id="${testID}"}&start=1636008723293000000&end=1636012323293000000`,
      {
          headers: {
              'Accept-Encoding': 'gzip'
          },
          responseType: 'arraybuffer'
      })
    let data = JSON.parse(zlib.gunzipSync(resp.data).toString('utf-8'))
    data = data.data.map(l => {
        expect(l.test_id).toEqual(testID)
        return { ...l, test_id: 'TEST' }
    })
    data.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    expect(resp.code).toBe(200)
    expect(data).toMatchSnapshot()
}, ['push logs http'])

_itShouldStdReq('labels cmp',
    `{test_id="${testID}"} | freq > 1 and (freq="4" or freq==2 or freq > 0.5)`)
_itShouldStdReq('json + params + labels cmp',
    `{test_id="${testID}_json"} | json sid="str_id" | sid >= 598 or sid < 2 and sid > 0`)
_itShouldStdReq('json + labels cmp',
    `{test_id="${testID}_json"} | json | str_id < 2 or str_id >= 598 and str_id > 0`)
_itShouldStdReq('logfmt', `{test_id="${testID}_logfmt"}|logfmt`)
_itShouldMatrixReq('logfmt + unwrap + label cmp + agg-op',
    `sum_over_time({test_id="${testID}_logfmt"}|logfmt` +
    '|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)')

_it('logfmt + linefmt + unwrap + agg-op', async () => {
    const resp = await runRequest(`rate({test_id="${testID}"}` +
        '| line_format "str=\\"{{._entry}}\\" freq2={{div .freq 2}}"' +
        '| logfmt | unwrap freq2 [1s]) by (test_id, freq2)')
    adjustMatrixResult(resp, testID)
    resp.data.data.result.sort((a,b) => {
        return JSON.stringify(kOrder(a.metric)).localeCompare(JSON.stringify(kOrder(b.metric)))
    })
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('logfmt + linefmt + unwrap + agg-op + step', async () => {
    const resp = await runRequest(`rate({test_id="${testID}"}` +
        '| line_format "str=\\"{{._entry}}\\" freq2={{div .freq 2}}"' +
        '| logfmt | unwrap freq2 [1s]) by (test_id, freq2)', 60)
    adjustMatrixResult(resp, testID)
    resp.data.data.result.sort((a,b) => {
        return JSON.stringify(kOrder(a.metric)).localeCompare(JSON.stringify(kOrder(b.metric)))
    })
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_itShouldMatrixReq('logfmt + LRA + agg-op',
    `sum(rate({test_id="${testID}_logfmt"}| logfmt [5s])) by (test_id)`)

_itShouldMatrixReq('logfmt + unwrap + 2xagg-op',
    `sum(sum_over_time({test_id="${testID}_logfmt"}| logfmt | unwrap int_val [10s]) by (test_id, str_id)) by (test_id)`)

_itShouldMatrixReq('logfmt + unwrap + 2xagg-op + val cmp',
    `sum(sum_over_time({test_id="${testID}_logfmt"}| logfmt | unwrap str_id [10s]) by (test_id, str_id)) by (test_id) > 1000`)

_itShouldStdReq('logfmt + label cmp', `{test_id="${testID}_logfmt"} | logfmt | str_id >= 598`)

_itShouldMatrixReq({
    name: 'json + params + unwrap + agg-op + small step',
    req: `rate({test_id="${testID}_json"} | json int_val="int_val" | unwrap int_val [1m]) by (test_id)`,
    step: 0.05
})
/* TODO: not supported by qryn-go
_itShouldStdReq({
    name: `macro`,
    req: `test_macro("${testID}")`,
    limit: 2002
})
 */

_it('native linefmt', async () => {
    process.env.LINE_FMT = 'go_native'
    const resp = await runRequest(`{test_id="${testID}"}| line_format ` +
        '"{ \\"str\\":\\"{{ ._entry }}\\", \\"freq2\\": {{ .freq }} }"', null, null, null, null, 2002)
    adjustResult(resp, testID)
    resp.data.data.result.sort((a, b) => JSON.stringify(kOrder(a.stream)).localeCompare(JSON.stringify(kOrder(b.stream))))
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('handlebars linefmt', async () => {
    process.env.LINE_FMT = 'handlebars'
    const resp = await runRequest(`rate({test_id="${testID}_json"} | json int_val="int_val" | unwrap int_val [1m]) by (test_id)`,
        0.05)
    expect(resp.data.data.result.length > 0).toBeTruthy()
}, ['native linefmt'])


//_it('e2e', async () => {
    /*resp = await runRequest(`{test_id="${testID}"}`, null, null, null, "2")
    adjustResult(resp, testID)
    expect(resp.data).toMatchSnapshot()
    await otlpCheck(testID)*/
//}, ['push logs http'])

_it('read protobuff', async () => {
    const runRequest = runRequestFunc(start, end)
    const adjustResult = adjustResultFunc(start, testID)
    const resp = await runRequest(`{test_id="${testID}_PB"}`, 1, start, end)
    adjustResult(resp, testID + '_PB')
    expect(resp.data).toMatchSnapshot()
}, ['push protobuff'])

_it ('should read influx', async () => {
    let resp = await runRequest(`{test_id="${testID}FLX"}`)
    adjustResult(resp)
    expect(resp.data).toMatchSnapshot()
}, ['should send influx'])

/* TODO: rewrite using prometheus
_it ('should read prometheus.remote.write', async () => {
    let resp = await runRequest(`first_over_time({test_id="${testID}_RWR"} | unwrap_value [15s])`)
    adjustMatrixResult(resp)
    expect(resp.data).toMatchSnapshot()
}, ['should send prometheus.remote.write'])
 */

_it ('should read _ and % logs', async () => {
    let resp = await runRequest(`{test_id="${testID}_like"}`)
    adjustResult(resp)
    expect(resp.data).toMatchSnapshot()
    resp = await runRequest(`{test_id="${testID}_like"} |= "%"`)
    adjustResult(resp)
    expect(resp.data).toMatchSnapshot()
    resp = await runRequest(`{test_id="${testID}_like"} |= "_"`)
    adjustResult(resp)
    expect(resp.data).toMatchSnapshot()
}, ['should send _ and % logs'])

_it('should query_instant', async () => {
    const req = `{test_id="${testID}"}`
    const resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/query?direction=BACKWARD&limit=100&query=${encodeURIComponent(req)}&time=${end}000000`)
    adjustResult(resp)
    resp.data.data.result.sort((a,b) => JSON.stringify(kOrder(a.stream)).localeCompare(JSON.stringify(kOrder(b.stream))))
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('should query_instant vector', async () => {
    const req = `count_over_time({test_id="${testID}"}[1m])`
    const resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/query?direction=BACKWARD&limit=100&query=${encodeURIComponent(req)}&time=${end}000000`)
    resp.data.data.result.forEach(m => {
        expect(m.metric.test_id).toEqual(testID)
        m.metric.test_id = '_TEST_'
        m.value[0] -= start / 1000
    })
    resp.data.data.result.sort((a,b) => JSON.stringify(kOrder(a.metric)).localeCompare(JSON.stringify(kOrder(b.metric))))
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('should query_instant vector+internal channel', async () => {
    const req = `count_over_time({test_id="${testID}"} | line_format "{{.freq}}" [1m])`
    const resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/query?direction=BACKWARD&limit=100&query=${encodeURIComponent(req)}&time=${end}000000`)
    resp.data.data.result.forEach(m => {
        expect(m.metric.test_id).toEqual(testID)
        m.metric.test_id = '_TEST_'
        m.value[0] -= start / 1000
    })
    resp.data.data.result.sort((a,b) => JSON.stringify(kOrder(a.metric)).localeCompare(JSON.stringify(kOrder(b.metric))))
    expect(resp.data).toMatchSnapshot()
}, ['push logs http'])

_it('should read elastic log', async () => {
    const req = `{_index="test_${testID}"}`
    const resp = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/query_range?direction=BACKWARD&limit=2000&query=${encodeURIComponent(req)}&start=${start}000000&end=${Date.now()}000000`)
    resp.data.data.result.forEach(m => {
        expect(m.stream._index).toEqual('test_' + testID)
        m.stream._index = '_TEST_'
        m.values.forEach(v => {
            expect(parseInt(v[0]) / 1000000 > start).toBeTruthy()
            expect(parseInt(v[0]) / 1000000 < Date.now()).toBeTruthy()
            v[0] = ''
        })
    })
    resp.data.data.result.sort((a,b) => JSON.stringify(a.metric).localeCompare(JSON.stringify(b.metric)))
    expect(resp.data).toMatchSnapshot()
}, ['should write elastic'])

// GET

_it('should get /loki/api/v1/labels with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    let labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/labels?${fd}`)
    /* TODO not supported
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/labels?${fd}`)
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
    */
}, ['should post /api/v1/labels'])

_it('should get /loki/api/v1/label/:name/values with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    let labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/label/${testID}_LBL_LOGS/values?${fd}`)
    expect(labels.data.data).toEqual(['ok'])
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/label/${testID}_LBL_LOGS/values?${fd}`)
    /* TODO not supported
    expect(labels.data.data).toEqual([])
     */
}, ['should post /api/v1/labels'])

_it('should get /loki/api/v1/label with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 1 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    let labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/label?${fd}`)
    expect(labels.data.data.find(d => d===`${testID}_LBL_LOGS`)).toBeTruthy()
    /* TODO not supported
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/label?${fd}`)
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
     */
}, ['should post /api/v1/labels'])

_it('should get /loki/api/v1/series with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 1 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    fd.append("match[]", `{test_id="${testID}"}`)
    let labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/series?${fd}`)
    expect(labels.data.data && labels.data.data.length).toBeTruthy()
    /* TODO not supported
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    fd.append("match[]", `{test_id="${testID}"}`)
    labels = await axiosGet(`http://${clokiExtUrl}/loki/api/v1/series?${fd}`)
    expect(labels.data.data && labels.data.data.length).toBeFalsy()

     */
}, ['push logs http'])
/* TODO not supported by qryn-go
_it('should response CSV', async () => {
    let req = `{test_id="${testID}"}`
    let res = await axiosGet(
        `http://${clokiExtUrl}/loki/api/v1/query_range?direction=BACKWARD&limit=${100}&query=${encodeURIComponent(req)}&start=${start}000000&end=${end}000000&step=1&csv=1`
    );
    let data = res.data
        .replace(/^\d+,/gm, (str) => (parseInt(str.substring(0, str.length-1)) / 1000000 - start)+',')
        .replace(new RegExp(testID, 'g'), "test_id");
    expect(data).toMatchSnapshot()
}, ['push logs http'])

_it('should response CSV matrix', async () => {
    const req = `rate({test_id="${testID}"}[10s])`
    const res = await axiosGet(
        `http://${clokiExtUrl}/loki/api/v1/query_range?direction=BACKWARD&limit=${100}&query=${encodeURIComponent(req)}&start=${start}000000&end=${end}000000&step=1&csv=1`
    )
    const data = res.data
        .replace(/^\d+,/gm, (str) => (parseInt(str.substring(0, str.length-1)) / 1000000 - start)+',')
        .replace(new RegExp(testID, 'g'), "test_id")
    expect(data).toMatchSnapshot()
}, ['push logs http'])

_itShouldStdReq({
    name: 'should read newrelic',
    req: `{test_id="${testID}_newrelic"}`,
    deps: ['should send newrelic']
})
*/
_itShouldMatrixReq('topk', `topk(1, rate({test_id="${testID}"}[5s]))`)

_itShouldMatrixReq('topk + sum',
    `topk(1, sum(count_over_time({test_id="${testID}"}[5s])) by (test_id))`)

_itShouldMatrixReq('topk + unwrap',
    `topk(1, sum_over_time({test_id="${testID}_json"} | json f="int_val" | unwrap f [5s]) by (test_id))`)

_itShouldMatrixReq('topk + unwrap + sum',
    `topk(1, sum(sum_over_time({test_id=~"${testID}_json"} | json f="int_val" | unwrap f [5s])) by (test_id))`)

_itShouldMatrixReq('bottomk', `bottomk(1, rate({test_id="${testID}"}[5s]))`)

_itShouldMatrixReq('quantile',
    `quantile_over_time(0.5, {test_id=~"${testID}_json"} | json f="int_val" | unwrap f [5s]) by (test_id)`)

//--- POST
/* TODO not supported
_it('should post /loki/api/v1/labels with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    let labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
}, ['should post /api/v1/labels'])



_it('should post /loki/api/v1/label/:name/values with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    let labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/label/${testID}_LBL/values`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data).toEqual(['ok'])
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/label/${testID}_LBL/values`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data).toEqual([])
}, ['should post /api/v1/labels'])

*/

/* TODO: implement _it('should post /loki/api/v1/label with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 1 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    let labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/label`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/label`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeFalsy()
}, ['should post /api/v1/labels']) */

/* TODO: _it('should post /loki/api/v1/series with time context', async () => {
    let fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 3600 * 1000}000000`)
    fd.append("end", `${Date.now()}000000`)
    fd.append("match[]", `{test_id="${testID}"}`)
    let labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/series`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeTruthy()
    fd = new URLSearchParams()
    fd.append("start", `${Date.now() - 25 * 3600 * 1000}000000`)
    fd.append("end", `${Date.now() - 24 * 3600 * 1000}000000`)
    fd.append("match[]", `{test_id="${testID}"}`)
    labels = await axiosPost(`http://${clokiExtUrl}/loki/api/v1/series`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded'
        }
    })
    expect(labels.data.data && labels.data.data.length).toBeFalsy()
}, ['push logs http'])*/

_it('should read datadog logs', async () => {
    const runRequest = runRequestFunc(start, Date.now())
    const resp = await runRequest(`{ddsource="ddtest_${testID}"}`, 1, start, Date.now())
    resp.data.data.result.forEach(r => {
        expect(r.stream.ddsource).toEqual(`ddtest_${testID}`)
        r.stream.ddsource = ''
        r.values.forEach(v => { v[0] = 0 })
    })
    expect(resp.data.data.result && resp.data.data.result.length).toBeTruthy()
    expect(resp.data).toMatchSnapshot();
}, ['should send datadog logs'])

/* TODO rewrite using prometheus api
_itShouldMatrixReq({
    name: 'read datadog metrics',
    req: `first_over_time({__name__="DDMetric", test_id="${testID}_DDMetric"} | unwrap_value [15s])`,
    deps: ['should send datadog metrics'],
    testID: `${testID}_DDMetric`
  })
*/

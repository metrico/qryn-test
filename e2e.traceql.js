const {
    _it,
    axiosGet,
    axiosPost,
    clokiExtUrl,
    clokiWriteUrl,
    start,
    end,
    testID} = require("./common");

const tracePrefix = (parseInt(testID.substring(2)).toString(16) + '00000000000000000000000000000')
    .substring(0, 29)

_it("traceql: initialize", async () => {
    const traces = []

    const iTestID = parseInt(testID.substring(2))

    for (let i = start; i < end; i+=600) {
        const traceN = Math.floor((i-start) / 600 / 10)
        const spanN = Math.floor((i-start) / 600) % 10
        const traceId = (iTestID.toString(16) + '00000000000000000000000000000').substring(0, 29) +
            ('000' + traceN.toString(16)).substr(-3)
        const spanId = ('0000000000000000' + spanN).substr(-16)
        const trace = {
            id: spanId,
            traceId: traceId,
            timestamp: i + '000',
            duration: (1000 * spanN) + '',
            name: 'span from http#' + spanN,
            tags: {
                'tag-with-dash': 'value-with-dash',
                'http.method': 'GET',
                'http.path': '/api',
                'testId': testID,
                'spanN': spanN + '',
                'traceN': traceN + ''
            },
            localEndpoint: {
                serviceName: 'node script'
            }
        }
        traces.push(trace)
    }

    await axiosPost('http://' + clokiWriteUrl + "/tempo/spans", JSON.stringify(traces), {
        headers: {
            'Content-Type': 'application/json',
            'X-Scope-OrgID': '2'
        }
    })
    await new Promise(r => setTimeout(r, 1000))
})

const _itShouldTraceQL = (name, q, conf) => {
    conf = {
        start: Math.floor(start / 1000),
        end: Math.floor(end/1000)+1,
        limit: 5,
        q: q,
      ...conf
    }
    _it(name, async () => {
        const req = 'http://' + clokiExtUrl + '/api/search'+
            `?start=${conf.start}&end=${conf.end}` +
            `&q=${encodeURIComponent(conf.q)}` +
            `&limit=${conf.limit}`
        console.log(req)
        const res = await axiosGet(req, {headers:{'X-Scope-OrgID': '2'}})
        res.data.traces.forEach(t => {
            expect(t.traceID.substring(0, 29)).toEqual(tracePrefix)
            t.traceID = t.traceID.substring(29)
            t.startTimeUnixNano = (BigInt(t.startTimeUnixNano) - (BigInt(start) * 1000000n)).toString()
            t.spanSets.forEach(s => s.spans.forEach(s => {
                s.startTimeUnixNano = (BigInt(s.startTimeUnixNano) - (BigInt(start) * 1000000n)).toString()
            }))
        })
        expect(res.data).toMatchSnapshot()
    })
}

const _itShouldTraceQLTest = (name, q, conf) => {
    conf = {
        start: Math.floor(start / 1000),
        end: Math.floor(end/1000),
        limit: 5,
        q: q,
        ...conf
    }
    _it(name, async () => {
        const req = 'http://' + clokiExtUrl + '/api/search'+
            `?start=${conf.start}&end=${conf.end}` +
            `&q=${encodeURIComponent(conf.q)}` +
            `&limit=${conf.limit}`
        console.log(req)
        const res = await axiosGet(req, {headers:{'X-Scope-OrgID': '2'}})
        res.data.traces.forEach(t => {
            expect(t.traceID.substring(0, 29)).toEqual(tracePrefix)
            t.traceID = t.traceID.substring(29)
            t.startTimeUnixNano = (BigInt(t.startTimeUnixNano) - (BigInt(start) * 1000000n)).toString()
            t.spanSet.spans.forEach(s => {
                s.startTimeUnixNano = (BigInt(s.startTimeUnixNano) - (BigInt(start) * 1000000n)).toString()
            })
        })
        console.log(res.data)
    })
}

_itShouldTraceQL("traceql: one selector", `{.testId="${testID}"}`)
_itShouldTraceQL("traceql: multiple selectors", `{.testId="${testID}" && .spanN=9}`)
_itShouldTraceQL("traceql: multiple selectors OR Brackets", `{.testId="${testID}" && (.spanN=9 || .spanN=8)}`)
_itShouldTraceQL("traceql: multiple selectors regexp", `{.testId="${testID}" && .spanN=~"(9|8)"}`)
_itShouldTraceQL("traceql: duration", `{.testId="${testID}" && duration>=9ms}`)
_itShouldTraceQL("traceql: float comparison", `{.testId="${testID}" && .spanN>=8.9}`)
_itShouldTraceQL("traceql: count empty result", `{.testId="${testID}" && .spanN>=8.9} | count() > 1`)
_itShouldTraceQL("traceql: count", `{.testId="${testID}" && .spanN>=8.9} | count() > 0`)
_itShouldTraceQL("traceql: max duration empty result", `{.testId="${testID}"} | max(duration) > 9ms`)
_itShouldTraceQL("traceql: max duration", `{.testId="${testID}"} | max(duration) > 8ms`)
_itShouldTraceQL("traceql: tags with dash", `{.testId="${testID}" && .tag-with-dash="value-with-dash"} | max(duration) > 8ms`)

_it("traceql: hammering selectors", async () => {
    for (const op of ['=', '!=', '=~', '!~']) {
        const conf = {
            start: Math.floor(start / 1000),
            end: Math.floor(end/1000),
            limit: 5,
            q: `{.testId="${testID}" && .spanN${op}"5"}`,
        }
        const req = 'http://' + clokiExtUrl + '/api/search'+
            `?start=${conf.start}&end=${conf.end}` +
            `&q=${encodeURIComponent(conf.q)}` +
            `&limit=${conf.limit}`
        console.log(req)
        const res = await axiosGet(req, {headers:{'X-Scope-OrgID': '2'}})
        expect(res.data.traces.length>0).toBeTruthy()
    }
    for (const op of ['>', '<', '=', '!=', '>=', '<=']) {
        const conf = {
            start: Math.floor(start / 1000),
            end: Math.floor(end/1000),
            limit: 5,
            q: `{.testId="${testID}" && .spanN${op}5}`,
        }
        const req = 'http://' + clokiExtUrl + '/api/search'+
            `?start=${conf.start}&end=${conf.end}` +
            `&q=${encodeURIComponent(conf.q)}` +
            `&limit=${conf.limit}`
        console.log(req)
        const res = await axiosGet(req, {headers:{'X-Scope-OrgID': '2'}})
        expect(res.data.traces.length>0).toBeTruthy()
    }
})

_it("traceql: hammering aggregators", async () => {
    for (const op of ['>', '<', '=', '!=', '>=', '<=']) {
        for (const agg of ['count()', 'avg(spanN)','max(spanN)','min(spanN)','sum(spanN)'] ) {
            const conf= {
                start: Math.floor(start / 1000),
                end: Math.floor(end/1000),
                limit: 5,
                q: `{.testId="${testID}"} | ${agg} ${op} -1`,
            }
            console.log(conf.q)
            const req = 'http://' + clokiExtUrl + '/api/search'+
                `?start=${conf.start}&end=${conf.end}` +
                `&q=${encodeURIComponent(conf.q)}` +
                `&limit=${conf.limit}`
            console.log(req)
            const res = await axiosGet(req, {headers:{'X-Scope-OrgID': '2'}})
            expect(res.data.traces.length === 0 ||
                (res.data.traces.length !== 0 && (op === '>' || op === '>=' || op === '!='))).toBeTruthy()
        }

    }
})
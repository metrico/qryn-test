const {_it, axiosGet, clokiExtUrl, storage} = require("./common");

_it('should read otlp', async () => {
    const span = storage.test_span
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/${span.spanContext().traceId.toUpperCase()}`)
    const data = res.data
    data.resourceSpans[0].instrumentationLibrarySpans[0].spans[0].attributes.sort((a,b) => a.key.localeCompare(b.key))
    const validation = data.resourceSpans[0].instrumentationLibrarySpans[0].spans[0]
    delete validation.traceID
    delete validation.traceId
    delete validation.spanID
    delete validation.spanId
    delete validation.startTimeUnixNano
    delete validation.endTimeUnixNano
    delete validation.events[0].timeUnixNano
    expect(validation).toMatchSnapshot()
}, ['should send otlp'])

_it('should read zipkin', async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/d6e9329d67b6146c0000000000000000`)
//D6E9329D67B6146C0000000000000000
//d6e9329d67b6146c0000000000000000
    console.log(res.data)
    const data = res.data
    const validation = data.resourceSpans[0].instrumentationLibrarySpans[0].spans[0]
    expect(validation.spanID).toEqual('1234ef4500000000')
    delete validation.traceID
    delete validation.spanID
    delete validation.spanId
    delete validation.startTimeUnixNano
    delete validation.endTimeUnixNano
    expect(validation).toMatchSnapshot()
}, ['should send zipkin'])


_it('should read /tempo/spans', async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/d6e9329d67b6146d0000000000000000`)
    console.log(res.data)
    const data = res.data
    const validation = data.resourceSpans[0].instrumentationLibrarySpans[0].spans[0]
    expect(validation.spanID).toEqual('1234ef4600000000')
    delete validation.traceID
    delete validation.spanID
    delete validation.spanId
    delete validation.startTimeUnixNano
    delete validation.endTimeUnixNano
    expect(validation).toMatchSnapshot()
}, ['should post /tempo/spans'])

_it('should read /api/v2/spans', async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/d6e9329d67b6146e0000000000000000`)
    const data = res.data
    const validation = data.resourceSpans[0].instrumentationLibrarySpans[0].spans[0]
    expect(validation.spanID).toEqual('1234ef4600000000')
    delete validation.traceID
    delete validation.spanID
    delete validation.spanId
    delete validation.startTimeUnixNano
    delete validation.endTimeUnixNano
    expect(validation).toMatchSnapshot()
}, ['should post /tempo/spans'])

_it('should read /tempo/api/search/tags', async () => {
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/search/tags`)
    const data = res.data
    for (const tagname of ['http.method', 'http.path', 'service.name', 'name']) {
        expect(data.tagNames.find(t => t === tagname)).toBeTruthy();
    }
}, ['should post /tempo/spans', 'should send zipkin', 'should post /tempo/spans'])

_it('should read /tempo/api/search/tag/.../values', async () => {
    for (const tagname of [['http.method', 'GET'],
        ['http.path', '/tempo/spans'],
        ['service.name', 'node script'],
        ['name', 'span from http']]) {
        console.log(`http://${clokiExtUrl}/tempo/api/search/tag/${tagname[0]}/values`)
        const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/search/tag/${tagname[0]}/values`)
        const data = res.data.tagValues
        console.log(data)
        expect(data.find(t => t === tagname[1])).toBeTruthy();
    }
}, ['should post /tempo/spans', 'should send zipkin', 'should post /tempo/spans'])

_it('should get /tempo/api/search', async () => {
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/search?tags=${
        encodeURIComponent('service.name="node script"')
    }&minDuration=900ms&maxDuration=1100ms&start=${Math.floor(Date.now() / 1000) - 600}&end=${Math.floor(Date.now() / 1000)}`)
    console.log(`http://${clokiExtUrl}/tempo/api/search?tags=${
        encodeURIComponent('service.name="node script"')
    }&minDuration=900ms&maxDuration=1100ms&start=${Math.floor(Date.now() / 1000) - 600}&end=${Math.floor(Date.now() / 1000)}`)
    const data = res.data.traces[0]
    delete data['startTimeUnixNano']
    expect(data).toMatchSnapshot()
}, ['should post /tempo/spans', 'should send zipkin', 'should post /tempo/spans'])

_it('should get /tempo/api/echo', async () => {
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/echo`)
    const data = res.data
    expect(data).toEqual('echo')
})



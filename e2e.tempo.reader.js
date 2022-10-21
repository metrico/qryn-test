const {_it, axiosGet, clokiExtUrl, storage} = require("./common");

_it('should read otlp', async () => {
    const span = storage.test_span
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/${span.spanContext().traceId.toUpperCase()}`)
    const data = res.data
    data.resource_spans[0].scope_spans[0].spans[0].Span.attributes.sort((a,b) => a.key.localeCompare(b.key))
    delete data.resource_spans[0].scope_spans[0].spans[0].Span.trace_id
    delete data.resource_spans[0].scope_spans[0].spans[0].Span.span_id
    delete data.resource_spans[0].scope_spans[0].spans[0].Span.start_time_unix_nano
    delete data.resource_spans[0].scope_spans[0].spans[0].Span.end_time_unix_nano
    delete data.resource_spans[0].scope_spans[0].spans[0].Span.events[0].time_unix_nano
    expect(data).toMatchSnapshot()
}, ['should send otlp'])

_it('should read zipkin', async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/d6e9329d67b6146c0000000000000000`)
    console.log(res.data)
    const data = res.data
    const validation = data.resource_spans[0].scope_spans[0].spans[0]
    delete validation.Span.start_time_unix_nano
    delete validation.Span.end_time_unix_nano
    expect(validation).toMatchSnapshot()
}, ['should send zipkin'])

_it('should read /tempo/spans', async () => {
    await new Promise(resolve => setTimeout(resolve, 500))
    const res = await axiosGet(`http://${clokiExtUrl}/tempo/api/traces/d6e9329d67b6146d0000000000000000`)
    console.log(res.data)
    const data = res.data
    const validation = data.resource_spans[0].scope_spans[0].spans[0]
    delete validation.Span.start_time_unix_nano
    delete validation.Span.end_time_unix_nano
    expect(validation).toMatchSnapshot()
}, ['should post /tempo/spans'])

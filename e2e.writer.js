const {_it, createPoints, sendPoints, clokiWriteUrl, testID, start, end, storage} = require('./common')
const protobufjs = require("protobufjs");
const path = require("path");
const axios = require("axios");
const {Point} = require("@influxdata/influxdb-client");
const {pushTimeseries} = require("prometheus-remote-write");


_it('push logs http', async () => {
    console.log(testID)
    let points = createPoints(testID, 0.5, start, end, {}, {})
    points = createPoints(testID, 1, start, end, {}, points)
    points = createPoints(testID, 2, start, end, {}, points)
    points = createPoints(testID, 4, start, end, {}, points)

    points = createPoints(testID + '_json', 1, start, end,
        { fmt: 'json', lbl_repl: 'val_repl', int_lbl: '1' }, points,
        (i) => JSON.stringify({ lbl_repl: 'REPL', int_val: '1', new_lbl: 'new_val', str_id: i, arr: [1, 2, 3], obj: { o_1: 'v_1' } })
    )
    points = createPoints(testID + '_metrics', 1, start, end,
        { fmt: 'int', lbl_repl: 'val_repl', int_lbl: '1' }, points,
        (i) => '',
        (i) => i % 10
    )
    points = createPoints(testID + '_logfmt', 1, start, end,
        { fmt: 'logfmt', lbl_repl: 'val_repl', int_lbl: '1' }, points,
        (i) => 'lbl_repl="REPL" int_val=1 new_lbl="new_val" str_id="' + i + '" '
    )
    await sendPoints(`http://${clokiWriteUrl}`, points)
    await new Promise(resolve => setTimeout(resolve, 4000))
})

_it('push protobuff', async () => {
    const PushRequest = protobufjs
        .loadSync(path.join(__dirname, './loki.proto'))
        .lookupType('PushRequest')
    let points = createPoints(testID+'_PB', 0.5, start, end, {}, {})
    points = {
        streams: Object.values(points).map(stream => {
            return {
                labels: '{' + Object.entries(stream.stream).map(s => `${s[0]}=${JSON.stringify(s[1])}`).join(',') + '}',
                entries: stream.values.map(v => ({
                    timestamp: { seconds: Math.floor(parseInt(v[0]) / 1e9).toString(), nanos: parseInt(v[0]) % 1e9 },
                    line: v[1]
                }))
            }
        })
    }
    let body = PushRequest.encode(points).finish()
    body = require('snappyjs').compress(body)
    await axios.post(`http://${clokiWriteUrl}/loki/api/v1/push`, body, {
        headers: { 'Content-Type': 'application/x-protobuf', 'X-Scope-OrgID': '1'}
    })
    await new Promise(f => setTimeout(f, 500))
})

_it('should send otlp', async () => {
    const opentelemetry = require('@opentelemetry/api');

    const { diag, DiagConsoleLogger, DiagLogLevel } = opentelemetry;
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.INFO);

    const { Resource } = require('@opentelemetry/resources');
    const { ResourceAttributes: SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
    const { registerInstrumentations } = require('@opentelemetry/instrumentation');
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');

    const { ConnectInstrumentation } = require('@opentelemetry/instrumentation-connect');
    const { HttpInstrumentation } = require('@opentelemetry/instrumentation-http');

    const provider = new NodeTracerProvider({
        resource: new Resource({
            'service.name': 'testSvc',
        }),
    });
    const connectInstrumentation = new ConnectInstrumentation();
    registerInstrumentations({
        tracerProvider: provider,
        instrumentations: [
            // Connect instrumentation expects HTTP layer to be instrumented
            HttpInstrumentation,
            connectInstrumentation,
        ],
    });

    const exporter = new OTLPTraceExporter({
        headers: {
            'X-Scope-OrgID': '1'
        },
        url: 'http://' + clokiWriteUrl + '/v1/traces'
    });

    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

    // Initialize the OpenTelemetry APIs to use the NodeTracerProvider bindings
    provider.register({});
    const tracer = opentelemetry.trace.getTracer('connect-example');

    const span = tracer.startSpan('test_span', {
        attributes: {testId: '__TEST__'}
    })
    await new Promise(f => setTimeout(f, 100));
    span.addEvent('test event', new Date())
    span.end();
    storage.test_span = span
    await new Promise(f => setTimeout(f, 500))
})

_it('should send zipkin', async () => {
    // Send Tempo data and expect status code 200
    const obj = {
        id: '1234ef45',
        traceId: 'd6e9329d67b6146c',
        timestamp: (Date.now() * 1000) + '',
        duration: 1000 + '',
        name: 'span from http',
        tags: {
            'http.method': 'GET',
            'http.path': '/api'
        },
        localEndpoint: {
            serviceName: 'node script'
        }
    }

    const arr = [obj]
    const data = JSON.stringify(arr)
    console.log(data)
    const url = `http://${clokiWriteUrl}/tempo/api/push`
    console.log(url)

    const test = await axios.post(url, data, {
        headers: {
            "X-Scope-OrgID": '1'
        }
    })
    expect(test.status).toEqual(202)
    console.log('Tempo Insertion Successful')
})

_it('should post /tempo/spans', async () => {
    // Send Tempo data and expect status code 200
    const obj = {
        id: '1234ef46',
        traceId: 'd6e9329d67b6146d',
        timestamp: Date.now() * 1000,
        duration: 1000,
        name: 'span from http',
        tags: {
            'http.method': 'GET',
            'http.path': '/tempo/spans'
        },
        localEndpoint: {
            serviceName: 'node script'
        }
    }

    const arr = [obj]
    const data = JSON.stringify(arr)
    console.log(data)
    const url = `http://${clokiWriteUrl}/tempo/spans`
    console.log(url)

    const test = await axios.post(url, data, {
        headers: {
            "X-Scope-OrgID": '1'
        }
    })
    expect(test.status).toEqual(202)
    console.log('Tempo Insertion Successful')
})

_it('should send influx', async () => {
    const {InfluxDB, Point} = require('@influxdata/influxdb-client')
    const writeAPI = new InfluxDB({
        url: `http://${clokiWriteUrl}/influx`,
        headers: {
            'X-Scope-OrgID': 1,
            'X-Sender': 'influx'
        }
    }).getWriteApi('', '', 'ns')
    writeAPI.useDefaultTags({'test_id': testID + 'FLX'})
    const points = []
    for (let i = start; i < end; i += 60000) {
        points.push(new Point('syslog')
            .tag('tag1', 'val1')
            .stringField('message', 'FLX_TEST')
            .timestamp(new Date(i)))
    }
    writeAPI.writePoints(points)
    await writeAPI.close()
})

_it('should send prometheus.remote.write', async () => {
    const {pushTimeseries} = require('prometheus-remote-write')
    const fetch = require('node-fetch')
    const ts = []
    for (const route of ['v1/prom/remote/write',
        'api/v1/prom/remote/write',
        'prom/remote/write',
        'api/prom/remote/write']) {
        for (let i = start; i < end; i += 15000) {
            ts.push({
                labels: {
                    __name__: "test_metric",
                    test_id: testID + '_RWR',
                    route: route,
                },
                samples: [
                    {
                        value: 123,
                        timestamp: i,
                    },
                ],
            })
        }
        const res = await pushTimeseries(ts, {
            url: `http://${clokiWriteUrl}/${route}`,
            fetch: (input, opts) => {
                opts.headers['X-Scope-OrgID'] = '1'
                return fetch(input, opts)
            }
        })
        expect(res.status).toEqual(204)
    }
    await new Promise(f => setTimeout(f, 500))
})

_it('should /api/v2/spans', async () => {
    // Send Tempo data and expect status code 200
    const obj = {
        id: '1234ef46',
        traceId: 'd6e9329d67b6146e',
        timestamp: Date.now() * 1000,
        duration: 1000000,
        name: 'span from http',
        tags: {
            'http.method': 'GET',
            'http.path': '/tempo/spans'
        },
        localEndpoint: {
            serviceName: 'node script'
        }
    }

    const arr = [obj]
    const data = JSON.stringify(arr)
    console.log(data)
    const url = `http://${clokiWriteUrl}/tempo/spans`
    console.log(url)

    const test = await axios.post(url, data, {
        headers: {
            "X-Scope-OrgID": '1'
        }
    })
    console.log('Tempo Insertion Successful')
})

_it('should send _ and % logs', async () => {
    let points = createPoints(testID+"_like", 150, start, end, {}, {},
        (i) => i % 2 ? "l_p%": "l1p2")
    await sendPoints(`http://${clokiWriteUrl}`, points)
    await new Promise(resolve => setTimeout(resolve, 1000))
})

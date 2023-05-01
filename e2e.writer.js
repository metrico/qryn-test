const {_it, createPoints, sendPoints, clokiWriteUrl, testID, start, end, storage, shard, clokiExtUrl, axiosPost,
    extraHeaders
} = require('./common')
const protobufjs = require("protobufjs");
const path = require("path");
const axios = require("axios");
const {Point} = require("@influxdata/influxdb-client");
const {pushTimeseries} = require("prometheus-remote-write");
const fetch = require("node-fetch");

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
    await axiosPost(`http://${clokiWriteUrl}/loki/api/v1/push`, body, {
        headers: {
            'Content-Type': 'application/x-protobuf',
            'X-Scope-OrgID': '1',
            'X-Shard': shard
        }
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
            'X-Scope-OrgID': '1',
            'X-Shard': shard,
            ...extraHeaders
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

    const test = await axiosPost(url, data, {
        headers: {
            "X-Scope-OrgID": '1',
            'X-Shard': shard
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

    const test = await axiosPost(url, data, {
        headers: {
            "X-Scope-OrgID": '1',
            'X-Shard': shard
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
            'X-Sender': 'influx',
            'X-Shard': shard,
            ...extraHeaders
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
                opts.headers['X-Shard'] = shard
                opts.headers = {
                    ...opts.headers,
                    ...extraHeaders
                }
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

    const test = await axiosPost(url, data, {
        headers: {
            "X-Scope-OrgID": '1',
            'X-Shard': shard
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

_it('should write elastic', async () => {
    const { Client } = require('@elastic/elasticsearch')
    const client = new Client({
        node: `http://${clokiWriteUrl}`,
        headers: {
            'X-Scope-OrgID': '1',
            ...extraHeaders
        }
    })
    const resp = await client.bulk({
        refresh: true,

        operations: [
            {index: {_index: `test_${testID}`}},
            {id: 1, text: 'If I fall, don\'t bring me back.', user: 'jon'},
            {index: {_index: `test_${testID}`}},
            {id: 2, text: 'Winter is coming', user: 'ned'},
            {index: {_index: `test_${testID}`}},
            {id: 3, text: 'A Lannister always pays his debts.', user: 'tyrion'},
            {index: {_index: `test_${testID}`}},
            {id: 4, text: 'I am the blood of the dragon.', user: 'daenerys'},
            {index: {_index: `test_${testID}`}},
            {id: 5, text: 'A girl is Arya Stark of Winterfell. And I\'m going home.', user: 'arya'}
        ]
    })
    expect(resp.errors).toBeFalsy()
})

_it('should post /api/v1/labels', async () => {
    const {pushTimeseries} = require('prometheus-remote-write')
    const res = await pushTimeseries({
        labels: {
            [`${testID}_LBL`]: 'ok'
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
            opts.headers = {
                ...opts.headers,
                ...extraHeaders
            }
            return fetch(input, opts)
        }
    })
    expect(res.status).toEqual(204)
    const fd = new URLSearchParams()
    await new Promise(resolve => setTimeout(resolve, 1000))
    fd.append('start', `${Math.floor(Date.now() / 1000) - 10}`)
    fd.append('end', `${Math.floor(Date.now() / 1000)}`)
    const labels = await axiosPost(`http://${clokiExtUrl}/api/v1/labels`, fd, {
        headers: {
            'X-Scope-OrgID': '1',
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Shard': shard
        }
    })
    expect(labels.data.data.find(d => d===`${testID}_LBL`)).toBeTruthy()
})

_it('should post /loki/api/v1/labels', async () => {
    await sendPoints(`http://${clokiWriteUrl}`, {
        1: {
            stream: {
                [`${testID}_LOG_LBL`]: 'ok'
            },
            values: [[`${start+1}000000`, 'qweqwe']]
        }
    })
})

_it('should send broken labels', async () => {
    await sendPoints(`http://${clokiWriteUrl}`, {
        'a': {
            stream: Object.fromEntries([[`0.${testID}`, 'l123']]),
            values: [[`${start+1}000000`, 'TEST!!!']]
        }
    })
})

_it('should send datadog logs', async () => {
    const resp = await axiosPost(`http://${clokiWriteUrl}/api/v2/logs`, JSON.stringify([
        {
            "ddsource": `ddtest_${testID}`,
            "ddtags": "env:staging,version:5.1",
            "hostname": "i-012345678",
            "message": "2019-11-19T14:37:58,995 INFO [process.name][20081] Hello World",
            "service": "payment"
        }
    ]), {
        headers: {
            'Content-Type': 'application/json',
            'X-Scope-OrgID': '1'
        }
    });
    expect(resp.status).toEqual(202)
    await new Promise(f => setTimeout(f, 500))
})

_it('should send datadog metrics', async () => {
    try {
        const resp = await axiosPost(`http://${clokiWriteUrl}/api/v2/series`, JSON.stringify({
            "series": [
                {
                    "metric": `DDMetric_${testID}`,
                    "type": 0,
                    "points": [
                        {
                            "timestamp": Math.floor(Date.now() / 1000),
                            "value": 0.7
                        }
                    ],
                    "resources": [
                        {
                            "name": "dummyhost",
                            "type": "host"
                        }
                    ]
                }
            ]
        }), {
            headers: {
                'Content-Type': 'application/json',
                'X-Scope-OrgID': '1'
            }
        });
        expect(resp.status).toEqual(202)
        await new Promise(f => setTimeout(f, 500))
    } catch (e) {
        console.log(JSON.stringify(e.response));
        throw e;
    }
})

_it('should send cf logs', async () => {
    const resp = await axiosPost(`http://${clokiWriteUrl}/cf/v1/insert?ddsource=ddtest_${testID}_CF`, JSON.stringify({
        "DispatchNamespace": "",
        "Event": {
            "RayID": "7a036192bc93eb57",
            "Request": {
                "Method": "POST",
                "URL": "https://cflogs.a.b/"
            },
            "Response": {
                "Status": 500
            }
        },
        "EventTimestampMs": Date.now(),
        "EventType": "fetch",
        "Exceptions": [],
        "Logs": [
            {
                "Level": "log",
                "Message": [
                    "Agent v 1.0.5 handling request"
                ],
                "TimestampMs": 1677526710198
            }
        ],
        "Outcome": "ok",
        "ScriptName": "qryn-edgerouter-cf",
        "ScriptTags": []
    }), {
        headers: {
            'X-Scope-OrgID': '1'
        }
    });
    expect(resp.status).toEqual(200)
    await new Promise(f => setTimeout(f, 500))
})

package e2e_tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/grafana/loki/pkg/push"
	influxdb2 "github.com/influxdata/influxdb-client-go/v2"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/prometheus/prometheus/prompb"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.17.0"
	"go.opentelemetry.io/otel/trace"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"
)

var (
	Shard string
	//ExtraHeaders     map[string]string

	writingCompleted bool
	orderMutex       sync.Mutex
)

func init() {
	// Initialize variables

	Shard = "default"
	//	initExtraHeaders()
	//storage = make(map[string]interface{})
}

// Global variables to track test execution order
var (
	executionOrder []string
)

// recordExecution records the order of test execution
func recordExecution(testName string) {
	orderMutex.Lock()
	defer orderMutex.Unlock()
	executionOrder = append(executionOrder, testName)
	fmt.Printf("Executed test: %s\n", testName)
}

// Main test suite definition using Ginkgo's Ordered to enforce sequential execution between suites
func writingTests() {
	// WritingTests suite runs first
	Context("Writing Tests", func() {
		// Verify that writingCompleted is false at the beginning of WritingTests
		BeforeEach(func() {
			Expect(writingCompleted).To(BeFalse(), "Writing tests should run before being marked as completed")
		})
		It("push logs http", func(ctx context.Context) {
			testName := "push-logs-http"
			recordExecution(testName)

			Points := CreatePoints(testID+"_json", 1, start, end, map[string]string{}, nil, nil, nil)
			Points = CreatePoints(testID, 2, start, end, map[string]string{}, nil, nil, nil)
			Points = CreatePoints(testID, 3, start, end, map[string]string{}, nil, nil, nil)
			Points = CreatePoints(testID, 4, start, end, map[string]string{}, nil, nil, nil)

			// JSON format logs
			Points = CreatePoints(testID+"_json", 1, start, end,
				map[string]string{"fmt": "json", "lbl_repl": "val_repl", "int_lbl": "1"},
				Points,
				func(i int) string {
					return fmt.Sprintf(`{"lbl_repl":"REPL","int_val":"1","new_lbl":"new_val","str_id":%d,"arr":[1,2,3],"obj":{"o_1":"v_1"}}`, i)
				},
				nil,
			)

			Points = CreatePoints(testID+"_logfmt", 1, start, end,
				map[string]string{"fmt": "logfmt", "lbl_repl": "val_repl", "int_lbl": "1"},
				Points,
				func(i int) string {
					return fmt.Sprintf(`lbl_repl="REPL" int_val=1 new_lbl="new_val" str_id="%d"`, i)
				},
				nil,
			)

			resp, err := SendPoints(fmt.Sprintf("http://%s", gigaPipeWriteUrl), Points)
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusNoContent))

			// Allow time for logs to be processed
			time.Sleep(4 * time.Second)
		}, NodeTimeout(30*time.Second))

		It("push protobuff", func() {
			testName := "push-protobuff"
			recordExecution(testName)

			points := CreatePoints(testID+"_PB", 1, start, end, map[string]string{}, nil, nil, nil)

			var streams []push.Stream

			for _, point := range points {
				labelParts := []string{}
				for _, label := range point.Labels {
					labelParts = append(labelParts, fmt.Sprintf(`%s="%s"`, label.Name, label.Value))
				}
				labels := "{" + strings.Join(labelParts, ",") + "}"

				var entries []push.Entry
				for _, sample := range point.Samples {
					entries = append(entries, push.Entry{
						Timestamp: time.Unix(0, sample.Timestamp), // sample.Timestamp is in nanoseconds
						Line:      fmt.Sprintf("%f", sample.Value),
					})
				}

				streams = append(streams, push.Stream{
					Labels:  labels,
					Entries: entries,
				})
			}

			req := &push.PushRequest{
				Streams: streams,
			}

			url := fmt.Sprintf("http://%s/loki/api/v1/push", gigaPipeWriteUrl)

			resp, err := SendProtobufRequest(url, req, 30*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusNoContent))
			time.Sleep(500 * time.Millisecond)
			fmt.Println("Protobuf push successful")
		})

		It("should send otlp", func(ctx context.Context) {

			// Create resource with service name
			res := resource.NewWithAttributes(
				semconv.SchemaURL,
				semconv.ServiceNameKey.String("testSvc"),
			)

			// Prepare headers for OTLP exporter
			headers := map[string]string{
				"X-Scope-OrgID": "1",
				"X-Shard":       "default",
			}

			// Add extra headers
			for k, v := range ExtraHeaders {
				headers[k] = v
			}

			// Create OTLP HTTP exporter
			client := otlptracehttp.NewClient(
				otlptracehttp.WithEndpoint(gigaPipeWriteUrl),
				otlptracehttp.WithURLPath("/v1/traces"),
				otlptracehttp.WithHeaders(headers),
				otlptracehttp.WithInsecure(), // Use this for HTTP, remove for HTTPS
			)

			exporter, err := otlptrace.New(ctx, client)
			Expect(err).NotTo(HaveOccurred())

			// Create tracer provider with simple span processor
			tp := sdktrace.NewTracerProvider(
				sdktrace.WithResource(res),
				sdktrace.WithSpanProcessor(sdktrace.NewSimpleSpanProcessor(exporter)),
			)

			// Register the tracer provider globally
			otel.SetTracerProvider(tp)

			// Get tracer instance
			tracer := otel.Tracer("connect-example")

			// Start a span
			ctx, span := tracer.Start(ctx, "test_span",
				trace.WithAttributes(
					attribute.String("testId", "__TEST__"),
				),
			)

			// Sleep for 100ms (equivalent to setTimeout)
			time.Sleep(100 * time.Millisecond)

			// Add event to span
			span.AddEvent("test event", trace.WithTimestamp(time.Now()))

			// Set span status (code: 1 = OK in OpenTelemetry)
			span.SetStatus(codes.Ok, "")

			// End the span
			span.End()

			// Store span in storage (equivalent to storage.test_span = span)
			storage["test_span"] = span

			// Sleep for 2 seconds to allow export
			time.Sleep(2 * time.Second)

			// Shutdown tracer provider to flush remaining spans
			err = tp.Shutdown(ctx)
			Expect(err).NotTo(HaveOccurred())

			// Verify span was stored
			Expect(storage["test_span"]).NotTo(BeNil())
		}, NodeTimeout(10*time.Second))
		It("should send zipkin", func(ctx context.Context) {
			recordExecution("send-zipkin")
			// Create a Zipkin span
			span := map[string]interface{}{
				"id":        "1234ef45",
				"traceId":   "d6e9329d67b6146c",
				"timestamp": fmt.Sprintf("%d", time.Now().UnixNano()/1e3), // microseconds
				"duration":  "1000",
				"name":      "span from http",
				"tags": map[string]string{
					"http.method": "GET",
					"http.path":   "/api",
				},
				"localEndpoint": map[string]string{
					"serviceName": "node script",
				},
			}

			payload, err := json.Marshal([]interface{}{span})
			Expect(err).NotTo(HaveOccurred())
			url := fmt.Sprintf("http://%s/tempo/api/push", gigaPipeWriteUrl)
			resp, err := SendJSONRequest(url, payload, 5*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusAccepted))
			time.Sleep(500 * time.Millisecond)
			fmt.Println("Tempo Insertion Successful")
		}, NodeTimeout(1000*time.Second))

		It("should post /tempo/spans", func(ctx context.Context) {
			recordExecution("post-tempo-spans")

			// Create a Zipkin span
			span := map[string]interface{}{
				"id":        "1234ef46",
				"traceId":   "d6e9329d67b6146d",
				"timestamp": time.Now().UnixNano() / 1000,
				"duration":  1000,
				"name":      "span from http",
				"tags": map[string]string{
					"http.method": "GET",
					"http.path":   "/tempo/spans",
				},
				"localEndpoint": map[string]string{
					"serviceName": "go script",
				},
			}

			spans := []map[string]interface{}{span}
			data, err := json.Marshal(spans)
			Expect(err).NotTo(HaveOccurred())
			url := fmt.Sprintf("http://%s/tempo/spans", gigaPipeWriteUrl)
			resp, err := SendJSONRequest(url, data, 5*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusAccepted))
			fmt.Println("Tempo Insertion Successful")
		}, NodeTimeout(10*time.Second))

		//
		It("should /api/v2/spans", func(ctx context.Context) {
			recordExecution("api-v2-spans")

			// Create a Zipkin span
			span := map[string]interface{}{
				"id":        "1234ef46",
				"traceId":   "d6e9329d67b6146e",
				"timestamp": time.Now().UnixNano() / 1000,
				"duration":  1000000,
				"name":      "span from http",
				"tags": map[string]string{
					"http.method": "GET",
					"http.path":   "/tempo/spans",
				},
				"localEndpoint": map[string]string{
					"serviceName": "go script",
				},
			}

			spans := []map[string]interface{}{span}
			data, err := json.Marshal(spans)
			Expect(err).NotTo(HaveOccurred())

			url := fmt.Sprintf("http://%s/tempo/spans", gigaPipeWriteUrl)
			resp, err := SendJSONRequest(url, data, 5*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusAccepted))
			fmt.Println("Tempo Insertion Successful")
		}, NodeTimeout(10*time.Second))

		It("should send _ and % logs", func(ctx context.Context) {
			recordExecution("special-chars-logs")

			points := CreatePoints(testID+"_like", 150, start, end, map[string]string{}, nil,
				func(i int) string {
					if i%2 == 1 {
						return "l_p%"
					}
					return "l1p2"
				},
				nil,
			)

			resp, err := SendPoints(fmt.Sprintf("http://%s", gigaPipeWriteUrl), points)
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusNoContent))
			time.Sleep(1 * time.Second)
		}, NodeTimeout(10*time.Second))
		It("should write elastic", func(ctx context.Context) {
			recordExecution("write-elastic")

			// Create a bulk indexing request for Elasticsearch
			bulk := []map[string]interface{}{
				{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
				{"id": 1, "text": "If I fall, don't bring me back.", "user": "jon"},
				{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
				{"id": 2, "text": "Winter is coming", "user": "ned"},
				{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
				{"id": 3, "text": "A Lannister always pays his debts.", "user": "tyrion"},
				{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
				{"id": 4, "text": "I am the blood of the dragon.", "user": "daenerys"},
				{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
				{"id": 5, "text": "A girl is Arya Stark of Winterfell. And I'm going home.", "user": "arya"},
			}

			var ndjsonBuf bytes.Buffer
			for _, item := range bulk {
				line, err := json.Marshal(item)
				Expect(err).NotTo(HaveOccurred())
				ndjsonBuf.Write(line)
				ndjsonBuf.WriteByte('\n')
			}

			url := fmt.Sprintf("http://%s/_bulk", gigaPipeWriteUrl)
			req, err := http.NewRequest("POST", url, &ndjsonBuf)
			Expect(err).NotTo(HaveOccurred())

			// Add headers
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", Shard)
			header := ExtraHeaders
			for k, v := range header {
				req.Header.Set(k, v)
			}
			// Send request
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			fmt.Println(resp.StatusCode)
			Expect(resp.StatusCode).To(Equal(http.StatusOK))
			// Check if there were errors in the response
			var respBody map[string]interface{}
			//respData, _ := io.ReadAll(resp.Body)
			json.Unmarshal(body, &respBody)

			errors, _ := respBody["errors"]
			Expect(errors).To(BeFalse())

			time.Sleep(1 * time.Second)
		}, NodeTimeout(10*time.Second))

		It("should post /api/v1/labels", func() {
			// Create a timestamp for the sample
			timestamp := time.Now().UnixNano() / int64(time.Millisecond)

			// Create Prometheus time series
			timeseries := []prompb.TimeSeries{
				{
					Labels: []prompb.Label{
						{
							Name:  fmt.Sprintf("%s_LBL", testID),
							Value: "ok",
						},
					},
					Samples: []prompb.Sample{
						{
							Value:     123,
							Timestamp: timestamp,
						},
					},
				},
			}

			// Create write request
			writeReq := &prompb.WriteRequest{
				Timeseries: timeseries,
			}

			// Prepare request
			url := fmt.Sprintf("http://%s/api/v1/prom/remote/write", gigaPipeWriteUrl)
			resp, err := SendProtobufRequest(url, writeReq, 5*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			// Check status code
			Expect(resp.StatusCode).To(Equal(204))

			// Wait for data to be processed
			time.Sleep(500 * time.Millisecond)

			// Create log points using Prometheus format (maintaining same structure pattern)
			logPoints := Points{
				&prompb.TimeSeries{
					Labels: []prompb.Label{
						{
							Name:  fmt.Sprintf("%s_LBL_LOGS", testID),
							Value: "ok",
						},
					},
					Samples: []prompb.Sample{
						{
							Value:     123,
							Timestamp: time.Now().UnixNano() / int64(time.Millisecond), // Converting to milliseconds
						},
					},
				},
			}

			logResp, err := SendPoints(fmt.Sprintf("http://%s", gigaPipeWriteUrl), logPoints)
			Expect(err).NotTo(HaveOccurred())
			defer logResp.Body.Close()

			// Check status code is in 2xx range
			Expect(logResp.StatusCode / 100).To(Equal(2))
		})

		It("should send prometheus.remote.write", func() {
			routes := []string{
				"api/v1/prom/remote/write",
				"prom/remote/write",
				"api/prom/remote/write",
			}

			for _, route := range routes {
				// Create client for remote write
				url := fmt.Sprintf("http://%s/%s", gigaPipeWriteUrl, route)

				// Build a WriteRequest directly instead of using remote.Client which has complex dependencies
				var samples []prompb.TimeSeries
				for i := start; i < end; i += 15000 {
					samples = append(samples, prompb.TimeSeries{
						Labels: []prompb.Label{
							{Name: "__name__", Value: "test_metric"},
							{Name: "test_id", Value: fmt.Sprintf("%s_RWR", testID)},
							{Name: "route", Value: route},
						},
						Samples: []prompb.Sample{
							{
								Value:     123,
								Timestamp: i,
							},
						},
					})
				}

				// Create the write request
				req := &prompb.WriteRequest{
					Timeseries: samples,
				}
				resp, err := SendProtobufRequest(url, req, 5*time.Second)
				Expect(err).NotTo(HaveOccurred())
				defer resp.Body.Close()
				// Check the response status
				Expect(resp.StatusCode).To(Equal(http.StatusNoContent))
				// Wait 500ms between requests
				time.Sleep(500 * time.Millisecond)

			}
		})
		It("should send influx", func() {
			// Initialize InfluxDB client
			client := influxdb2.NewClient(fmt.Sprintf("http://%s/influx", gigaPipeWriteUrl), "")
			defer client.Close()

			// Create a write API
			writeAPI := client.WriteAPIBlocking("", "")

			// Define test ID and default tags
			testID := "TestID"
			tags := map[string]string{
				"test_id": testID + "FLX",
				"tag1":    "val1",
			}

			// Generate points
			start := time.Now().Add(-time.Hour)
			end := time.Now()

			for current := start; current.Before(end); current = current.Add(time.Minute) {
				point := influxdb2.NewPoint(
					"syslog",
					tags,
					map[string]interface{}{"message": "FLX_TEST"},
					current,
				)
				Expect(writeAPI.WritePoint(context.Background(), point)).To(Succeed())
			}

			// Wait briefly for completion
			time.Sleep(500 * time.Millisecond)
		})
		var _ = It("should send datadog logs", func() {
			type LogEntry struct {
				DDSource string `json:"ddsource"`
				DDTags   string `json:"ddtags"`
				Hostname string `json:"hostname"`
				Message  string `json:"message"`
				Service  string `json:"service"`
			}

			logs := []LogEntry{
				{
					DDSource: fmt.Sprintf("ddtest_%s", testID),
					DDTags:   "env:staging,version:5.1",
					Hostname: "i-012345678",
					Message:  "2019-11-19T14:37:58,995 INFO [process.name][20081] Hello World",
					Service:  "payment",
				},
			}

			payload, err := json.Marshal(logs)
			Expect(err).NotTo(HaveOccurred())
			url := fmt.Sprintf("http://%s/api/v2/logs", gigaPipeWriteUrl)
			resp, err := SendJSONRequest(url, payload, 5*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusAccepted))
		})
		It("should send datadog metrics", func(ctx context.Context) {
			recordExecution("send-datadog-metrics")
			startMillis := time.Now().UnixNano() / int64(time.Millisecond)
			timestamp := startMillis / 1000 // Datadog expects seconds as integer
			// Create Datadog metrics
			metrics := map[string]interface{}{
				"series": []map[string]interface{}{
					{
						"metric": "DDMetric",
						"type":   0,
						"points": []map[string]interface{}{
							{
								"timestamp": timestamp,
								"value":     1,
							},
						},
						"resources": []map[string]interface{}{
							{
								"test_id": fmt.Sprintf("%s_DDMetric", testID),
								"name":    "dummyhost",
								"type":    "host",
							},
						},
					},
				},
			}

			data, err := json.Marshal(metrics)
			Expect(err).NotTo(HaveOccurred())

			url := fmt.Sprintf("http://%s/api/v2/series", gigaPipeWriteUrl)
			resp, err := SendJSONRequest(url, data, 5*time.Second)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(http.StatusAccepted))
			time.Sleep(500 * time.Millisecond)
		}, NodeTimeout(10*time.Second))

		// After all writing tests are complete, mark writingCompleted as true
		AfterAll(func() {
			orderMutex.Lock()
			writingCompleted = true
			orderMutex.Unlock()
			fmt.Println("Writing tests completed")
		})
	})
}

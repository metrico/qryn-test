package e2e_tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/gogo/protobuf/proto"
	"github.com/golang/snappy"
	influxdb2 "github.com/influxdata/influxdb-client-go/v2"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/prometheus/prometheus/prompb"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/sdk/resource"
	"go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.10.0"
	oteltrace "go.opentelemetry.io/otel/trace"
	"math"

	"io"

	"net/http"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	testID           string
	start            int64
	end              int64
	gigaPipeWriteUrl string
	gigaPipeExtUrl   string
	shard            string
	//ExtraHeaders     map[string]string
	storage          map[string]interface{}
	writingCompleted bool
	orderMutex       sync.Mutex
)

func init() {
	// Initialize variables
	testID = "test_" + strconv.FormatInt(time.Now().Unix(), 10)
	start = time.Now().Add(-1 * time.Hour).UnixMilli()
	end = time.Now().UnixMilli()
	gigaPipeWriteUrl = "localhost:3215"
	gigaPipeExtUrl = "localhost:3215"
	shard = "default"
	//	initExtraHeaders()
	storage = make(map[string]interface{})
}

// TestE2E is the entry point for the Ginkgo test suite
func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "E2E Test Suite")
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
var _ = Describe("E2E Tests", Ordered, func() {
	// WritingTests suite runs first
	Context("Writing Tests", func() {
		// Verify that writingCompleted is false at the beginning of WritingTests
		BeforeEach(func() {
			Expect(writingCompleted).To(BeFalse(), "Writing tests should run before being marked as completed")
		})

		// Define the three writing test cases
		//It("should perform write operation 1", func(ctx context.Context) {
		//	testName := "Write-1"
		//	recordExecution(testName)
		//	fmt.Println("Writer operation 1 done")
		//	// Simulate some work
		//	time.Sleep(100 * time.Millisecond)
		//}, NodeTimeout(2*time.Second))

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

			//// Metrics format logs
			//Points = CreatePoints(testID+"_metrics", 1, start, end,
			//	map[string]string{"fmt": "int", "lbl_repl": "val_repl", "int_lbl": "1"},
			//	Points,
			//	func(i int) string {
			//		return fmt.Sprintf("label_%d", i)
			//	},
			//	func(i int) float64 {
			//		return float64(i % 10)
			//	},
			//)
			//
			//// Logfmt format logs
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
			Expect(resp.StatusCode).To(BeNumerically("<", 300))

			// Allow time for logs to be processed
			time.Sleep(4 * time.Second)
		}, NodeTimeout(30*time.Second))

		//It("should perform write operation 2", func(ctx context.Context) {
		//	testName := "Write-2"
		//	recordExecution(testName)
		//	fmt.Println("Writer operation 2 done")
		//	// Simulate some work
		//	time.Sleep(150 * time.Millisecond)
		//}, NodeTimeout(2*time.Second))

		// PushProtobuf sends logs using the Loki protobuf format
		// This is a direct translation of the JavaScript "push protobuff" test
		It("push protobuff", func() {
			testName := "push-protobuff"
			recordExecution(testName)

			// Create points similar to JS version
			points := CreatePoints(testID+"_PB", 1, start, end, map[string]string{}, nil, nil, nil)

			// Convert the points to Loki protobuf streams
			streams := []*ProtoStream{}

			for _, stream := range points {
				// Create labels string similar to JS version
				labelParts := []string{}
				for k, v := range stream.Stream {
					// Format the label as key="value"
					labelParts = append(labelParts, fmt.Sprintf(`%s=%q`, k, v))
				}
				labels := "{" + strings.Join(labelParts, ",") + "}"

				// Create entries for this stream
				protoEntries := make([]*Entrys, 0, len(stream.Values))
				for _, v := range stream.Values {
					timestampNanos, _ := strconv.ParseInt(v[0], 10, 64)
					seconds := int64(math.Floor(float64(timestampNanos) / 1e9))
					nanos := timestampNanos % int64(1e9)

					protoEntries = append(protoEntries, &Entrys{
						Timestamp: &Timestamp{
							Seconds: strconv.FormatInt(seconds, 10),
							Nanos:   nanos,
						},
						Line: v[1],
					})
				}

				// Add the stream with its entries to the streams slice
				streams = append(streams, &ProtoStream{
					Labels:  labels,
					Entries: protoEntries,
				})
			}

			// Create a new PushRequest using the proper Loki protobuf types
			req := &PushRequest{
				Streams: streams,
			}
			// Encode to protobuf
			body, err := proto.Marshal(req)
			Expect(err).To(BeNil())

			// Compress with snappy (same as JS version)
			compressed := snappy.Encode(nil, body)

			// Make HTTP request, similar to axiosPost in JS
			httpReq, err := http.NewRequest("POST", fmt.Sprintf("http://%s/loki/api/v1/push", gigaPipeWriteUrl), bytes.NewReader(compressed))
			Expect(err).To(BeNil())

			// Set headers just like in the JS version
			httpReq.Header.Set("Content-Type", "application/x-protobuf")
			httpReq.Header.Set("X-Scope-OrgID", "1")
			httpReq.Header.Set("X-Shard", shard)

			// Add any extra headers if needed
			header := ExtraHeaders()
			for k, v := range header {

				httpReq.Header.Set(k, v)
			}

			// Send the request
			client := &http.Client{}

			resp, err := client.Do(httpReq)
			Expect(err).To(BeNil())
			defer resp.Body.Close()
			// Check status code - JS expects status code 200
			Expect(resp.StatusCode).To(Equal(http.StatusNoContent))

			// Wait for 500ms like in the JS version
			time.Sleep(500 * time.Millisecond)

			fmt.Println("Protobuf push successful")
		})

		It("should send otlp", func(ctx context.Context) {

			exporter, err := otlptracehttp.New(ctx,
				otlptracehttp.WithEndpoint(gigaPipeExtUrl),
				otlptracehttp.WithInsecure(),
				otlptracehttp.WithHeaders(map[string]string{
					"X-Scope-OrgID": "1",
					"X-Shard":       "my-shard-id",
				}),
				otlptracehttp.WithURLPath("/v1/traces"),
			)
			Expect(err).ToNot(HaveOccurred())

			res, err := resource.New(ctx,
				resource.WithAttributes(
					semconv.ServiceNameKey.String("testSvc"),
				),
			)
			Expect(err).ToNot(HaveOccurred())

			provider := trace.NewTracerProvider(
				trace.WithBatcher(exporter),
				trace.WithResource(res),
			)
			defer func() {
				Expect(provider.Shutdown(ctx)).To(Succeed())
			}()

			otel.SetTracerProvider(provider)
			tracer := otel.Tracer("connect-example")

			_, span := tracer.Start(ctx, "test_span",
				oteltrace.WithAttributes(attribute.String("testId", "__TEST__")),
			)
			time.Sleep(100 * time.Millisecond)
			span.AddEvent("test event")
			span.SetStatus(codes.Error, "error occurred")
			span.End()

			time.Sleep(2 * time.Second) // allow batch export to complete
		}, NodeTimeout(10*time.Second))

		//It("should perform write operation 3", func(ctx context.Context) {
		//	testName := "Write-3"
		//	recordExecution(testName)
		//	fmt.Println("Writer operation 3 done")
		//	// Simulate some work
		//	time.Sleep(120 * time.Millisecond)
		//}, NodeTimeout(2*time.Second))

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
			Expect(err).ToNot(HaveOccurred())
			//spans := []map[string]interface{}{span}
			//data, err := json.Marshal(spans)
			//Expect(err).NotTo(HaveOccurred())

			url := fmt.Sprintf("http://%s/tempo/api/push", gigaPipeWriteUrl)
			//resp, body, err := AxiosPost(url, payload, map[string]interface{}{
			//	"headers": map[string]string{
			//		"X-Scope-OrgID": "1",
			//		"X-Shard":       shard,
			//	},
			//})
			//
			//fmt.Println("Response:", resp.Status)
			//fmt.Println("Body:", string(body))

			// Create request
			req, err := http.NewRequest("POST", url, bytes.NewBuffer(payload))
			Expect(err).ToNot(HaveOccurred())

			// Add headers
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", shard)
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}
			// Send request
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(202))

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

			//resp, _, err := AxiosPost(url, data, map[string]interface{}{
			//	"headers": map[string]string{
			//		"X-Shard": shard,
			//	},
			//})
			req, err := http.NewRequest("POST", url, bytes.NewBuffer(data))
			Expect(err).ToNot(HaveOccurred())

			// Add headers
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", shard)
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}
			// Send request
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(202))

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
			//resp, _, err := AxiosPost(url, data, map[string]interface{}{
			//	"headers": map[string]string{
			//		"Content-Type":  "application/json",
			//		"X-Scope-OrgID": "1",
			//		"X-Shard":       shard,
			//	},
			//})

			req, err := http.NewRequest("POST", url, bytes.NewBuffer(data))
			Expect(err).ToNot(HaveOccurred())

			// Add headers
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", shard)
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}
			// Send request
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(202))

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
			Expect(resp.StatusCode).To(BeNumerically("<", 300))

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
			//data, err := json.Marshal(bulk)
			//fmt.Println(string(data))
			//Expect(err).NotTo(HaveOccurred())

			url := fmt.Sprintf("http://%s/_bulk", gigaPipeWriteUrl)

			//resp, err := axiosPost(url, &ndjsonBuf, map[string]interface{}{
			//	"headers": map[string]string{
			//		"Content-Type":  "application/json",
			//		"X-Scope-OrgID": "1",
			//	},
			//})
			req, err := http.NewRequest("POST", url, &ndjsonBuf)
			Expect(err).ToNot(HaveOccurred())

			// Add headers
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", shard)
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}
			// Send request
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Do(req)
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()

			// Read and log body (optional for debugging)
			body, _ := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			fmt.Println(resp.StatusCode)
			Expect(resp.StatusCode).To(BeNumerically("<", 300))

			// Check if there were errors in the response
			var respBody map[string]interface{}
			//respData, _ := io.ReadAll(resp.Body)
			json.Unmarshal(body, &respBody)

			errors, ok := respBody["errors"].(bool)
			Expect(ok).To(BeTrue())
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
							Name:  fmt.Sprintf("%s_LBL", testID), // Replace testID with your variable
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
			writeReq := prompb.WriteRequest{
				Timeseries: timeseries,
			}

			// Marshal to protobuf
			data, err := proto.Marshal(&writeReq)
			Expect(err).NotTo(HaveOccurred())

			// Compress with snappy
			compressed := snappy.Encode(nil, data)

			// Prepare request
			url := fmt.Sprintf("http://%s/api/v1/prom/remote/write", gigaPipeWriteUrl) // Replace clokiWriteUrl with your variable
			req, err := http.NewRequest("POST", url, bytes.NewReader(compressed))
			Expect(err).NotTo(HaveOccurred())

			// Set headers
			req.Header.Set("Content-Type", "application/x-protobuf")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", shard) // Replace shard with your variable

			// Add extra headers
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}

			// Send request
			client := &http.Client{}
			resp, err := client.Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			// Check status code
			Expect(resp.StatusCode).To(Equal(204))

			// Wait for data to be processed
			time.Sleep(500 * time.Millisecond)

			// Now send log points
			testID := "test123" // Assuming testID is defined elsewhere

			// Properly structured declaration
			logPoints := Points{
				"0": StreamValues{
					Stream: Stream{
						fmt.Sprintf("%s_LBL_LOGS", testID): "ok",
					},
					Values: [][]string{
						{
							fmt.Sprintf("%d", time.Now().UnixNano()/1000000), // Converting to milliseconds
							"123",
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

				// Encode the request to Protocol Buffers
				data, err := req.Marshal()
				Expect(err).NotTo(HaveOccurred())

				// Create an HTTP request
				httpReq, err := http.NewRequest("POST", url, bytes.NewReader(data))
				Expect(err).NotTo(HaveOccurred())

				// Set headers
				httpReq.Header.Set("Content-Type", "application/x-protobuf")
				httpReq.Header.Set("X-Scope-OrgID", "1")
				httpReq.Header.Set("X-Shard", shard)

				header := ExtraHeaders()
				// Add any extra headers
				for k, v := range header {
					httpReq.Header.Set(k, v)
				}

				// Send the request
				client := &http.Client{}
				resp, err := client.Do(httpReq)
				Expect(err).NotTo(HaveOccurred())
				defer resp.Body.Close()

				// Check the response status
				Expect(resp.StatusCode).To(Equal(204))

				// Wait 500ms between requests
				time.Sleep(500 * time.Millisecond)

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

			req, err := http.NewRequest(
				"POST",
				fmt.Sprintf("http://%s/api/v2/logs", gigaPipeWriteUrl),
				bytes.NewBuffer(payload),
			)
			Expect(err).NotTo(HaveOccurred())
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")

			client := &http.Client{}
			resp, err := client.Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			Expect(resp.StatusCode).To(Equal(202))
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

			//resp, _, err := AxiosPost(url, data, map[string]interface{}{
			//	"headers": map[string]string{
			//		"Content-Type":  "application/json",
			//		"X-Scope-OrgID": "1",
			//	},
			//})
			req, err := http.NewRequest("POST", url, bytes.NewReader(data))
			Expect(err).NotTo(HaveOccurred())

			// Set headers
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Scope-OrgID", "1")
			req.Header.Set("X-Shard", shard) // Replace shard with your variable

			// Add extra headers
			header := ExtraHeaders()
			for k, v := range header { // Replace extraHeaders with your variable
				req.Header.Set(k, v)
			}

			// Send request
			client := &http.Client{}
			resp, err := client.Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(202))

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

	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		// Verify that all writing tests have completed before running any reading tests
		BeforeAll(func() {
			Expect(writingCompleted).To(BeTrue(), "Reading tests should only run after writing tests have completed")
			fmt.Println("Starting reading tests - confirmed writing tests are complete")
		})

		// Define the three reading test cases
		It("should perform read operation 1", func(ctx context.Context) {
			testName := "Read-1"
			recordExecution(testName)
			fmt.Println("Reader operation 1 done")
			// Simulate some work
			time.Sleep(100 * time.Millisecond)
		}, NodeTimeout(2*time.Second))

		It("should perform read operation 2", func(ctx context.Context) {
			testName := "Read-2"
			recordExecution(testName)
			fmt.Println("Reader operation 2 done")
			// Simulate some work
			time.Sleep(150 * time.Millisecond)
		}, NodeTimeout(2*time.Second))

		It("should perform read operation 3", func(ctx context.Context) {
			testName := "Read-3"
			recordExecution(testName)
			fmt.Println("Reader operation 3 done")
			// Simulate some work
			time.Sleep(120 * time.Millisecond)
		}, NodeTimeout(2*time.Second))
	})

	// Final verification after all tests have run
	AfterAll(func() {
		fmt.Println("All tests completed")
		fmt.Println("Execution order:", executionOrder)

		// Find indices of first reading and writing tests to verify order
		firstWriteIdx := -1
		firstReadIdx := -1

		for i, test := range executionOrder {
			if len(test) >= 5 {
				if test[:5] == "Write" && firstWriteIdx == -1 {
					firstWriteIdx = i
				}
				if test[:4] == "Read" && firstReadIdx == -1 {
					firstReadIdx = i
				}
			}
		}

		if firstWriteIdx != -1 && firstReadIdx != -1 {
			fmt.Printf("First write test at index %d, first read test at index %d\n", firstWriteIdx, firstReadIdx)
			if firstReadIdx > firstWriteIdx {
				fmt.Println("✅ Order verification passed: Reading tests ran after Writing tests")
			} else {
				fmt.Println("❌ Order verification failed: Reading tests did not run after Writing tests")
			}
		}
	})
})

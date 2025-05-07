package e2e_tests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
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
	clokiWriteUrl    string
	clokiExtUrl      string
	shard            string
	extraHeaders     map[string]string
	storage          map[string]interface{}
	writingCompleted bool
	orderMutex       sync.Mutex
)

func init() {
	// Initialize variables
	testID = "test_" + strconv.FormatInt(time.Now().Unix(), 10)
	start = time.Now().Add(-1 * time.Hour).UnixMilli()
	end = time.Now().UnixMilli()
	clokiWriteUrl = "localhost:3100"
	clokiExtUrl = "localhost:3100"
	shard = "default"
	extraHeaders = make(map[string]string)
	storage = make(map[string]interface{})
}
func createPoints(testId string, interval float64, startTime, endTime int64, labels map[string]string, existingPoints map[string]interface{}, messageFn ...func(int) string) map[string]interface{} {
	points := make(map[string]interface{})
	if existingPoints != nil {
		for k, v := range existingPoints {
			points[k] = v
		}
	}

	// Create stream identifier
	streamLabels := map[string]string{
		"test_id": testId,
	}
	for k, v := range labels {
		streamLabels[k] = v
	}

	// Convert streamLabels to string key
	streamKey := "0"
	if len(points) > 0 {
		streamKey = strconv.Itoa(len(points))
	}

	// Create the stream entry
	stream := map[string]interface{}{
		"stream": streamLabels,
		"values": [][]string{},
	}

	// Generate values
	for i := startTime; i < endTime; i += int64(interval * 60000) {
		timestamp := strconv.FormatInt(i*1000000, 10) // Convert to nanoseconds

		message := fmt.Sprintf("Test message %d", i)
		if len(messageFn) > 0 && messageFn[0] != nil {
			idx := int(i) % 1000
			message = messageFn[0](idx)
		}

		values := stream["values"].([][]string)
		values = append(values, []string{timestamp, message})
		stream["values"] = values
	}

	points[streamKey] = stream
	return points
}

// Helper function to send points to Loki
func sendPoints(url string, points map[string]interface{}) (*http.Response, error) {
	jsonData, err := json.Marshal(points)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", url+"/loki/api/v1/push", bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Scope-OrgID", "1")
	req.Header.Set("X-Shard", shard)
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}

	client := &http.Client{}
	return client.Do(req)
}

// TestE2E is the entry point for the Ginkgo test suite
func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "E2E Test Suite")
}
func axiosPost(url string, body interface{}, options map[string]interface{}) (*http.Response, error) {
	var reqBody io.Reader

	switch v := body.(type) {
	case string:
		reqBody = strings.NewReader(v)
	case []byte:
		reqBody = bytes.NewReader(v)
	default:
		jsonData, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		reqBody = bytes.NewReader(jsonData)
	}

	req, err := http.NewRequest("POST", url, reqBody)
	if err != nil {
		return nil, err
	}

	// Set headers
	if headers, ok := options["headers"].(map[string]string); ok {
		for k, v := range headers {
			req.Header.Set(k, v)
		}
	}

	client := &http.Client{}
	return client.Do(req)
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
		It("should perform write operation 1", func(ctx context.Context) {
			testName := "Write-1"
			recordExecution(testName)
			fmt.Println("Writer operation 1 done")
			// Simulate some work
			time.Sleep(100 * time.Millisecond)
		}, NodeTimeout(2*time.Second))

		//It("push logs http", func(ctx context.Context) {
		//	testName := "push-logs-http"
		//	recordExecution(testName)
		//
		//	fmt.Println(testID)
		//	var points map[string]interface{}
		//
		//	points = createPoints(testID, 0.5, start, end, map[string]string{}, nil)
		//	points = createPoints(testID, 1, start, end, map[string]string{}, points)
		//	points = createPoints(testID, 2, start, end, map[string]string{}, points)
		//	points = createPoints(testID, 4, start, end, map[string]string{}, points)
		//
		//	// JSON format logs
		//	points = createPoints(testID+"_json", 1, start, end,
		//		map[string]string{"fmt": "json", "lbl_repl": "val_repl", "int_lbl": "1"},
		//		points,
		//		func(i int) string {
		//			return fmt.Sprintf(`{"lbl_repl":"REPL","int_val":"1","new_lbl":"new_val","str_id":%d,"arr":[1,2,3],"obj":{"o_1":"v_1"}}`, i)
		//		},
		//	)
		//
		//	// Metrics format logs
		//	points = createPoints(testID+"_metrics", 1, start, end,
		//		map[string]string{"fmt": "int", "lbl_repl": "val_repl", "int_lbl": "1"},
		//		points,
		//		func(i int) string {
		//			return ""
		//		},
		//	)
		//
		//	// Logfmt format logs
		//	points = createPoints(testID+"_logfmt", 1, start, end,
		//		map[string]string{"fmt": "logfmt", "lbl_repl": "val_repl", "int_lbl": "1"},
		//		points,
		//		func(i int) string {
		//			return fmt.Sprintf(`lbl_repl="REPL" int_val=1 new_lbl="new_val" str_id="%d"`, i)
		//		},
		//	)
		//
		//	resp, err := sendPoints(fmt.Sprintf("http://%s", clokiWriteUrl), points)
		//	Expect(err).NotTo(HaveOccurred())
		//	Expect(resp.StatusCode).To(BeNumerically("<", 300))
		//
		//	// Allow time for logs to be processed
		//	time.Sleep(4 * time.Second)
		//}, NodeTimeout(30*time.Second))

		It("should perform write operation 2", func(ctx context.Context) {
			testName := "Write-2"
			recordExecution(testName)
			fmt.Println("Writer operation 2 done")
			// Simulate some work
			time.Sleep(150 * time.Millisecond)
		}, NodeTimeout(2*time.Second))
		//It("push protobuff", func(ctx context.Context) {
		//	recordExecution("push-protobuff")
		//
		//	// First create the points in our format
		//	points := createPoints(testID+"_PB", 0.5, start, end, map[string]string{}, nil)
		//	pushReq := &logproto.PushRequest{}
		//	for _, streamRaw := range points {
		//		smap := streamRaw.(map[string]interface{})
		//		labels := "{"
		//		labelMap := smap["stream"].(map[string]string)
		//		first := true
		//		for k, v := range labelMap {
		//			if !first {
		//				labels += ","
		//			}
		//			first = false
		//			labels += fmt.Sprintf(`%s=%q`, k, v)
		//		}
		//		labels += "}"
		//
		//		entries := []logproto.Entry{}
		//		for _, val := range smap["values"].([][]string) {
		//			tsInt, _ := strconv.ParseInt(val[0], 10, 64)
		//			ts := time.Unix(0, tsInt)
		//			entries = append(entries, logproto.Entry{
		//				Timestamp: ts,
		//				Line:      val[1],
		//			})
		//		}
		//
		//		pushReq.Streams = append(pushReq.Streams, &logproto.Stream{
		//			Labels:  labels,
		//			Entries: entries,
		//		})
		//	}
		//	data, err := proto.Marshal(pushReq)
		//	Expect(err).To(BeNil())
		//	// Snappy compress
		//	compressed := snappy.Encode(nil, data)
		//
		//	// POST to Loki
		//	url := fmt.Sprintf("http://%s/loki/api/v1/push", clokiWriteUrl)
		//	resp, err := axiosPost(url, bytes.NewReader(compressed), map[string]interface{}{
		//		"headers": map[string]string{
		//			"Content-Type":  "application/x-protobuf",
		//			"X-Scope-OrgID": "1",
		//			"X-Shard":       shard,
		//		},
		//	})
		//
		//	Expect(err).NotTo(HaveOccurred())
		//	Expect(resp.StatusCode).To(BeNumerically("<", 300))
		//
		//	time.Sleep(500 * time.Millisecond)
		//}, NodeTimeout(10*time.Second))

		//todo 'should send otlp
		It("should perform write operation 3", func(ctx context.Context) {
			testName := "Write-3"
			recordExecution(testName)
			fmt.Println("Writer operation 3 done")
			// Simulate some work
			time.Sleep(120 * time.Millisecond)
		}, NodeTimeout(2*time.Second))

		//	It("should send zipkin", func(ctx context.Context) {
		//		recordExecution("send-zipkin")
		//
		//		// Create a Zipkin span
		//		span := map[string]interface{}{
		//			"id":        "1234ef45",
		//			"traceId":   "d6e9329d67b6146c",
		//			"timestamp": strconv.FormatInt(time.Now().UnixNano()/1000, 10),
		//			"duration":  "1000",
		//			"name":      "span from http",
		//			"tags": map[string]string{
		//				"http.method": "GET",
		//				"http.path":   "/api",
		//			},
		//			"localEndpoint": map[string]string{
		//				"serviceName": "go script",
		//			},
		//		}
		//
		//		spans := []map[string]interface{}{span}
		//		data, err := json.Marshal(spans)
		//		Expect(err).NotTo(HaveOccurred())
		//
		//		url := fmt.Sprintf("http://%s/tempo/api/push", clokiWriteUrl)
		//		fmt.Println(url)
		//		fmt.Println(string(data))
		//
		//		resp, err := axiosPost(url, data, map[string]interface{}{
		//			"headers": map[string]string{
		//				"Content-Type":  "application/json",
		//				"X-Scope-OrgID": "1",
		//				"X-Shard":       shard,
		//			},
		//		})
		//
		//		Expect(err).NotTo(HaveOccurred())
		//		Expect(resp.StatusCode).To(Equal(202))
		//
		//		time.Sleep(500 * time.Millisecond)
		//		fmt.Println("Tempo Insertion Successful")
		//	}, NodeTimeout(10*time.Second))
		//
		//	It("should post /tempo/spans", func(ctx context.Context) {
		//		recordExecution("post-tempo-spans")
		//
		//		// Create a Zipkin span
		//		span := map[string]interface{}{
		//			"id":        "1234ef46",
		//			"traceId":   "d6e9329d67b6146d",
		//			"timestamp": time.Now().UnixNano() / 1000,
		//			"duration":  1000,
		//			"name":      "span from http",
		//			"tags": map[string]string{
		//				"http.method": "GET",
		//				"http.path":   "/tempo/spans",
		//			},
		//			"localEndpoint": map[string]string{
		//				"serviceName": "go script",
		//			},
		//		}
		//
		//		spans := []map[string]interface{}{span}
		//		data, err := json.Marshal(spans)
		//		Expect(err).NotTo(HaveOccurred())
		//
		//		url := fmt.Sprintf("http://%s/tempo/spans", clokiWriteUrl)
		//		fmt.Println(url)
		//		fmt.Println(string(data))
		//
		//		resp, err := axiosPost(url, data, map[string]interface{}{
		//			"headers": map[string]string{
		//				"Content-Type":  "application/json",
		//				"X-Scope-OrgID": "1",
		//				"X-Shard":       shard,
		//			},
		//		})
		//
		//		Expect(err).NotTo(HaveOccurred())
		//		Expect(resp.StatusCode).To(Equal(202))
		//
		//		fmt.Println("Tempo Insertion Successful")
		//	}, NodeTimeout(10*time.Second))
		//
		//	//todo should send influx
		//	//todo should send prometheus.remote.write
		//
		//	It("should /api/v2/spans", func(ctx context.Context) {
		//		recordExecution("api-v2-spans")
		//
		//		// Create a Zipkin span
		//		span := map[string]interface{}{
		//			"id":        "1234ef46",
		//			"traceId":   "d6e9329d67b6146e",
		//			"timestamp": time.Now().UnixNano() / 1000,
		//			"duration":  1000000,
		//			"name":      "span from http",
		//			"tags": map[string]string{
		//				"http.method": "GET",
		//				"http.path":   "/tempo/spans",
		//			},
		//			"localEndpoint": map[string]string{
		//				"serviceName": "go script",
		//			},
		//		}
		//
		//		spans := []map[string]interface{}{span}
		//		data, err := json.Marshal(spans)
		//		Expect(err).NotTo(HaveOccurred())
		//
		//		url := fmt.Sprintf("http://%s/tempo/spans", clokiWriteUrl)
		//		fmt.Println(url)
		//		fmt.Println(string(data))
		//
		//		resp, err := axiosPost(url, data, map[string]interface{}{
		//			"headers": map[string]string{
		//				"Content-Type":  "application/json",
		//				"X-Scope-OrgID": "1",
		//				"X-Shard":       shard,
		//			},
		//		})
		//
		//		Expect(err).NotTo(HaveOccurred())
		//		Expect(resp.StatusCode).To(Equal(202))
		//
		//		fmt.Println("Tempo Insertion Successful")
		//	}, NodeTimeout(10*time.Second))
		//
		//	It("should send _ and % logs", func(ctx context.Context) {
		//		recordExecution("special-chars-logs")
		//
		//		points := createPoints(testID+"_like", 150, start, end, map[string]string{}, nil,
		//			func(i int) string {
		//				if i%2 == 1 {
		//					return "l_p%"
		//				}
		//				return "l1p2"
		//			},
		//		)
		//
		//		resp, err := sendPoints(fmt.Sprintf("http://%s", clokiWriteUrl), points)
		//		Expect(err).NotTo(HaveOccurred())
		//		Expect(resp.StatusCode).To(BeNumerically("<", 300))
		//
		//		time.Sleep(1 * time.Second)
		//	}, NodeTimeout(10*time.Second))
		//	It("should write elastic", func(ctx context.Context) {
		//		recordExecution("write-elastic")
		//
		//		// Create a bulk indexing request for Elasticsearch
		//		bulk := []map[string]interface{}{
		//			{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
		//			{"id": 1, "text": "If I fall, don't bring me back.", "user": "jon"},
		//			{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
		//			{"id": 2, "text": "Winter is coming", "user": "ned"},
		//			{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
		//			{"id": 3, "text": "A Lannister always pays his debts.", "user": "tyrion"},
		//			{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
		//			{"id": 4, "text": "I am the blood of the dragon.", "user": "daenerys"},
		//			{"index": map[string]string{"_index": fmt.Sprintf("test_%s", testID)}},
		//			{"id": 5, "text": "A girl is Arya Stark of Winterfell. And I'm going home.", "user": "arya"},
		//		}
		//
		//		data, err := json.Marshal(bulk)
		//		Expect(err).NotTo(HaveOccurred())
		//
		//		url := fmt.Sprintf("http://%s/_bulk", clokiWriteUrl)
		//
		//		resp, err := axiosPost(url, data, map[string]interface{}{
		//			"headers": map[string]string{
		//				"Content-Type":  "application/json",
		//				"X-Scope-OrgID": "1",
		//			},
		//		})
		//
		//		Expect(err).NotTo(HaveOccurred())
		//		Expect(resp.StatusCode).To(BeNumerically("<", 300))
		//
		//		// Check if there were errors in the response
		//		var respBody map[string]interface{}
		//		respData, _ := io.ReadAll(resp.Body)
		//		json.Unmarshal(respData, &respBody)
		//
		//		errors, ok := respBody["errors"].(bool)
		//		Expect(ok).To(BeTrue())
		//		Expect(errors).To(BeFalse())
		//
		//		time.Sleep(1 * time.Second)
		//	}, NodeTimeout(10*time.Second))
		//	//todo should post /api/v1/labels
		//	//todo should send datadog logs
		//	It("should send datadog metrics", func(ctx context.Context) {
		//		recordExecution("send-datadog-metrics")
		//
		//		// Create Datadog metrics
		//		metrics := map[string]interface{}{
		//			"series": []map[string]interface{}{
		//				{
		//					"metric": "DDMetric",
		//					"type":   0,
		//					"points": []map[string]interface{}{
		//						{
		//							"timestamp": float64(start) / 1000,
		//							"value":     0.7,
		//						},
		//					},
		//					"resources": []map[string]interface{}{
		//						{
		//							"test_id": fmt.Sprintf("%s_DDMetric", testID),
		//							"name":    "dummyhost",
		//							"type":    "host",
		//						},
		//					},
		//				},
		//			},
		//		}
		//
		//		data, err := json.Marshal(metrics)
		//		Expect(err).NotTo(HaveOccurred())
		//
		//		url := fmt.Sprintf("http://%s/api/v2/series", clokiWriteUrl)
		//
		//		resp, err := axiosPost(url, data, map[string]interface{}{
		//			"headers": map[string]string{
		//				"Content-Type":  "application/json",
		//				"X-Scope-OrgID": "1",
		//			},
		//		})
		//
		//		Expect(err).NotTo(HaveOccurred())
		//		Expect(resp.StatusCode).To(Equal(202))
		//
		//		time.Sleep(500 * time.Millisecond)
		//	}, NodeTimeout(10*time.Second))
		//
		//	// After all writing tests are complete, mark writingCompleted as true
		//	AfterAll(func() {
		//		orderMutex.Lock()
		//		writingCompleted = true
		//		orderMutex.Unlock()
		//		fmt.Println("Writing tests completed")
		//	})
		//})
		//
		//// ReadingTests suite runs after WritingTests
		//Context("Reading Tests", func() {
		//	// Verify that all writing tests have completed before running any reading tests
		//	BeforeAll(func() {
		//		Expect(writingCompleted).To(BeTrue(), "Reading tests should only run after writing tests have completed")
		//		fmt.Println("Starting reading tests - confirmed writing tests are complete")
		//	})
		//
		//	// Define the three reading test cases
		//	It("should perform read operation 1", func(ctx context.Context) {
		//		testName := "Read-1"
		//		recordExecution(testName)
		//		fmt.Println("Reader operation 1 done")
		//		// Simulate some work
		//		time.Sleep(100 * time.Millisecond)
		//	}, NodeTimeout(2*time.Second))
		//
		//	It("should perform read operation 2", func(ctx context.Context) {
		//		testName := "Read-2"
		//		recordExecution(testName)
		//		fmt.Println("Reader operation 2 done")
		//		// Simulate some work
		//		time.Sleep(150 * time.Millisecond)
		//	}, NodeTimeout(2*time.Second))
		//
		//	It("should perform read operation 3", func(ctx context.Context) {
		//		testName := "Read-3"
		//		recordExecution(testName)
		//		fmt.Println("Reader operation 3 done")
		//		// Simulate some work
		//		time.Sleep(120 * time.Millisecond)
		//	}, NodeTimeout(2*time.Second))
		//})

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
})

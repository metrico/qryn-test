package e2e_tests

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/golang/protobuf/proto"
	"github.com/golang/snappy"
	"github.com/grafana/loki/pkg/push"
	"github.com/prometheus/prometheus/prompb"
	"io"
	"io/ioutil"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

var (
	otelCollectorUrl = os.Getenv("OTEL_COLL_URL")
	gigaPipeExtUrl   = getEnvOrDefault("CLOKI_EXT_URL", "localhost:3100")
	gigaPipeWriteUrl = getEnvOrDefault("CLOKI_WRITE_URL", getEnvOrDefault("CLOKI_EXT_URL", "localhost:3215"))
	tenMinutesAgo    = time.Now().Add(-10 * time.Minute).UnixMilli()
	start            = time.UnixMilli(tenMinutesAgo).Truncate(time.Minute).UnixMilli()

	testID      = "id" + strconv.FormatFloat(rand.Float64(), 'f', -1, 64)[2:]
	storage     = make(map[string]interface{})
	currentTime = time.Now().UnixMilli()
	end         = time.UnixMilli(currentTime).Truncate(time.Minute).UnixMilli()

	Auth = func() map[string]string {
		headers := make(map[string]string)

		if login, exists := os.LookupEnv("QRYN_LOGIN"); exists {
			password := os.Getenv("QRYN_PASSWORD")
			auth := base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%s:%s", login, password)))
			headers["Authorization"] = fmt.Sprintf("Basic %s", auth)
		}

		return headers
	}()

	ExtraHeaders = func() map[string]string {
		headers := make(map[string]string)

		// Copy Auth headers
		for k, v := range Auth {
			headers[k] = v
		}

		if dsn, exists := os.LookupEnv("DSN"); exists {
			headers["X-CH-DSN"] = dsn
		}

		return headers
	}()
)

// getEnvOrDefault returns the value of an environment variable or a default value if not set

func getEnvOrDefault(key, defaultValue string) string {
	value, exists := os.LookupEnv(key)
	if exists {
		return value
	}
	return defaultValue
}

// MsgGenerator is a function that generates a message for a given index
type MsgGenerator func(i int) string

// ValGenerator is a function that generates a value for a given index
type ValGenerator func(i int) float64

type Stream []*prompb.Label
type StreamValues = prompb.TimeSeries
type Points []*prompb.TimeSeries
type LokiTimestamp = prompb.Sample
type LokiEntry = prompb.Sample
type ProtoStream = prompb.TimeSeries
type PushRequest = prompb.WriteRequest
type LokiStream struct {
	Stream map[string]string `json:"stream"`
	Values [][]string        `json:"values"`
}

// MessageGenerator is a function type for generating log messages
type MessageGenerator func(int) string

// ValueGenerator is a function type for generating additional values
type ValueGenerator func(int) interface{}

func CreatePoints(id string, frequencySec float64, startMs, endMs int64,
	extraLabels map[string]string, points map[string]LokiStream,
	msgGen MessageGenerator, valGen ValueGenerator) map[string]LokiStream {

	// Initialize streams map with base labels
	streams := map[string]string{
		"test_id": id,
		"freq":    fmt.Sprintf("%g", frequencySec),
	}

	// Add extra labels
	for k, v := range extraLabels {
		streams[k] = v
	}

	// Default message generator if not provided
	if msgGen == nil {
		msgGen = func(i int) string {
			return fmt.Sprintf("FREQ_TEST_%d", i)
		}
	}

	// Calculate number of points
	numPoints := int(math.Floor(float64(endMs-startMs) / frequencySec / 1000))

	// Generate values array
	values := make([][]string, numPoints)
	for i := 0; i < numPoints; i++ {
		timestamp := ((startMs + int64(frequencySec*float64(i)*1000)) * 1000000)
		timestampStr := strconv.FormatInt(timestamp, 10)
		message := msgGen(i)

		if valGen != nil {
			// If value generator is provided, create 3-element array
			val := valGen(i)
			valStr := fmt.Sprintf("%v", val)
			values[i] = []string{timestampStr, message, valStr}
		} else {
			// Otherwise, create 2-element array
			values[i] = []string{timestampStr, message}
		}
	}

	// Initialize points map if nil
	if points == nil {
		points = make(map[string]LokiStream)
	} else {
		// Create a copy of the existing points map
		newPoints := make(map[string]LokiStream)
		for k, v := range points {
			newPoints[k] = v
		}
		points = newPoints
	}

	// Create JSON key from streams map
	streamsJSON, err := json.Marshal(streams)
	if err != nil {
		// Handle error - in production, you might want to return an error
		panic(fmt.Sprintf("Failed to marshal streams: %v", err))
	}
	key := string(streamsJSON)

	// Add the new stream to points
	points[key] = LokiStream{
		Stream: streams,
		Values: values,
	}

	return points
}

//func CreatePoints(id string, frequencySec float64, startMs, endMs int64,
//	extraLabels map[string]string, points Points, msgGen MsgGenerator, valGen ValGenerator) Points {
//
//	// Create stream with labels as []*prompb.Label
//	labels := make([]prompb.Label, 0)
//	labels = append(labels, prompb.Label{Name: "test_id", Value: id})
//	labels = append(labels, prompb.Label{Name: "freq", Value: strconv.FormatFloat(frequencySec, "", 10, 10)})
//
//	// Merge extra labels
//	for k, v := range extraLabels {
//		labels = append(labels, prompb.Label{Name: k, Value: v})
//	}
//
//	// Default message generator if not provided
//	if msgGen == nil {
//		msgGen = func(i int) string {
//			return fmt.Sprintf("FREQ_TEST_%d", i)
//		}
//	}
//
//	// Calculate number of values
//	count := int(math.Floor(float64(endMs-startMs) / float64(frequencySec) / 1000.0))
//	samples := make([]prompb.Sample, 0, count)
//
//	// Generate samples
//	for i := 0; i < count; i++ {
//		timestampMs := startMs + frequencySec*int64(i)*1000
//
//		var value float64 = 1.0 // Default value
//		if valGen != nil {
//			value = valGen(i)
//		}
//
//		samples = append(samples, prompb.Sample{
//			Timestamp: timestampMs,
//			Value:     value,
//		})
//	}
//
//	// Create a new Points slice if nil
//	if points == nil {
//		points = make([]*prompb.TimeSeries, 0)
//	}
//
//	// Create TimeSeries and add to points
//	timeSeries := &prompb.TimeSeries{
//		Labels:  labels,
//		Samples: samples,
//	}
//
//	points = append(points, timeSeries)
//
//	return points
//}

// SendPointsRequest is the structure for sending points to Loki

type SendPointsRequest struct {
	Timeseries []prompb.TimeSeries `json:"timeseries"`
}

func SendPoints(endpoint string, points map[string]LokiStream) (*http.Response, error) {
	streams := make([]push.Stream, 0, len(points))

	// Iterate over each LokiStream in the map
	for _, lokiStream := range points {
		// Build labels string from the Stream map
		labels := ""
		i := 0
		for key, value := range lokiStream.Stream {
			if i > 0 {
				labels += ","
			}
			labels += fmt.Sprintf(`%s="%s"`, key, value)
			i++
		}
		labels = "{" + labels + "}"

		// Convert Values to Loki entries
		entries := make([]push.Entry, 0, len(lokiStream.Values))
		for _, value := range lokiStream.Values {
			if len(value) < 2 {
				continue // Skip invalid entries that don't have timestamp and value
			}

			// Parse timestamp (assuming it's in nanoseconds as string)
			timestampNanos, err := strconv.ParseInt(value[0], 10, 64)
			if err != nil {
				continue // Skip entries with invalid timestamps
			}

			entries = append(entries, push.Entry{
				Timestamp: time.Unix(0, timestampNanos),
				Line:      value[1], // The log line/value
			})
		}

		streams = append(streams, push.Stream{
			Labels:  labels,
			Entries: entries,
		})
	}

	// Create Loki push request using protobuf
	pushReq := &push.PushRequest{
		Streams: streams,
	}

	// Marshal to protobuf
	protoData, err := proto.Marshal(pushReq)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal protobuf: %w", err)
	}

	// Create request to Loki endpoint
	req, err := http.NewRequest("POST", fmt.Sprintf("%s/loki/api/v1/push", endpoint), bytes.NewBuffer(protoData))
	if err != nil {
		return nil, err
	}

	// Add Loki headers for protobuf
	req.Header.Set("Content-Type", "application/x-protobuf")
	req.Header.Set("X-Scope-OrgID", "1")

	// Add auth headers
	for k, v := range Auth {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders {
		req.Header.Set(k, v)
	}

	// Send request
	client := &http.Client{
		Timeout: 30 * time.Second,
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}

	// Handle errors
	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		fmt.Printf("Error response: %s\n", string(body))
		return resp, fmt.Errorf("request failed with status code %d", resp.StatusCode)
	}

	return resp, nil
}

//func SendPoints(endpoint string, points LokiStream) (*http.Response, error) {
//
//	streams := make([]push.Stream, 0, len(points))
//
//	for _, point := range points {
//		labels := ""
//		for i, label := range point.Labels {
//			if i > 0 {
//				labels += ","
//			}
//			labels += fmt.Sprintf(`%s="%s"`, label.Name, label.Value)
//		}
//		labels = "{" + labels + "}"
//
//		// Convert Prometheus samples to Loki entries
//		entries := make([]push.Entry, 0, len(point.Samples))
//		for _, sample := range point.Samples {
//			// Convert timestamp from milliseconds to nanoseconds for Loki
//			timestampNanos := sample.Timestamp * 1_000_000
//			valueStr := strconv.FormatFloat(sample.Value, 'f', -1, 64)
//
//			entries = append(entries, push.Entry{
//				Timestamp: time.Unix(0, timestampNanos),
//				Line:      valueStr,
//			})
//		}
//
//		streams = append(streams, push.Stream{
//			Labels:  labels,
//			Entries: entries,
//		})
//	}
//
//	// Create Loki push request using protobuf
//	pushReq := &push.PushRequest{
//		Streams: streams,
//	}
//
//	// Marshal to protobuf
//	protoData, err := proto.Marshal(pushReq)
//	if err != nil {
//		return nil, fmt.Errorf("failed to marshal protobuf: %w", err)
//	}
//
//	// Create request to Loki endpoint
//	req, err := http.NewRequest("POST", fmt.Sprintf("%s/loki/api/v1/push", endpoint), bytes.NewBuffer(protoData))
//	if err != nil {
//		return nil, err
//	}
//
//	// Add Loki headers for protobuf
//	req.Header.Set("Content-Type", "application/x-protobuf")
//	req.Header.Set("X-Scope-OrgID", "1")
//
//	// Add auth headers
//	for k, v := range Auth {
//		req.Header.Set(k, v)
//	}
//
//	// Add extra headers
//	for k, v := range ExtraHeaders {
//		req.Header.Set(k, v)
//	}
//
//	// Send request
//	client := &http.Client{
//		Timeout: 30 * time.Second,
//	}
//	resp, err := client.Do(req)
//	if err != nil {
//		return nil, err
//	}
//
//	// Handle errors
//	if resp.StatusCode >= 400 {
//		body, _ := io.ReadAll(resp.Body)
//		fmt.Printf("Error response: %s\n", string(body))
//		return resp, fmt.Errorf("request failed with status code %d", resp.StatusCode)
//	}
//
//	return resp, nil
//}

// RawGetResponse represents the response from RawGet

type RawGetResponse struct {
	Code int
	Data []byte
}

// RawGet performs a GET request and returns the raw response

func RawGet(url string, conf map[string]interface{}) (*RawGetResponse, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	// Add headers
	req.Header.Set("X-Scope-OrgID", "1")

	// Add auth headers
	for k, v := range Auth {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders {
		req.Header.Set(k, v)
	}

	// Add custom headers if provided
	if conf != nil {
		if headers, ok := conf["headers"].(map[string]string); ok {
			for k, v := range headers {
				req.Header.Set(k, v)
			}
		}
	}

	client := &http.Client{}
	if strings.HasPrefix(url, "https") {
		client.Transport = &http.Transport{
			// TLS configuration if needed
		}
	}

	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	data, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	return &RawGetResponse{
		Code: resp.StatusCode,
		Data: data,
	}, nil
}

func axiosGet(url string) (*http.Response, error) {
	client := &http.Client{}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	for k, v := range ExtraHeaders {
		req.Header.Set(k, v)
	}

	return client.Do(req)
}

// AxiosPost performs a POST request with error handling

func AxiosPost(method, url string, data *bytes.Reader, contentType string, waitTime time.Duration) (*http.Response, error) {
	req, err := http.NewRequest(method, url, data)
	if err != nil {
		return nil, fmt.Errorf("error creating request: %w", err)
	}

	// Set common headers
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Scope-OrgID", "1")
	req.Header.Set("X-Shard", "default")

	// Add any extra headers
	header := ExtraHeaders
	for k, v := range header {
		req.Header.Set(k, v)
	}

	// Send request
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("error sending request: %w", err)
	}

	// Wait for specified time if needed
	if waitTime > 0 {
		time.Sleep(waitTime)
	}

	return resp, nil
}

// AxiosDelete performs a DELETE request with error handling

func AxiosDelete(reqURL string, conf map[string]interface{}) (*http.Response, []byte, error) {
	req, err := http.NewRequest("DELETE", reqURL, nil)
	if err != nil {
		return nil, nil, err
	}

	// Add headers
	req.Header.Set("X-Scope-OrgID", "1")

	// Add auth headers
	for k, v := range Auth {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders {
		req.Header.Set(k, v)
	}

	// Add custom headers if provided
	if conf != nil {
		if headers, ok := conf["headers"].(map[string]string); ok {
			for k, v := range headers {
				req.Header.Set(k, v)
			}
		}
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		fmt.Println(reqURL)
		return nil, nil, err
	}
	defer resp.Body.Close()

	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, err
	}

	return resp, body, nil
}

func init() {
	// Initialize random seed
	rand.Seed(time.Now().UnixNano())
}

func SendProtobufRequest(url string, data proto.Message, waitTime time.Duration) (*http.Response, error) {
	// Marshal to protobuf
	bytedata, err := proto.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("error marshaling protobuf: %w", err)
	}

	// Compress with snappy
	compressed := snappy.Encode(nil, bytedata)

	// Send request
	return AxiosPost("POST", url, bytes.NewReader(compressed), "application/x-protobuf", waitTime)
}

// SendJSONRequest marshals data to JSON and sends it via HTTP
func SendJSONRequest(url string, data []byte, waitTime time.Duration) (*http.Response, error) {

	return AxiosPost("POST", url, bytes.NewReader(data), "application/json", waitTime)
}

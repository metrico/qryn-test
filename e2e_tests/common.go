package e2e_tests

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/gogo/protobuf/proto"
	"github.com/golang/snappy"
	"io/ioutil"
	"math"
	"math/rand"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

var (
	otelCollectorUrl = os.Getenv("OTEL_COLL_URL")
	gigaPipeExtUrl   = getEnvOrDefault("CLOKI_EXT_URL", "localhost:3100")
	gigaPipeWriteUrl = getEnvOrDefault("CLOKI_WRITE_URL", getEnvOrDefault("CLOKI_EXT_URL", "localhost:3215"))
	tenMinutesAgo    = time.Now().Add(-10 * time.Minute).UnixMilli()
	start            = int64(math.Floor(float64(tenMinutesAgo)/float64(60*1000))) * 60 * 1000
	randomNum        = rand.Float64()
	randomStr        = strconv.FormatFloat(randomNum, 'f', -1, 64)
	testID           = "id" + randomStr[2:]
	storage          = make(map[string]interface{})
	// Calculate end time (current time, rounded to nearest minute)
	currentTime = time.Now().UnixMilli()
	end         = int64(math.Floor(float64(currentTime)/float64(60*1000))) * 60 * 1000
)

type ReqOptions struct {
	Name  string
	Req   string
	Step  int64
	Start int64
	End   int64
	Oid   string
	Limit int
}

// getEnvOrDefault returns the value of an environment variable or a default value if not set
func getEnvOrDefault(key, defaultValue string) string {
	value, exists := os.LookupEnv(key)
	if exists {
		return value
	}
	return defaultValue
}

// Stream represents a log stream with labels
type Stream map[string]string

// StreamValues represents a stream and its associated values
type StreamValues struct {
	Stream Stream     `json:"stream"`
	Values [][]string `json:"values"`
}

// Points is a map of serialized streams to their StreamValues
type Points map[string]StreamValues

type Timestamp struct {
	Seconds string `protobuf:"bytes,1,opt,name=seconds,proto3" json:"seconds,omitempty"`
	Nanos   int64  `protobuf:"varint,2,opt,name=nanos,proto3" json:"nanos,omitempty"`
}

type Entrys struct {
	Timestamp *Timestamp `protobuf:"bytes,1,opt,name=timestamp,proto3" json:"timestamp,omitempty"`
	Line      string     `protobuf:"bytes,2,opt,name=line,proto3" json:"line,omitempty"`
}

type ProtoStream struct {
	Labels  string    `protobuf:"bytes,1,opt,name=labels,proto3" json:"labels,omitempty"`
	Entries []*Entrys `protobuf:"bytes,2,rep,name=entries,proto3" json:"entries,omitempty"`
}

type PushRequest struct {
	Streams []*ProtoStream `protobuf:"bytes,1,rep,name=streams,proto3" json:"streams,omitempty"`
}

func (m *Timestamp) Reset()           { *m = Timestamp{} }
func (m *Timestamp) String() string   { return proto.CompactTextString(m) }
func (*Timestamp) ProtoMessage()      {}
func (m *Stream) Reset()              { *m = Stream{} }
func (m *Stream) String() string      { return proto.CompactTextString(m) }
func (*Stream) ProtoMessage()         {}
func (m *Entrys) Reset()              { *m = Entrys{} }
func (m *Entrys) String() string      { return proto.CompactTextString(m) }
func (*Entrys) ProtoMessage()         {}
func (m *PushRequest) Reset()         { *m = PushRequest{} }
func (m *PushRequest) String() string { return proto.CompactTextString(m) }
func (*PushRequest) ProtoMessage()    {}

// MsgGenerator is a function that generates a message for a given index
type MsgGenerator func(i int) string

// ValGenerator is a function that generates a value for a given index
type ValGenerator func(i int) float64

// CreatePoints creates points for testing
func CreatePoints(id string, frequencySec int64, startMs, endMs int64,
	extraLabels map[string]string, points Points, msgGen MsgGenerator, valGen ValGenerator) Points {

	// Create stream with labels
	streams := Stream{
		"test_id": id,
		"freq":    strconv.FormatInt(frequencySec, 10),
	}

	// Merge extra labels
	for k, v := range extraLabels {
		streams[k] = v
	}

	// Default message generator if not provided
	if msgGen == nil {
		msgGen = func(i int) string {
			return fmt.Sprintf("FREQ_TEST_%d", i)
		}
	}

	// Calculate number of values
	count := int(math.Floor(float64(endMs-startMs) / float64(frequencySec) / 1000.0))
	values := make([][]string, count)

	// Generate values
	for i := 0; i < count; i++ {
		timestamp := ((startMs + frequencySec*int64(i)*1000) * 1000000)

		if valGen != nil {
			values[i] = []string{
				strconv.FormatInt(timestamp, 10),
				msgGen(i),
				fmt.Sprintf("%v", valGen(i)),
			}
		} else {
			values[i] = []string{
				strconv.FormatInt(timestamp, 10),
				msgGen(i),
			}
		}
	}

	// Create a new Points map if nil
	if points == nil {
		points = make(Points)
	}

	// Marshal the stream to use as key
	streamBytes, _ := json.Marshal(streams)
	streamKey := string(streamBytes)

	// Add the stream and values to points
	points[streamKey] = StreamValues{
		Stream: streams,
		Values: values,
	}

	return points
}

// SendPointsRequest is the structure for sending points to Loki
type SendPointsRequest struct {
	Streams []StreamValues `json:"streams"`
}

// SendPoints sends points to the specified endpoint
func SendPoints(endpoint string, points Points) (*http.Response, error) {
	// Convert points map values to slice
	streams := make([]StreamValues, 0, len(points))
	for _, streamVal := range points {
		streams = append(streams, streamVal)
	}

	// Create request body
	reqBody := SendPointsRequest{
		Streams: streams,
	}

	jsonData, err := json.Marshal(reqBody)
	if err != nil {
		return nil, err
	}

	fmt.Printf("%s/loki/api/v1/push\n", endpoint)

	// Create request
	req, err := http.NewRequest("POST", fmt.Sprintf("%s/loki/api/v1/push", endpoint), bytes.NewBuffer(jsonData))
	if err != nil {
		return nil, err
	}

	// Add headers
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Scope-OrgID", "1")
	req.Header.Set("X-Shard", "-1")

	// Add auth headers
	for k, v := range Auth() {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders() {
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
		body, _ := ioutil.ReadAll(resp.Body)
		fmt.Printf("Error response: %s\n", string(body))
		return resp, fmt.Errorf("request failed with status code %d", resp.StatusCode)
	}

	return resp, nil
}

// E2E checks if end-to-end testing is enabled
func E2E() bool {
	_, e2e := os.LookupEnv("INTEGRATION_E2E")
	_, integration := os.LookupEnv("INTEGRATION")
	return e2e || integration
}

// ClokiExtUrl returns the external Cloki URL
func ClokiExtUrl() string {
	if url, exists := os.LookupEnv("CLOKI_EXT_URL"); exists {
		return url
	}
	return "localhost:3100"
}

// ClokiWriteUrl returns the Cloki write URL
func ClokiWriteUrl() string {
	if url, exists := os.LookupEnv("CLOKI_WRITE_URL"); exists {
		return url
	}
	if url, exists := os.LookupEnv("CLOKI_EXT_URL"); exists {
		return url
	}
	return "localhost:3100"
}

// KOrder sorts an object's keys alphabetically
func KOrder(obj map[string]interface{}) map[string]interface{} {
	keys := make([]string, 0, len(obj))
	for k := range obj {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	ordered := make(map[string]interface{})
	for _, k := range keys {
		ordered[k] = obj[k]
	}
	return ordered
}

// GenerateTestID generates a random test ID
func GenerateTestID() string {
	return fmt.Sprintf("id%d", rand.Intn(900000)+100000)
}

// GetTimeRange returns the start and end time for tests
func GetTimeRange() (int64, int64) {
	now := time.Now().UnixNano() / int64(time.Millisecond)
	end := (now / (60 * 1000)) * (60 * 1000)
	start := end - (60 * 1000 * 10)
	return start, end
}

// Auth returns authentication headers
func Auth() map[string]string {
	headers := make(map[string]string)

	if login, exists := os.LookupEnv("QRYN_LOGIN"); exists {
		password := os.Getenv("QRYN_PASSWORD")
		auth := base64.StdEncoding.EncodeToString([]byte(fmt.Sprintf("%s:%s", login, password)))
		headers["Authorization"] = fmt.Sprintf("Basic %s", auth)
	}

	return headers
}

// ExtraHeaders returns additional headers for requests
func ExtraHeaders() map[string]string {
	headers := Auth()

	if dsn, exists := os.LookupEnv("DSN"); exists {
		headers["X-CH-DSN"] = dsn
	}

	return headers
}

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
	for k, v := range Auth() {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders() {
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

// AxiosGet performs a GET request with error handling
func AxiosGet(reqURL string, conf map[string]interface{}) (*http.Response, []byte, error) {
	if conf == nil {
		conf = make(map[string]interface{})
	}

	req, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, nil, err
	}

	// Add headers
	req.Header.Set("X-Scope-OrgID", "1")

	// Add auth headers
	for k, v := range Auth() {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders() {
		req.Header.Set(k, v)
	}

	// Add custom headers if provided
	if headers, ok := conf["headers"].(map[string]string); ok {
		for k, v := range headers {
			req.Header.Set(k, v)
		}
	}

	client := &http.Client{
		Timeout: 30 * time.Second,
	}

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

// AxiosPost performs a POST request with error handling
func AxiosPost(method, url string, data *bytes.Reader, contentType string, waitTime time.Duration) (*http.Response, error) {
	// Create request
	//jsonData, err := json.Marshal(data)
	//if err != nil {
	//	return nil, fmt.Errorf("error marshaling JSON: %w", err)
	//}

	req, err := http.NewRequest(method, url, data)
	if err != nil {
		return nil, fmt.Errorf("error creating request: %w", err)
	}

	// Set common headers
	req.Header.Set("Content-Type", contentType)
	req.Header.Set("X-Scope-OrgID", "1")
	req.Header.Set("X-Shard", "default")

	// Add any extra headers
	header := ExtraHeaders()
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
	for k, v := range Auth() {
		req.Header.Set(k, v)
	}

	// Add extra headers
	for k, v := range ExtraHeaders() {
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

//	func auth() map[string]string {
//		headers := make(map[string]string)
//
//		if qrynLogin := os.Getenv("QRYN_LOGIN"); qrynLogin != "" {
//			qrynPassword := os.Getenv("QRYN_PASSWORD")
//			authStr := qrynLogin + ":" + qrynPassword
//			headers["Authorization"] = "Basic " + authStr
//		}
//
//		return headers
//	}
//
//	func initExtraHeaders() {
//		ExtraHeaders = auth()
//		if dsn := os.Getenv("DSN"); dsn != "" {
//			ExtraHeaders["X-CH-DSN"] = dsn
//		}
//	}
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
	//jsonData, err := json.Marshal(data)
	//if err != nil {
	//	return nil, fmt.Errorf("error marshaling JSON: %w", err)
	//}

	return AxiosPost("POST", url, bytes.NewReader(data), "application/json", waitTime)
}

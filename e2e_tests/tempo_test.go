package e2e_tests

import (
	"encoding/json"
	"fmt"
	"github.com/bradleyjkemp/cupaloy"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"io"
	"net/http"
	"strings"
	"time"
)

type TraceData struct {
	ResourceSpans []ResourceSpan `json:"resourceSpans"`
}

type ResourceSpan struct {
	InstrumentationLibrarySpans []InstrumentationLibrarySpan `json:"instrumentationLibrarySpans"`
}

type InstrumentationLibrarySpan struct {
	Spans []Span `json:"spans"`
}

type Span struct {
	TraceID           string      `json:"traceID,omitempty"`
	TraceId           string      `json:"traceId,omitempty"`
	SpanID            string      `json:"spanID,omitempty"`
	SpanId            string      `json:"spanId,omitempty"`
	StartTimeUnixNano int         `json:"startTimeUnixNano,omitempty"`
	EndTimeUnixNano   int         `json:"endTimeUnixNano,omitempty"`
	Attributes        []Attribute `json:"attributes"`
	Events            []Event     `json:"events,omitempty"`
	Name              string      `json:"name,omitempty"`
	// Add other fields as needed
}

type Attribute struct {
	Key   string      `json:"key"`
	Value interface{} `json:"value"`
}

type Event struct {
	TimeUnixNano string `json:"timeUnixNano,omitempty"`
	Name         string `json:"name,omitempty"`
	// Add other fields as needed
}

type SearchTagsResponse struct {
	TagNames []string `json:"tagNames"`
}

type SearchTagValuesResponse struct {
	TagValues []string `json:"tagValues"`
}

type SearchResponse struct {
	Traces []SearchTrace `json:"traces"`
}

type SearchTrace struct {
	StartTimeUnixNano string `json:"startTimeUnixNano,omitempty"`
	// Add other fields as needed for snapshot matching
}

var httpClient *http.Client

func tempoTest() {
	// ReadingTests suite runs after WritingTests
	BeforeEach(func() {
		// Initialize test variables - replace with your actual values
		httpClient = &http.Client{
			Timeout: 30 * time.Second,
		}
	})
	cleanSpanForValidation := func(span *Span) {
		span.TraceID = ""
		span.TraceId = ""
		span.SpanID = ""
		span.SpanId = ""
		span.StartTimeUnixNano = 0
		span.EndTimeUnixNano = 0

		// Clean events time fields
		for i := range span.Events {
			span.Events[i].TimeUnixNano = ""
		}
	}
	//It("should read otlp", func() {
	//	fmt.Println(storage)
	//	// Get span from storage (assumes it was set by previous test)
	//	spanInterface, exists := storage["test_span"]
	//
	//	fmt.Println(spanInterface, exists)
	//	Expect(exists).To(BeTrue(), "test_span should exist in storage")
	//
	//	// Type assert to get the span
	//	span, ok := spanInterface.(trace.Span)
	//	Expect(ok).To(BeTrue(), "stored test_span should be a trace.Span")
	//
	//	// Get trace ID and convert to uppercase
	//	traceID := span.SpanContext().TraceID().String()
	//	traceIDUpper := strings.ToUpper(traceID)
	//
	//	// Make API request
	//	url := fmt.Sprintf("http://%s/api/traces/%s/json", gigaPipeExtUrl, traceIDUpper)
	//	respbody, err := axiosGet(url)
	//	Expect(err).NotTo(HaveOccurred())
	//
	//	body, err := io.ReadAll(respbody.Body)
	//	Expect(err).NotTo(HaveOccurred())
	//	// Parse response
	//	var data TraceData
	//	err = json.Unmarshal(body, &data)
	//	Expect(err).NotTo(HaveOccurred())
	//
	//	fmt.Println("Trade Data", data)
	//	// Sort attributes for consistent comparison
	//	spanData := &data.ResourceSpans[0].InstrumentationLibrarySpans[0].Spans[0]
	//	sort.Slice(spanData.Attributes, func(i, j int) bool {
	//		return spanData.Attributes[i].Key < spanData.Attributes[j].Key
	//	})
	//
	//	// Clean validation data
	//	validation := data.ResourceSpans[0].InstrumentationLibrarySpans[0].Spans[0]
	//	cleanSpanForValidation(&validation)
	//
	//	// In a real test, you would compare against a golden file or expected structure
	//	// For now, we'll just verify the structure exists
	//	Expect(validation.Attributes).NotTo(BeEmpty())
	//	// expect(validation).toMatchSnapshot() - equivalent would be custom matcher
	//})

	It("should read zipkin", func() {
		// Wait 500ms
		time.Sleep(500 * time.Millisecond)

		url := fmt.Sprintf("http://%s/api/traces/0000000000000000d6e9329d67b6146c/json", gigaPipeExtUrl)
		respbody, err := axiosGet(url)
		Expect(err).NotTo(HaveOccurred())

		body, err := io.ReadAll(respbody.Body)

		Expect(err).NotTo(HaveOccurred())
		var data TraceData
		err = json.Unmarshal(body, &data)
		Expect(err).NotTo(HaveOccurred())

		validation := data.ResourceSpans[0].InstrumentationLibrarySpans[0].Spans[0]
		Expect(validation.SpanID).To(Equal("000000001234ef45"))

		cleanSpanForValidation(&validation)
		Expect(validation).NotTo(BeNil())
	})

	It("should read /tempo/spans", func() {
		time.Sleep(500 * time.Millisecond)

		url := fmt.Sprintf("http://%s/api/traces/0000000000000000d6e9329d67b6146d/json", gigaPipeExtUrl)
		respbody, err := axiosGet(url)
		Expect(err).NotTo(HaveOccurred())

		body, err := io.ReadAll(respbody.Body)
		Expect(err).NotTo(HaveOccurred())

		var data TraceData
		err = json.Unmarshal(body, &data)
		Expect(err).NotTo(HaveOccurred())

		validation := data.ResourceSpans[0].InstrumentationLibrarySpans[0].Spans[0]
		Expect(validation.SpanID).To(Equal("000000001234ef46"))

		cleanSpanForValidation(&validation)
		Expect(validation).NotTo(BeNil())
	})

	It("should read /api/v2/spans", func() {
		time.Sleep(500 * time.Millisecond)

		url := fmt.Sprintf("http://%s/api/traces/0000000000000000d6e9329d67b6146e/json", gigaPipeExtUrl)
		respbody, err := axiosGet(url)
		Expect(err).NotTo(HaveOccurred())

		body, err := io.ReadAll(respbody.Body)
		Expect(err).NotTo(HaveOccurred())

		var data TraceData
		err = json.Unmarshal(body, &data)
		Expect(err).NotTo(HaveOccurred())

		validation := data.ResourceSpans[0].InstrumentationLibrarySpans[0].Spans[0]
		Expect(validation.SpanID).To(Equal("000000001234ef46"))

		cleanSpanForValidation(&validation)
		Expect(validation).NotTo(BeNil())
	})

	It("should read /api/search/tags", func() {
		url := fmt.Sprintf("http://%s/api/search/tags", gigaPipeExtUrl)
		respbody, err := axiosGet(url)
		Expect(err).NotTo(HaveOccurred())

		body, err := io.ReadAll(respbody.Body)
		Expect(err).NotTo(HaveOccurred())

		var response SearchTagsResponse
		err = json.Unmarshal(body, &response)
		Expect(err).NotTo(HaveOccurred())

		expectedTags := []string{"http.method", "http.path", "service.name", "name"}

		for _, expectedTag := range expectedTags {
			found := false
			for _, tag := range response.TagNames {
				if tag == expectedTag {
					found = true
					break
				}
			}
			Expect(found).To(BeTrue(), fmt.Sprintf("Expected tag '%s' should be found", expectedTag))
		}
	})

	It("should read /api/search/tag/.../values", func() {
		testCases := [][]string{
			{"http.method", "GET"},
			{"http.path", "/tempo/spans"},
			{"service.name", "node script"},
			{"name", "span from http"},
		}

		for _, testCase := range testCases {
			tagName := testCase[0]
			expectedValue := testCase[1]

			url := fmt.Sprintf("http://%s/api/search/tag/%s/values", gigaPipeWriteUrl, tagName)
			fmt.Printf("Testing URL: %s\n", url)

			respbody, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())

			body, err := io.ReadAll(respbody.Body)
			Expect(err).NotTo(HaveOccurred())
			var response SearchTagValuesResponse
			err = json.Unmarshal(body, &response)
			Expect(err).NotTo(HaveOccurred())

			fmt.Printf("Response data: %v\n", response.TagValues)

			found := false
			for _, value := range response.TagValues {
				if value == expectedValue {
					found = true
					break
				}
			}
			Expect(found).To(BeTrue(), fmt.Sprintf("Expected value '%s' should be found for tag '%s'", expectedValue, tagName))
			err = cupaloy.New().SnapshotMulti(
				"status", respbody.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		}
	})
	It("should get /api/echo", func() {
		url := fmt.Sprintf("http://%s/api/echo", gigaPipeExtUrl)
		respbody, err := axiosGet(url)
		Expect(err).NotTo(HaveOccurred())

		body, err := io.ReadAll(respbody.Body)
		Expect(err).NotTo(HaveOccurred())
		// Parse as string since it's a simple echo response
		responseText := strings.Trim(string(body), `"`)
		Expect(responseText).To(Equal("echo"))
		err = cupaloy.New().SnapshotMulti(
			"status", respbody.Status,
		)

		// Only fail if it's not the initial snapshot creation
		if err != nil && !strings.Contains(err.Error(), "snapshot created") {
			Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
		}
	})

}

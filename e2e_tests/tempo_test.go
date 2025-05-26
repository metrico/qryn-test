package e2e_tests

import (
	"encoding/json"
	"fmt"
	"github.com/bradleyjkemp/cupaloy"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"io"
	"strings"
	"time"
)

func tempoTest() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		axiosBody := func(url string) map[string]interface{} {
			resp, err := axiosGet(url)
			Expect(err).To(BeNil())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).To(BeNil())

			var parsed map[string]interface{}
			err = json.Unmarshal(body, &parsed)
			Expect(err).To(BeNil())
			return parsed
		}
		//It("should read otlp", func() {
		//	traceID := strings.ToUpper(os.Getenv("TEST_TRACE_ID"))
		//	Expect(traceID).NotTo(BeEmpty())
		//	url := fmt.Sprintf("http://%s/api/traces/%s/json", gigaPipeExtUrl, traceID)
		//	data := axiosBody(url)
		//	spans := data["resourceSpans"].([]interface{})[0].(map[string]interface{})["instrumentationLibrarySpans"].([]interface{})[0].(map[string]interface{})["spans"].([]interface{})[0].(map[string]interface{})
		//
		//	delete(spans, "traceID")
		//	delete(spans, "traceId")
		//	delete(spans, "spanID")
		//	delete(spans, "spanId")
		//	delete(spans, "startTimeUnixNano")
		//	delete(spans, "endTimeUnixNano")
		//
		//	if events, ok := spans["events"].([]interface{}); ok && len(events) > 0 {
		//		delete(events[0].(map[string]interface{}), "timeUnixNano")
		//	}
		//
		//	cupaloy.SnapshotT(GinkgoT(), spans)
		//
		//})

		It("should read zipkin", func() {
			time.Sleep(500 * time.Millisecond)
			url := fmt.Sprintf("http://%s/api/traces/0000000000000000d6e9329d67b6146c/json", gigaPipeExtUrl)
			data := axiosBody(url)

			spans := data["resourceSpans"].([]interface{})[0].(map[string]interface{})["instrumentationLibrarySpans"].([]interface{})[0].(map[string]interface{})["spans"].([]interface{})[0].(map[string]interface{})

			Expect(spans["spanID"]).To(Equal("000000001234ef45"))

			delete(spans, "traceID")
			delete(spans, "spanID")
			delete(spans, "spanId")
			delete(spans, "startTimeUnixNano")
			delete(spans, "endTimeUnixNano")

			cupaloy.SnapshotT(GinkgoT(), spans)
		})

		It("should read /tempo/spans", func() {
			time.Sleep(500 * time.Millisecond)
			url := fmt.Sprintf("http://%s/api/traces/0000000000000000d6e9329d67b6146d/json", gigaPipeExtUrl)
			data := axiosBody(url)

			spans := data["resourceSpans"].([]interface{})[0].(map[string]interface{})["instrumentationLibrarySpans"].([]interface{})[0].(map[string]interface{})["spans"].([]interface{})[0].(map[string]interface{})

			Expect(spans["spanID"]).To(Equal("000000001234ef46"))

			delete(spans, "traceID")
			delete(spans, "spanID")
			delete(spans, "spanId")
			delete(spans, "startTimeUnixNano")
			delete(spans, "endTimeUnixNano")

			cupaloy.SnapshotT(GinkgoT(), spans)
		})
		It("should read /api/v2/spans", func() {
			time.Sleep(500 * time.Millisecond)
			url := fmt.Sprintf("http://%s/api/traces/0000000000000000d6e9329d67b6146e/json", gigaPipeExtUrl)
			data := axiosBody(url)

			spans := data["resourceSpans"].([]interface{})[0].(map[string]interface{})["instrumentationLibrarySpans"].([]interface{})[0].(map[string]interface{})["spans"].([]interface{})[0].(map[string]interface{})

			Expect(spans["spanID"]).To(Equal("000000001234ef46"))

			delete(spans, "traceID")
			delete(spans, "spanID")
			delete(spans, "spanId")
			delete(spans, "startTimeUnixNano")
			delete(spans, "endTimeUnixNano")

			cupaloy.SnapshotT(GinkgoT(), spans)
		})

		It("should read /api/search/tags", func() {
			url := fmt.Sprintf("http://%s/api/search/tags", gigaPipeExtUrl)
			data := axiosBody(url)

			tags := data["tagNames"].([]interface{})
			tagSet := make(map[string]bool)
			for _, tag := range tags {
				tagSet[tag.(string)] = true
			}

			for _, expected := range []string{"http.method", "http.path", "service.name", "name"} {
				Expect(tagSet[expected]).To(BeTrue())
			}
		})

		It("should read /api/search/tag/.../values", func() {
			pairs := [][2]string{
				{"http.method", "GET"},
				{"http.path", "/tempo/spans"},
				{"service.name", "node script"},
				{"name", "span from http"},
			}

			for _, pair := range pairs {
				url := fmt.Sprintf("http://%s/api/search/tag/%s/values", gigaPipeExtUrl, pair[0])
				data := axiosBody(url)

				values := data["tagValues"].([]interface{})
				valSet := make(map[string]bool)
				for _, val := range values {
					valSet[val.(string)] = true
				}
				Expect(valSet[pair[1]]).To(BeTrue())
			}
		})

		It("should get /api/search", func() {

			query := fmt.Sprintf("http://%s/api/search?tags=%s&minDuration=900ms&maxDuration=1100ms&start=%d&end=%d",
				gigaPipeExtUrl,
				urlEncode(`service.name="node script"`),
				start,
				end)

			data := axiosBody(query)

			trace := data["traces"].([]interface{})[0].(map[string]interface{})
			delete(trace, "startTimeUnixNano")
			cupaloy.SnapshotT(GinkgoT())
		})

		It("should get /api/echo", func() {
			url := fmt.Sprintf("http://%s/api/echo", gigaPipeExtUrl)
			resp, err := axiosGet(url)
			Expect(err).To(BeNil())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).To(BeNil())
			Expect(strings.TrimSpace(string(body))).To(Equal("echo"))
		})

	})
}
func urlEncode(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, `"`, "%22"), " ", "%20")
}

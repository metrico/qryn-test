package e2e_tests

import (
	"encoding/json"
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"io"
	"net/url"
	"strconv"
	"time"
)

var tracePrefix = (fmt.Sprintf("%x", parseTestID(testID)) + "00000000000000000000000000000")[:29]

func parseTestID(tid string) int64 {
	i, _ := strconv.ParseInt(tid[2:], 10, 64)
	return i
}

func traceqlTest() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		var iTestID = parseTestID(testID)

		It("initialize traces", func() {
			var traces []map[string]interface{}
			for i := start; i < end; i += 600 {
				traceN := (i - start) / 600 / 10
				spanN := (i - start) / 600 % 10
				traceId := (fmt.Sprintf("%x", iTestID) + "00000000000000000000000000000")[:29] +
					fmt.Sprintf("%03x", traceN)
				spanId := fmt.Sprintf("%016x", spanN)
				trace := map[string]interface{}{
					"id":        spanId,
					"traceId":   traceId,
					"timestamp": fmt.Sprintf("%d000", i),
					"duration":  fmt.Sprintf("%d", 1000*spanN),
					"name":      fmt.Sprintf("span from http#%d", spanN),
					"tags": map[string]string{
						"tag-with-dash": "value-with-dash",
						"http.method":   "GET",
						"http.path":     "/api",
						"testId":        testID,
						"spanN":         strconv.Itoa(int(spanN)),
						"traceN":        strconv.Itoa(int(traceN)),
					},
					"localEndpoint": map[string]string{
						"serviceName": "node script",
					},
				}
				traces = append(traces, trace)
			}
			jsonBytes, err := json.Marshal(traces)
			Expect(err).To(BeNil())

			res, err := SendJSONRequest("http://"+gigaPipeWriteUrl+"/tempo/spans", jsonBytes, 5*time.Second)
			Expect(err).To(BeNil())

			fmt.Println("Tempo Res Code", res.StatusCode)
			Expect(res.StatusCode).To(Equal(202))
			time.Sleep(1 * time.Second)
		})

		runTraceQLTest := func(name string, query string) {
			It(name, func() {
				confStart := start / 1000
				confEnd := end/1000 + 1
				limit := 5
				req := fmt.Sprintf("http://%s/api/search?start=%d&end=%d&q=%s&limit=%d",
					gigaPipeExtUrl, confStart, confEnd, url.QueryEscape(query), limit)
				fmt.Println(req)

				data, err := axiosGet(req)
				Expect(err).To(BeNil())
				body, err := io.ReadAll(data.Body)
				Expect(err).To(BeNil())

				var result map[string]interface{}
				err = json.Unmarshal(body, &result)
				Expect(err).To(BeNil())

				traces, ok := result["traces"].([]interface{})
				fmt.Println("resp", string(body))
				Expect(ok).To(BeTrue())
				Expect(len(traces)).To(BeNumerically(">", 0))
			})
		}
		runTraceQLTest("one selector", `{.testId="`+testID+`"}`)
		runTraceQLTest("multiple selectors", `{.testId="`+testID+`" && .spanN=9}`)
		runTraceQLTest("multiple selectors OR Brackets", `{.testId="`+testID+`" && (.spanN=9 || .spanN=8)}`)
		runTraceQLTest("multiple selectors regexp", `{.testId="`+testID+`" && .spanN=~"(9|8)"}`)
		runTraceQLTest("duration", `{.testId="`+testID+`" && duration>=9ms}`)
		runTraceQLTest("float comparison", `{.testId="`+testID+`" && .spanN>=8.9}`)
		runTraceQLTest("count empty result", `{.testId="`+testID+`" && .spanN>=8.9} | count() > 1`)
		runTraceQLTest("count", `{.testId="`+testID+`" && .spanN>=8.9} | count() > 0`)
		runTraceQLTest("max duration empty result", `{.testId="`+testID+`"} | max(duration) > 9ms`)
		runTraceQLTest("max duration", `{.testId="`+testID+`"} | max(duration) > 8ms`)
		runTraceQLTest("tags with dash", `{.testId="`+testID+`" && .tag-with-dash="value-with-dash"} | max(duration) > 8ms`)
		It("hammering selectors", func() {
			ops1 := []string{"=", "!=", "=~", "!~"}
			for _, op := range ops1 {
				q := fmt.Sprintf(`{.testId="%s" && .spanN%s"5"}`, testID, op)
				req := fmt.Sprintf("http://%s/api/search?start=%d&end=%d&q=%s&limit=5",
					gigaPipeExtUrl, start/1000, end/1000, url.QueryEscape(q))
				fmt.Println(req)

				resp, err := axiosGet(req)
				Expect(err).To(BeNil())
				defer resp.Body.Close()
				fmt.Println("resp body....", resp.Body)
				var result map[string]interface{}
				err = json.NewDecoder(resp.Body).Decode(&result)
				Expect(err).To(BeNil())
				fmt.Println("result", result)
				traces, ok := result["traces"].([]interface{})
				Expect(ok).To(BeTrue())
				Expect(len(traces) > 0).To(BeTrue())
			}

			ops2 := []string{">", "<", "=", "!=", ">=", "<="}
			for _, op := range ops2 {
				q := fmt.Sprintf(`{.testId="%s" && .spanN%s5}`, testID, op)
				req := fmt.Sprintf("http://%s/api/search?start=%d&end=%d&q=%s&limit=5",
					gigaPipeExtUrl, start/1000, end/1000, url.QueryEscape(q))
				fmt.Println(req)

				resp, err := axiosGet(req)
				Expect(err).To(BeNil())
				defer resp.Body.Close()

				var result map[string]interface{}
				err = json.NewDecoder(resp.Body).Decode(&result)
				Expect(err).To(BeNil())

				traces, ok := result["traces"].([]interface{})
				Expect(ok).To(BeTrue())
				Expect(len(traces) > 0).To(BeTrue())
			}
		})

		It("hammering aggregators", func() {
			ops := []string{">", "<", "=", "!=", ">=", "<="}
			aggs := []string{"count()", "avg(spanN)", "max(spanN)", "min(spanN)", "sum(spanN)"}

			for _, op := range ops {
				for _, agg := range aggs {
					q := fmt.Sprintf(`{.testId="%s"} | %s %s -1`, testID, agg, op)
					req := fmt.Sprintf("http://%s/api/search?start=%d&end=%d&q=%s&limit=5",
						gigaPipeExtUrl, start/1000, end/1000, url.QueryEscape(q))
					fmt.Println(q)
					fmt.Println(req)
					resp, err := axiosGet(req)
					Expect(err).To(BeNil())
					defer resp.Body.Close()

					body, err := io.ReadAll(resp.Body)
					Expect(err).To(BeNil())
					var result map[string]interface{}
					err = json.Unmarshal(body, &result)
					Expect(err).To(BeNil())
					fmt.Println("")
					traces, ok := result["traces"].([]interface{})
					Expect(ok).To(BeTrue())
					Expect(len(traces) == 0 || (len(traces) != 0 && (op == ">" || op == ">=" || op == "!="))).To(BeTrue())
				}
			}
		})

	})
}

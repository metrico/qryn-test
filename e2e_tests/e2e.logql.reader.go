package e2e_tests

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

type InstantQueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Metric map[string]string `json:"metric"`
			Value  []interface{}     `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

// Response structures
type QueryResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string      `json:"resultType"`
		Result     []LogResult `json:"result"`
	} `json:"data"`
}

type LogResult struct {
	Stream map[string]string `json:"stream"`
	Values [][]interface{}   `json:"values"`
}

type MatrixResult struct {
	Metric map[string]string `json:"metric"`
	Values [][]interface{}   `json:"values"`
}

type MatrixResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string         `json:"resultType"`
		Result     []MatrixResult `json:"result"`
	} `json:"data"`
}

type SeriesResponse struct {
	Status string                   `json:"status"`
	Data   []map[string]interface{} `json:"data"`
}

func runRequest(req string, step interface{}, _start, _end interface{}, oid interface{}, limit interface{}) (*QueryResponse, error) {
	fmt.Println(req)

	if oid == nil {
		oid = "1"
	}
	if limit == nil {
		limit = 2000
	}
	if _start == nil {
		_start = start
	}
	if _end == nil {
		_end = end
	}
	if step == nil {
		step = 2
	}

	startNs := fmt.Sprintf("%d", _start.(int64))
	endNs := fmt.Sprintf("%d", _end.(int64))

	reqURL := fmt.Sprintf("http://%s/loki/api/v1/query_range?direction=BACKWARD&limit=%v&query=%s&start=%s&end=%s&step=%v",
		gigaPipeExtUrl, limit, url.QueryEscape(req), startNs, endNs, step)

	client := &http.Client{}
	httpReq, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("X-Scope-OrgID", oid.(string))
	for k, v := range ExtraHeaders() {
		httpReq.Header.Set(k, v)
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("%s; req: %s", err.Error(), req)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var queryResp QueryResponse
	err = json.Unmarshal(body, &queryResp)
	if err != nil {
		return nil, err
	}

	return &queryResp, nil
}

func adjustResult(resp *QueryResponse, id string, _start interface{}) {
	if id == "" {
		id = testID
	}
	if _start == nil {
		_start = start
	}

	for i := range resp.Data.Result {
		stream := &resp.Data.Result[i]
		testIDValue := stream.Stream["test_id"]
		if testIDValue != "" {
			Expect(strings.HasPrefix(testIDValue, id)).To(BeTrue())
			stream.Stream["test_id"] = "TEST_ID"
		}

		for j := range stream.Values {
			timestamp, _ := strconv.ParseInt(stream.Values[j][0].(string), 10, 64)
			adjustedTime := timestamp - _start.(int64)*1000000
			stream.Values[j][0] = strconv.FormatInt(adjustedTime, 10)
		}
	}
}

func adjustMatrixResult(resp *MatrixResponse, id string) {
	if id == "" {
		id = testID
	}

	for i := range resp.Data.Result {
		metric := &resp.Data.Result[i]
		testIDValue := metric.Metric["test_id"]
		if testIDValue != "" {
			Expect(strings.HasPrefix(testIDValue, id)).To(BeTrue())
			metric.Metric["test_id"] = "TEST_ID"
		}

		for j := range metric.Values {
			if len(metric.Values[j]) >= 2 {
				timestamp := metric.Values[j][0].(float64)
				adjustedTime := timestamp - float64(start/1000)
				metric.Values[j][0] = adjustedTime
			}
		}
	}
}

func runMatrixRequest(req string, step interface{}, _start, _end interface{}) (*MatrixResponse, error) {
	queryResp, err := runRequest(req, step, _start, _end, nil, nil)
	if err != nil {
		return nil, err
	}
	fmt.Println("queryResp", queryResp)
	// Convert to matrix response format
	matrixResp := &MatrixResponse{
		Status: queryResp.Status,
	}
	matrixResp.Data.ResultType = queryResp.Data.ResultType

	// Convert log results to matrix results if needed
	for _, logResult := range queryResp.Data.Result {
		matrixResult := MatrixResult{
			Metric: logResult.Stream,
			Values: make([][]interface{}, len(logResult.Values)),
		}
		for i, val := range logResult.Values {
			matrixResult.Values[i] = []interface{}{val[0], val[1]}
		}
		matrixResp.Data.Result = append(matrixResp.Data.Result, matrixResult)
	}

	return matrixResp, nil
}

func axiosGet(url string) (*http.Response, error) {
	client := &http.Client{}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}

	for k, v := range ExtraHeaders() {
		req.Header.Set(k, v)
	}

	return client.Do(req)
}

func kOrder(m map[string]string) map[string]string {
	// Sort keys for consistent ordering
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	ordered := make(map[string]string)
	for _, k := range keys {
		ordered[k] = m[k]
	}
	return ordered
}

func itShouldStdReq(optsOrName interface{}, req ...string) {
	var opts map[string]interface{}
	var name, query string

	if nameStr, ok := optsOrName.(string); ok {
		// Simple string name case
		name = nameStr
		if len(req) > 0 {
			query = req[0]
		}
		opts = map[string]interface{}{
			"name": name,
			"req":  query,
		}
	} else if optsMap, ok := optsOrName.(map[string]interface{}); ok {
		// Options map case
		opts = optsMap
		name = opts["name"].(string)
		query = opts["req"].(string)
	}

	It(name, func() {
		var step, startTime, endTime, oid, limit interface{}

		if opts["step"] != nil {
			step = opts["step"]
		}
		if opts["start"] != nil {
			startTime = opts["start"]
		}
		if opts["end"] != nil {
			endTime = opts["end"]
		}
		if opts["oid"] != nil {
			oid = opts["oid"]
		}
		if opts["limit"] != nil {
			limit = opts["limit"]
		}

		resp, err := runRequest(query, step, startTime, endTime, oid, limit)
		Expect(err).NotTo(HaveOccurred())

		testIDToUse := testID
		if opts["testID"] != nil {
			testIDToUse = opts["testID"].(string)
		}

		adjustResult(resp, testIDToUse, startTime)

		// Sort results for consistent comparison
		sort.Slice(resp.Data.Result, func(i, j int) bool {
			s1 := fmt.Sprintf("%v", kOrder(resp.Data.Result[i].Stream))
			s2 := fmt.Sprintf("%v", kOrder(resp.Data.Result[j].Stream))
			return s2 < s1 // Note: original JS used reverse comparison
		})

		Expect(resp.Data).NotTo(BeNil())
	})
}

func itShouldMatrixReq(optsOrName interface{}, req ...string) {
	var opts map[string]interface{}
	var name, query string

	if nameStr, ok := optsOrName.(string); ok {
		// Simple string name case
		name = nameStr
		if len(req) > 0 {
			query = req[0]
		}
		opts = map[string]interface{}{
			"name": name,
			"req":  query,
		}
	} else if optsMap, ok := optsOrName.(map[string]interface{}); ok {
		// Options map case
		opts = optsMap
		name = opts["name"].(string)
		query = opts["req"].(string)
	}

	It(name, func() {
		var step, startTime, endTime interface{}

		if opts["step"] != nil {
			step = opts["step"]
		}
		if opts["start"] != nil {
			startTime = opts["start"]
		}
		if opts["end"] != nil {
			endTime = opts["end"]
		}

		resp, err := runMatrixRequest(query, step, startTime, endTime)
		Expect(err).NotTo(HaveOccurred())

		testIDToUse := testID
		if opts["testID"] != nil {
			testIDToUse = opts["testID"].(string)
		}

		adjustMatrixResult(resp, testIDToUse)
		Expect(resp.Data).NotTo(BeNil())
	})
}

func logqlReader() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		// Verify that all writing tests have completed before running any reading tests
		itShouldStdReq(map[string]interface{}{
			"name":  "ok limited res",
			"limit": 2002,
			"req":   fmt.Sprintf(`{test_id="%s"}`, testID),
		})

		itShouldStdReq(map[string]interface{}{
			"name":  "empty res",
			"req":   fmt.Sprintf(`{test_id="%s"}`, testID),
			"step":  2,
			"start": start - 3600*1000,
			"end":   end - 3600*1000,
		})

		itShouldStdReq("two clauses", fmt.Sprintf(`{test_id="%s", freq="2"}`, testID))
		itShouldStdReq("two clauses and filter", fmt.Sprintf(`{test_id="%s", freq="2"} |~ "2[0-9]$"`, testID))

		itShouldMatrixReq("aggregation", fmt.Sprintf(`rate({test_id="%s", freq="2"} |~ "2[0-9]$" [1s])`, testID))
		itShouldMatrixReq("aggregation 1m", fmt.Sprintf(`rate({test_id="%s", freq="2"} [1m])`, testID))
		itShouldMatrixReq("aggregation operator", fmt.Sprintf(`sum by (test_id) (rate({test_id="%s"} |~ "2[0-9]$" [1s]))`, testID))

		itShouldMatrixReq(map[string]interface{}{
			"name":  "aggregation empty",
			"req":   fmt.Sprintf(`rate({test_id="%s", freq="2"} |~ "2[0-9]$" [1s])`, testID),
			"step":  2,
			"start": start - 3600*1000,
			"end":   end - 3600*1000,
		})

		itShouldMatrixReq(map[string]interface{}{
			"name":  "aggregation operator empty",
			"req":   fmt.Sprintf(`sum by (test_id) (rate({test_id="%s"} |~ "2[0-9]$" [1s]))`, testID),
			"step":  2,
			"start": start - 3600*1000,
			"end":   end - 3600*1000,
		})

		itShouldStdReq("json no params", fmt.Sprintf(`{test_id="%s_json"}|json`, testID))
		itShouldStdReq("json params", fmt.Sprintf(`{test_id="%s_json"}|json lbl_repl="new_lbl"`, testID))
		itShouldStdReq("json with params / stream_selector", fmt.Sprintf(`{test_id="%s_json"}|json lbl_repl="new_lbl"|lbl_repl="new_val"`, testID))
		itShouldStdReq("json with params / stream_selector 2", fmt.Sprintf(`{test_id="%s_json"}|json lbl_repl="new_lbl"|fmt="json"`, testID))
		itShouldStdReq("json with no params / stream_selector", fmt.Sprintf(`{test_id="%s_json"}|json|fmt=~"[jk]son"`, testID))
		itShouldStdReq("json with no params / stream_selector 2", fmt.Sprintf(`{test_id="%s_json"}|json|lbl_repl="REPL"`, testID))
		itShouldStdReq("2xjson", fmt.Sprintf(`{test_id="%s_json"}|json|json int_lbl2="int_val"`, testID))
		itShouldStdReq("json + linefmt", fmt.Sprintf(`{test_id="%s_json"}| line_format "{{ div .test_id 2  }}"`, testID))

		itShouldMatrixReq("unwrap", fmt.Sprintf(`sum_over_time({test_id="%s_json"}|json|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID))
		itShouldMatrixReq("unwrap + json params", fmt.Sprintf(`sum_over_time({test_id="%s_json"}|json lbl_int1="int_val"|lbl_repl="val_repl"|unwrap lbl_int1 [3s]) by (test_id, lbl_repl)`, testID))
		itShouldMatrixReq("linefmt + unwrap entry + agg-op", fmt.Sprintf(`rate({test_id="%s_json"}| line_format "{{ div .int_lbl 2  }}" | unwrap _entry [1s])`, testID))
		itShouldMatrixReq("json + LRA + agg-op", fmt.Sprintf(`sum(rate({test_id="%s_json"}| json [5s])) by (test_id)`, testID))
		itShouldMatrixReq("json + params + LRA + agg-op", fmt.Sprintf(`sum(rate({test_id="%s_json"}| json lbl_rrr="lbl_repl" [5s])) by (test_id, lbl_rrr)`, testID))
		itShouldMatrixReq("json + unwrap + 2 x agg-op", fmt.Sprintf(`sum(sum_over_time({test_id="%s_json"}| json | unwrap int_val [10s]) by (test_id, str_id)) by (test_id)`, testID))

		itShouldStdReq(map[string]interface{}{
			"name":  "lineFmt",
			"limit": 2001,
			"req":   fmt.Sprintf(`{test_id="%s"}| line_format "{ \"str\":\"{{._entry}}\", \"freq2\": {{div .freq 2}} }"`, testID),
		})

		itShouldMatrixReq("value comparison + LRA", fmt.Sprintf(`rate({test_id="%s"} [1s]) == 2`, testID))
		itShouldMatrixReq("value comp + LRA + agg-op", fmt.Sprintf(`sum(rate({test_id="%s"} [1s])) by (test_id) > 4`, testID))
		itShouldMatrixReq("value_comp + json + unwrap + 2 x agg-op", fmt.Sprintf(`sum(sum_over_time({test_id="%s_json"}| json | unwrap str_id [10s]) by (test_id, str_id)) by (test_id) > 1000`, testID))
		itShouldMatrixReq("value comp + linefmt + LRA", fmt.Sprintf(`rate({test_id="%s"} | line_format "12345" [1s]) == 2`, testID))

		itShouldStdReq("label comp", fmt.Sprintf(`{test_id="%s"} | freq >= 4`, testID))
		itShouldStdReq("label cmp + json + params", fmt.Sprintf(`{test_id="%s_json"} | json sid="str_id" | sid >= 598`, testID))
		itShouldStdReq("label cmp + json", fmt.Sprintf(`{test_id="%s_json"} | json | str_id >= 598`, testID))
		itShouldStdReq("labels cmp", fmt.Sprintf(`{test_id="%s"} | freq > 1 and (freq="4" or freq==2 or freq > 0.5)`, testID))
		itShouldStdReq("json + params + labels cmp", fmt.Sprintf(`{test_id="%s_json"} | json sid="str_id" | sid >= 598 or sid < 2 and sid > 0`, testID))
		itShouldStdReq("json + labels cmp", fmt.Sprintf(`{test_id="%s_json"} | json | str_id < 2 or str_id >= 598 and str_id > 0`, testID))

		itShouldStdReq("logfmt", fmt.Sprintf(`{test_id="%s_logfmt"}|logfmt`, testID))
		itShouldMatrixReq("logfmt + unwrap + label cmp + agg-op", fmt.Sprintf(`sum_over_time({test_id="%s_logfmt"}|logfmt|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID))
		itShouldMatrixReq("logfmt + LRA + agg-op", fmt.Sprintf(`sum(rate({test_id="%s_logfmt"}| logfmt [5s])) by (test_id)`, testID))
		itShouldMatrixReq("logfmt + unwrap + 2xagg-op", fmt.Sprintf(`sum(sum_over_time({test_id="%s_logfmt"}| logfmt | unwrap int_val [10s]) by (test_id, str_id)) by (test_id)`, testID))
		itShouldMatrixReq("logfmt + unwrap + 2xagg-op + val cmp", fmt.Sprintf(`sum(sum_over_time({test_id="%s_logfmt"}| logfmt | unwrap str_id [10s]) by (test_id, str_id)) by (test_id) > 1000`, testID))
		itShouldStdReq("logfmt + label cmp", fmt.Sprintf(`{test_id="%s_logfmt"} | logfmt | str_id >= 598`, testID))

		itShouldStdReq(map[string]interface{}{
			"name":  "regexp",
			"req":   fmt.Sprintf(`{test_id="%s"} | regexp "^(?P<e>[^0-9]+)[0-9]+$"`, testID),
			"limit": 2002,
		})
		itShouldStdReq(map[string]interface{}{
			"name":  "regexp 2",
			"req":   fmt.Sprintf(`{test_id="%s"} | regexp "^[^0-9]+(?P<e>[0-9])+$"`, testID),
			"limit": 2002,
		})
		itShouldStdReq(map[string]interface{}{
			"name":  "regexp 3",
			"req":   fmt.Sprintf(`{test_id="%s"} | regexp "^[^0-9]+([0-9]+(?P<e>[0-9]))$"`, testID),
			"limit": 2002,
		})
		itShouldMatrixReq(map[string]interface{}{
			"name": "regexp + unwrap + agg-op",
			"req":  fmt.Sprintf(`first_over_time({test_id="%s", freq="0.5"} | regexp "^[^0-9]+(?P<e>[0-9]+)$" | unwrap e [1s]) by(test_id)`, testID),
			"step": 1,
		})

		itShouldMatrixReq("topk", fmt.Sprintf(`topk(1, rate({test_id="%s"}[5s]))`, testID))
		itShouldMatrixReq("topk + sum", fmt.Sprintf(`topk(1, sum(count_over_time({test_id="%s"}[5s])) by (test_id))`, testID))
		itShouldMatrixReq("topk + unwrap", fmt.Sprintf(`topk(1, sum_over_time({test_id="%s_json"} | json f="int_val" | unwrap f [5s]) by (test_id))`, testID))
		itShouldMatrixReq("topk + unwrap + sum", fmt.Sprintf(`topk(1, sum(sum_over_time({test_id=~"%s_json"} | json f="int_val" | unwrap f [5s])) by (test_id))`, testID))
		itShouldMatrixReq("bottomk", fmt.Sprintf(`bottomk(1, rate({test_id="%s"}[5s]))`, testID))
		itShouldMatrixReq("quantile", fmt.Sprintf(`quantile_over_time(0.5, {test_id=~"%s_json"} | json f="int_val" | unwrap f [5s]) by (test_id)`, testID))

		itShouldMatrixReq(map[string]interface{}{
			"name": "json + params + unwrap + agg-op + small step",
			"req":  fmt.Sprintf(`rate({test_id="%s_json"} | json int_val="int_val" | unwrap int_val [1m]) by (test_id)`, testID),
			"step": 0.05,
		})

		It("should handle /series/match", func() {
			hosturl := fmt.Sprintf("http://%s/loki/api/v1/series?match[]={test_id=\"%s\"}&start=%d000000&end=%d000000",
				gigaPipeExtUrl, testID, start, end)

			resp, err := axiosGet(hosturl)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var seriesResp SeriesResponse
			err = json.Unmarshal(body, &seriesResp)
			Expect(err).NotTo(HaveOccurred())

			// Process the response
			for i := range seriesResp.Data {
				if testIDVal, ok := seriesResp.Data[i]["test_id"]; ok {
					Expect(testIDVal).To(Equal(testID))
					seriesResp.Data[i]["test_id"] = "TEST"
				}
			}

			Expect(seriesResp.Data).NotTo(BeNil())

		})

		It("should handle multiple /series/match", func() {
			url := fmt.Sprintf("http://%s/loki/api/v1/series?match[]={test_id=\"%s\"}&match[]={test_id=\"%s_json\"}&start=%d000000&end=%d000000",
				gigaPipeExtUrl, testID, testID, start, end)

			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var seriesResp SeriesResponse
			err = json.Unmarshal(body, &seriesResp)
			Expect(err).NotTo(HaveOccurred())

			Expect(seriesResp.Data).NotTo(BeNil())
		})

		It("should handle /series/match gzipped", func() {
			url := fmt.Sprintf("http://%s/loki/api/v1/series?match[]={test_id=\"%s\"}&start=1636008723293000000&end=1636012323293000000",
				gigaPipeExtUrl, testID)

			client := &http.Client{}
			req, err := http.NewRequest("GET", url, nil)
			Expect(err).NotTo(HaveOccurred())

			req.Header.Set("Accept-Encoding", "gzip")

			resp, err := client.Do(req)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			var reader io.Reader
			if resp.Header.Get("Content-Encoding") == "gzip" {
				gzipReader, err := gzip.NewReader(resp.Body)
				Expect(err).NotTo(HaveOccurred())
				defer gzipReader.Close()
				reader = gzipReader
			} else {
				reader = resp.Body
			}

			body, err := io.ReadAll(reader)
			Expect(err).NotTo(HaveOccurred())

			var data map[string]interface{}
			err = json.Unmarshal(body, &data)
			Expect(err).NotTo(HaveOccurred())

			Expect(resp.StatusCode).To(Equal(200))
			Expect(data).NotTo(BeNil())
		})

		It("should handle labels cmp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s"} | freq > 1 and (freq="4" or freq==2 or freq > 0.5)`, testID), nil, nil, nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", nil)
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle json + params + labels cmp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s_json"} | json sid="str_id" | sid >= 598 or sid < 2 and sid > 0`, testID), nil, nil, nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", nil)
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle json + labels cmp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s_json"} | json | str_id < 2 or str_id >= 598 and str_id > 0`, testID), nil, nil, nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", nil)
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle logfmt", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s_logfmt"}|logfmt`, testID), nil, nil, nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", nil)
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle logfmt + unwrap + label cmp + agg-op", func() {
			resp, err := runMatrixRequest(fmt.Sprintf(`sum_over_time({test_id="%s_logfmt"}|logfmt|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID), nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustMatrixResult(resp, "")
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle regexp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s"} | regexp "^(?P<e>[^0-9]+)[0-9]+$"`, testID), nil, nil, nil, nil, 2002)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", nil)
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle regexp 2", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s"} | regexp "^[^0-9]+(?P<e>[0-9])+$"`, testID), nil, nil, nil, nil, 2002)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", nil)
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle regexp + unwrap + agg-op", func() {
			resp, err := runMatrixRequest(fmt.Sprintf(`first_over_time({test_id="%s", freq="0.5"} | regexp "^[^0-9]+(?P<e>[0-9]+)$" | unwrap e [1s]) by(test_id)`, testID), 1, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustMatrixResult(resp, "")
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle topk", func() {
			resp, err := runMatrixRequest(fmt.Sprintf(`topk(1, rate({test_id="%s"}[5s]))`, testID), nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustMatrixResult(resp, "")
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle bottomk", func() {
			resp, err := runMatrixRequest(fmt.Sprintf(`bottomk(1, rate({test_id="%s"}[5s]))`, testID), nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustMatrixResult(resp, "")
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle quantile", func() {
			resp, err := runMatrixRequest(fmt.Sprintf(`quantile_over_time(0.5, {test_id=~"%s_json"} | json f="int_val" | unwrap f [5s]) by (test_id)`, testID), nil, nil, nil)
			Expect(err).NotTo(HaveOccurred())
			adjustMatrixResult(resp, "")
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should get /loki/api/v1/labels with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))

			url := fmt.Sprintf("http://%s/loki/api/v1/labels?%s", gigaPipeExtUrl, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			Expect(resp.StatusCode).To(Equal(200))
		})

		It("should get /loki/api/v1/label/:name/values with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))

			url := fmt.Sprintf("http://%s/loki/api/v1/label/%s_LBL_LOGS/values?%s", gigaPipeExtUrl, testID, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var labelResp map[string]interface{}
			err = json.Unmarshal(body, &labelResp)
			Expect(err).NotTo(HaveOccurred())

			if data, ok := labelResp["data"].([]interface{}); ok && len(data) > 0 {
				Expect(data[0]).To(Equal("ok"))
			}
		})

		It("should query_instant", func() {
			req := fmt.Sprintf(`{test_id="%s"}`, testID)
			url := fmt.Sprintf("http://%s/loki/api/v1/query?direction=BACKWARD&limit=100&query=%s&time=%d000000",
				gigaPipeExtUrl, url.QueryEscape(req), end)

			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var queryResp QueryResponse
			err = json.Unmarshal(body, &queryResp)
			Expect(err).NotTo(HaveOccurred())

			adjustResult(&queryResp, "", nil)

			// Sort results for consistent comparison
			sort.Slice(queryResp.Data.Result, func(i, j int) bool {
				a := fmt.Sprintf("%v", kOrder(queryResp.Data.Result[i].Stream))
				b := fmt.Sprintf("%v", kOrder(queryResp.Data.Result[j].Stream))
				return a < b
			})

			Expect(queryResp.Data).NotTo(BeNil())
		})

		It("should query_instant vector", func() {
			req := fmt.Sprintf(`count_over_time({test_id="%s"}[1m])`, testID)
			url := fmt.Sprintf("http://%s/loki/api/v1/query?direction=BACKWARD&limit=100&query=%s&time=%d000000",
				gigaPipeExtUrl, url.QueryEscape(req), end)

			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var queryResp InstantQueryResponse
			err = json.Unmarshal(body, &queryResp)
			Expect(err).NotTo(HaveOccurred())

			for i := range queryResp.Data.Result {
				result := &queryResp.Data.Result[i]
				Expect(result.Metric["test_id"]).To(Equal(testID))
				result.Metric["test_id"] = "_TEST_"
				if len(result.Value) >= 2 {
					if timestamp, ok := result.Value[0].(float64); ok {
						result.Value[0] = timestamp - float64(start)/1000
					}
				}
			}

			// Sort results for consistent comparison
			sort.Slice(queryResp.Data.Result, func(i, j int) bool {
				a := fmt.Sprintf("%v", kOrder(queryResp.Data.Result[i].Metric))
				b := fmt.Sprintf("%v", kOrder(queryResp.Data.Result[j].Metric))
				return a < b
			})

			Expect(queryResp.Data).NotTo(BeNil())
		})

		It("should read elastic log", func() {
			req := fmt.Sprintf(`{_index="test_%s"}`, testID)
			url := fmt.Sprintf("http://%s/loki/api/v1/query_range?direction=BACKWARD&limit=2000&query=%s&start=%d000000&end=%d000000",
				gigaPipeExtUrl, url.QueryEscape(req), start, end)

			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var queryResp QueryResponse
			err = json.Unmarshal(body, &queryResp)
			Expect(err).NotTo(HaveOccurred())

			for i := range queryResp.Data.Result {
				result := &queryResp.Data.Result[i]
				expectedIndex := fmt.Sprintf("test_%s", testID)
				Expect(result.Stream["_index"]).To(Equal(expectedIndex))
				result.Stream["_index"] = "_TEST_"

				for j := range result.Values {
					timestamp, err := strconv.ParseInt(result.Values[j][0].(string), 10, 64)
					Expect(err).NotTo(HaveOccurred())
					timestampMs := timestamp / 1000000
					Expect(timestampMs > start).To(BeTrue())
					Expect(timestampMs < time.Now().Unix()).To(BeTrue())
					result.Values[j][0] = ""
				}
			}

			// Sort results for consistent comparison
			sort.Slice(queryResp.Data.Result, func(i, j int) bool {
				a := fmt.Sprintf("%v", queryResp.Data.Result[i].Stream)
				b := fmt.Sprintf("%v", queryResp.Data.Result[j].Stream)
				return a < b
			})

			Expect(queryResp.Data).NotTo(BeNil())
		})

		It("should get /loki/api/v1/labels with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))

			url := fmt.Sprintf("http://%s/loki/api/v1/labels?%s", gigaPipeExtUrl, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var labelResp struct {
				Status string   `json:"status"`
				Data   []string `json:"data"`
			}
			err = json.Unmarshal(body, &labelResp)
			Expect(err).NotTo(HaveOccurred())
			Expect(resp.StatusCode).To(Equal(200))
		})

		It("should get /loki/api/v1/label/:name/values with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))

			labelName := fmt.Sprintf("%s_LBL_LOGS", testID)
			url := fmt.Sprintf("http://%s/loki/api/v1/label/%s/values?%s", gigaPipeExtUrl, labelName, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			var labelResp struct {
				Status string   `json:"status"`
				Data   []string `json:"data"`
			}
			err = json.Unmarshal(body, &labelResp)
			Expect(err).NotTo(HaveOccurred())
			fmt.Println("Body:", string(body))
			fmt.Println(" labelResp", labelResp.Data)
			fmt.Println(":Res", resp.StatusCode)
			Expect(labelResp.Status).To(Equal("success"))
		})

		It("should get /loki/api/v1/label with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))

			url := fmt.Sprintf("http://%s/loki/api/v1/label?%s", gigaPipeExtUrl, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())

			fmt.Println("Body Data:", string(body))
			var labelResp struct {
				Status string   `json:"status"`
				Data   []string `json:"data"`
			}
			err = json.Unmarshal(body, &labelResp)
			Expect(err).NotTo(HaveOccurred())

			//expectedLabel := fmt.Sprintf("%s_LBL_LOGS", testID)
			//found := false
			//for _, label := range labelResp.Data {
			//	if label == expectedLabel {
			//		found = true
			//		break
			//	}
			//}
			//Expect(found).To(BeTrue())
			Expect(labelResp.Status).To(Equal("success"))
		})

		It("should get /loki/api/v1/series with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))
			params.Add("match[]", fmt.Sprintf(`{test_id="%s"}`, testID))

			url := fmt.Sprintf("http://%s/loki/api/v1/series?%s", gigaPipeExtUrl, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()

			body, err := io.ReadAll(resp.Body)
			Expect(err).NotTo(HaveOccurred())
			fmt.Println("Body", string(body))
			var seriesResp SeriesResponse
			err = json.Unmarshal(body, &seriesResp)
			Expect(err).NotTo(HaveOccurred())

			Expect(seriesResp.Data).NotTo(BeEmpty())

		})

	})
}

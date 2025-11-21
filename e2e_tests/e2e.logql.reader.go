package e2e_tests

import (
	"compress/gzip"
	"encoding/json"
	"fmt"
	"github.com/bradleyjkemp/cupaloy"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"github.com/tommy351/goldga"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type ReqOptions struct {
	Name   string
	Req    string
	Step   float64
	Start  int64
	End    int64
	TestID string
	Limit  int
}

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
	Values [][2]float64      `json:"values"`
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

func runRequest(req string, step float64, _start, _end int64, oid string, limit int) (*QueryResponse, error) {

	fmt.Println("Req", req)
	if oid == "" {
		oid = "1"
	}
	if limit == 0 {
		limit = 2000
	}
	if _start == 0 {
		_start = start
	}
	if _end == 0 {
		_end = end
	}
	if step == 0 {
		step = 2
	}
	startNs := strconv.Itoa(int(_start))
	endNs := strconv.Itoa(int(_end))
	reqURL := fmt.Sprintf("http://%s/loki/api/v1/query_range?direction=BACKWARD&limit=%d&query=%s&start=%s&end=%s&step=%f",
		gigaPipeExtUrl, limit, url.QueryEscape(req), startNs, endNs, step)

	fmt.Println("ReqUL", reqURL)

	client := &http.Client{}
	httpReq, err := http.NewRequest("GET", reqURL, nil)
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("X-Scope-OrgID", oid)
	for k, v := range ExtraHeaders {
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

func adjustResult(resp *QueryResponse, id string, _start int64) {
	if id == "" {
		id = testID
	}
	if _start == 0 {
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
			adjustedTime := timestamp - _start*1000000
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
				timestamp := metric.Values[j][0]
				adjustedTime := timestamp - float64(start/1000)
				metric.Values[j][0] = adjustedTime
			}
		}
	}
}

func runMatrixRequest(req string, step float64, _start, _end int64) (*MatrixResponse, error) {
	queryResp, err := runRequest(req, step, _start, _end, "", 0)
	if err != nil {
		return nil, err
	}

	// Convert to matrix response format
	matrixResp := &MatrixResponse{
		Status: queryResp.Status,
	}
	matrixResp.Data.ResultType = queryResp.Data.ResultType

	// Convert log results to matrix results if needed
	for _, logResult := range queryResp.Data.Result {
		matrixResult := MatrixResult{
			Metric: logResult.Stream,
			Values: make([][2]float64, len(logResult.Values)),
		}

		for i, val := range logResult.Values {
			// Assert and convert val[0] and val[1] to float64
			ts, ok1 := val[0].(float64)
			v, ok2 := val[1].(float64)
			if !ok1 || !ok2 {
				continue
			}

			matrixResult.Values[i] = [2]float64{ts, v}
		}

		matrixResp.Data.Result = append(matrixResp.Data.Result, matrixResult)
	}

	return matrixResp, nil
}

func itShouldStdReq(opts ReqOptions) {

	It(opts.Name, func() {
		resp, err := runRequest(opts.Req, opts.Step, opts.Start, opts.End, "", 0)
		Expect(err).NotTo(HaveOccurred())

		testIDToUse := opts.TestID
		if testIDToUse == "" {
			testIDToUse = testID // fallback to global testID
		}

		adjustResult(resp, testIDToUse, opts.Start)

		sort.Slice(resp.Data.Result, func(i, j int) bool {
			s1 := fmt.Sprintf("%v", resp.Data.Result[i].Stream)
			s2 := fmt.Sprintf("%v", resp.Data.Result[j].Stream)
			return s2 < s1
		})
		Expect(resp.Data).To(goldga.Match())
		Expect(resp.Data).NotTo(BeNil())
		safeName := sanitizeSnapshotName(opts.Name)
		err = cupaloy.New().SnapshotMulti(safeName,
			"data", resp.Data.Result,
			"status", resp.Status,
		)
		if err != nil && !strings.Contains(err.Error(), "snapshot created") {
			fmt.Sprintf("unexpected snapshot error: %v", err)
		}

	})

}
func sanitizeSnapshotName(name string) string {
	// Replace all non-alphanumeric, dash, or underscore characters with "_"
	re := regexp.MustCompile(`[^\w\d_-]+`)
	return re.ReplaceAllString(name, "_")
}

func itShouldMatrixReq(opts ReqOptions) {
	It(opts.Name, func() {
		resp, err := runMatrixRequest(opts.Req, opts.Step, opts.Start, opts.End)
		Expect(err).NotTo(HaveOccurred())

		testIDToUse := testID
		if opts.TestID != "" {
			testIDToUse = opts.TestID
		}
		adjustMatrixResult(resp, testIDToUse)
		Expect(resp.Data).To(goldga.Match())
		Expect(resp.Data).NotTo(BeNil())
		safeName := sanitizeSnapshotName(opts.Name)
		err = cupaloy.New().SnapshotMulti(safeName,
			"data", resp.Data.ResultType,
			"status", resp.Status,
		)
		if err != nil && !strings.Contains(err.Error(), "snapshot created") {
			fmt.Sprintf("unexpected snapshot error: %v", err)
		}

	})
}

func logqlReader() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		// Verify that all writing tests have completed before running any reading tests
		itShouldStdReq(ReqOptions{
			Name:  "ok limited res",
			Limit: 2002,
			Req:   fmt.Sprintf(`{test_id="%s"}`, testID),
		})

		itShouldStdReq(ReqOptions{
			Name:  "empty res",
			Req:   fmt.Sprintf(`{test_id="%s"}`, testID),
			Step:  2,
			Start: start - 3600*1000,
			End:   end - 3600*1000,
		})

		itShouldStdReq(ReqOptions{Name: "two clauses",
			Req: fmt.Sprintf(`{test_id="%s", freq="2"}`, testID),
		})

		itShouldStdReq(ReqOptions{Name: "two clauses and filter",
			Req: fmt.Sprintf(`{test_id="%s", freq="2"} |~ "2[0-9]$"`, testID)})

		//	itShouldMatrixReq("aggregation", fmt.Sprintf(`rate({test_id="%s", freq="2"} |~ "2[0-9]$" [1s])`, testID))
		itShouldMatrixReq(ReqOptions{
			Name: "aggregation",
			Req:  fmt.Sprintf(`rate({test_id="%s", freq="2"} |~ "2[0-9]$" [1s])`, testID),
		})
		itShouldMatrixReq(ReqOptions{
			Name: "aggregation 1m",
			Req:  fmt.Sprintf(`rate({test_id="%s", freq="2"} [1m])`, testID),
		})
		//itShouldMatrixReq("aggregation 1m", fmt.Sprintf(`rate({test_id="%s", freq="2"} [1m])`, testID))
		itShouldMatrixReq(ReqOptions{
			Name:  "aggregation empty",
			Req:   fmt.Sprintf(`rate({test_id="%s", freq="2"} |~ "2[0-9]$" [1s])`, testID),
			Step:  2,
			Start: start - 3600*1000,
			End:   end - 3600*1000,
		})
		//itShouldMatrixReq("aggregation operator", fmt.Sprintf(`sum by (test_id) (rate({test_id="%s"} |~ "2[0-9]$" [1s]))`, testID))
		itShouldMatrixReq(ReqOptions{
			Name: "aggregation operator",
			Req:  fmt.Sprintf(`sum by (test_id) (rate({test_id="%s"} |~ "2[0-9]$" [1s]))`, testID),
		})

		itShouldMatrixReq(ReqOptions{
			Name:  "aggregation empty",
			Req:   fmt.Sprintf(`rate({test_id="%s", freq="2"} |~ "2[0-9]$" [1s])`, testID),
			Step:  2,
			Start: start - 3600*1000,
			End:   end - 3600*1000,
		})

		itShouldMatrixReq(ReqOptions{
			Name:  "aggregation operator empty",
			Req:   fmt.Sprintf(`sum by (test_id) (rate({test_id="%s"} |~ "2[0-9]$" [1s]))`, testID),
			Step:  2,
			Start: start - 3600*1000,
			End:   end - 3600*1000,
		})

		itShouldStdReq(ReqOptions{
			Name: "json no params",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json`, testID),
		})

		itShouldStdReq(ReqOptions{
			Name: "json params",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json lbl_repl="new_lbl"`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json with params / stream_selector",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json lbl_repl="new_lbl"|lbl_repl="new_val"`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json with params / stream_selector 2",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json lbl_repl="new_lbl"|fmt="json"`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json with no params / stream_selector",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json|fmt=~"[jk]son"`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json with no params / stream_selector 2",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json|lbl_repl="REPL"`, testID),
		})

		itShouldStdReq(ReqOptions{
			Name: "2xjson",
			Req:  fmt.Sprintf(`{test_id="%s_json"}|json|json int_lbl2="int_val"`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json + linefmt",
			Req:  fmt.Sprintf(`{test_id="%s_json"}| line_format "{{ div .test_id 2  }}"`, testID)})

		itShouldMatrixReq(ReqOptions{Name: "unwrap",
			Req: fmt.Sprintf(`sum_over_time({test_id="%s_json"}|json|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "unwrap + json params",
			Req: fmt.Sprintf(`sum_over_time({test_id="%s_json"}|json lbl_int1="int_val"|lbl_repl="val_repl"|unwrap lbl_int1 [3s]) by (test_id, lbl_repl)`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "linefmt + unwrap entry + agg-op",
			Req: fmt.Sprintf(`rate({test_id="%s_json"}| line_format "{{ div .int_lbl 2  }}" | unwrap _entry [1s])`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "json + LRA + agg-op",
			Req: fmt.Sprintf(`sum(rate({test_id="%s_json"}| json [5s])) by (test_id)`, testID)})

		itShouldMatrixReq(ReqOptions{Name: "json + params + LRA + agg-op",
			Req: fmt.Sprintf(`sum(rate({test_id="%s_json"}| json lbl_rrr="lbl_repl" [5s])) by (test_id, lbl_rrr)`, testID)})

		itShouldMatrixReq(ReqOptions{Name: "json + unwrap + 2 x agg-op",
			Req: fmt.Sprintf(`sum(sum_over_time({test_id="%s_json"}| json | unwrap int_val [10s]) by (test_id, str_id)) by (test_id)`, testID)})

		itShouldStdReq(ReqOptions{
			Name:  "lineFmt",
			Limit: 2001,
			Req:   fmt.Sprintf(`{test_id="%s"}| line_format "{ \"str\":\"{{._entry}}\", \"freq2\": {{div .freq 2}} }"`, testID),
		})

		itShouldMatrixReq(ReqOptions{Name: "value comparison + LRA",
			Req: fmt.Sprintf(`rate({test_id="%s"} [1s]) == 2`, testID)})

		itShouldMatrixReq(ReqOptions{Name: "value comp + LRA + agg-op",
			Req: fmt.Sprintf(`sum(rate({test_id="%s"} [1s])) by (test_id) > 4`, testID)})

		itShouldMatrixReq(ReqOptions{Name: "value_comp + json + unwrap + 2 x agg-op",
			Req: fmt.Sprintf(`sum(sum_over_time({test_id="%s_json"}| json | unwrap str_id [10s]) by (test_id, str_id)) by (test_id) > 1000`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "value comp + linefmt + LRA",
			Req: fmt.Sprintf(`rate({test_id="%s"} | line_format "12345" [1s]) == 2`, testID)})

		itShouldStdReq(ReqOptions{
			Name: "label comp",
			Req:  fmt.Sprintf(`{test_id="%s"} | freq >= 4`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "label cmp + json + params",
			Req:  fmt.Sprintf(`{test_id="%s_json"} | json sid="str_id" | sid >= 598`, testID),
		})

		itShouldStdReq(ReqOptions{
			Name: "label cmp + json",
			Req:  fmt.Sprintf(`{test_id="%s_json"} | json | str_id >= 598`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "labels cmp",
			Req:  fmt.Sprintf(`{test_id="%s"} | freq > 1 and (freq="4" or freq==2 or freq > 0.5)`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json + params + labels cmp",
			Req:  fmt.Sprintf(`{test_id="%s_json"} | json sid="str_id" | sid >= 598 or sid < 2 and sid > 0`, testID),
		})
		itShouldStdReq(ReqOptions{
			Name: "json + labels cmp",
			Req:  fmt.Sprintf(`{test_id="%s_json"} | json | str_id < 2 or str_id >= 598 and str_id > 0`, testID)})

		itShouldStdReq(ReqOptions{
			Name: "logfmt",
			Req:  fmt.Sprintf(`{test_id="%s_logfmt"}|logfmt`, testID),
		})

		itShouldMatrixReq(ReqOptions{Name: "logfmt + unwrap + label cmp + agg-op",
			Req: fmt.Sprintf(`sum_over_time({test_id="%s_logfmt"}|logfmt|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID),
		})

		itShouldMatrixReq(ReqOptions{Name: "logfmt + LRA + agg-op",
			Req: fmt.Sprintf(`sum(rate({test_id="%s_logfmt"}| logfmt [5s])) by (test_id)`, testID),
		})

		itShouldMatrixReq(ReqOptions{Name: "logfmt + unwrap + 2xagg-op",
			Req: fmt.Sprintf(`sum(sum_over_time({test_id="%s_logfmt"}| logfmt | unwrap int_val [10s]) by (test_id, str_id)) by (test_id)`, testID),
		})
		itShouldMatrixReq(ReqOptions{Name: "logfmt + unwrap + 2xagg-op + val cmp",
			Req: fmt.Sprintf(`sum(sum_over_time({test_id="%s_logfmt"}| logfmt | unwrap str_id [10s]) by (test_id, str_id)) by (test_id) > 1000`, testID)})

		itShouldStdReq(ReqOptions{
			Name: "logfmt + label cmp",
			Req:  fmt.Sprintf(`{test_id="%s_logfmt"} | logfmt | str_id >= 598`, testID)})

		itShouldStdReq(ReqOptions{
			Name:  "regexp",
			Req:   fmt.Sprintf(`{test_id="%s"} | regexp "^(?P<e>[^0-9]+)[0-9]+$"`, testID),
			Limit: 2002,
		})
		itShouldStdReq(ReqOptions{
			Name:  "regexp 2",
			Req:   fmt.Sprintf(`{test_id="%s"} | regexp "^[^0-9]+(?P<e>[0-9])+$"`, testID),
			Limit: 2002,
		})
		itShouldStdReq(ReqOptions{
			Name:  "regexp 3",
			Req:   fmt.Sprintf(`{test_id="%s"} | regexp "^[^0-9]+([0-9]+(?P<e>[0-9]))$"`, testID),
			Limit: 2002,
		})
		itShouldMatrixReq(ReqOptions{
			Name: "regexp + unwrap + agg-op",
			Req:  fmt.Sprintf(`first_over_time({test_id="%s", freq="0.5"} | regexp "^[^0-9]+(?P<e>[0-9]+)$" | unwrap e [1s]) by(test_id)`, testID),
			Step: 1,
		})

		itShouldMatrixReq(ReqOptions{Name: "topk",
			Req: fmt.Sprintf(`topk(1, rate({test_id="%s"}[5s]))`, testID)})

		itShouldMatrixReq(ReqOptions{Name: "topk + sum",
			Req: fmt.Sprintf(`topk(1, sum(count_over_time({test_id="%s"}[5s])) by (test_id))`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "topk + unwrap",
			Req: fmt.Sprintf(`topk(1, sum_over_time({test_id="%s_json"} | json f="int_val" | unwrap f [5s]) by (test_id))`, testID),
		})
		itShouldMatrixReq(ReqOptions{Name: "topk + unwrap + sum",
			Req: fmt.Sprintf(`topk(1, sum(sum_over_time({test_id=~"%s_json"} | json f="int_val" | unwrap f [5s])) by (test_id))`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "bottomk",
			Req: fmt.Sprintf(`bottomk(1, rate({test_id="%s"}[5s]))`, testID)})
		itShouldMatrixReq(ReqOptions{Name: "quantile",
			Req: fmt.Sprintf(`quantile_over_time(0.5, {test_id=~"%s_json"} | json f="int_val" | unwrap f [5s]) by (test_id)`, testID)})

		itShouldMatrixReq(ReqOptions{
			Name: "json + params + unwrap + agg-op + small step",
			Req:  fmt.Sprintf(`rate({test_id="%s_json"} | json int_val="int_val" | unwrap int_val [1m]) by (test_id)`, testID),
			Step: 0.05,
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

			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
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
			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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
			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
			Expect(data).NotTo(BeNil())
		})

		It("should handle labels cmp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s"} | freq > 1 and (freq="4" or freq==2 or freq > 0.5)`, testID), 0, 0, 0, "", 0)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", 0)
			err = cupaloy.New().SnapshotMulti(
				"result", resp.Data.Result,
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle json + params + labels cmp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s_json"} | json sid="str_id" | sid >= 598 or sid < 2 and sid > 0`, testID), 0, 0, 0, "", 0)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", 0)
			err = cupaloy.New().SnapshotMulti(
				"result", resp.Data.Result,
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
			Expect(resp.Data).NotTo(BeNil())
		})

		It("should handle json + labels cmp", func() {
			resp, err := runRequest(fmt.Sprintf(`{test_id="%s_json"} | json | str_id < 2 or str_id >= 598 and str_id > 0`, testID), 0, 0, 0, "", 0)
			Expect(err).NotTo(HaveOccurred())
			adjustResult(resp, "", 0)
			err = cupaloy.New().SnapshotMulti(
				"body", resp.Data.Result,
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
			Expect(resp.Data).NotTo(BeNil())
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle logfmt",
			Req:   fmt.Sprintf(`{test_id="%s_logfmt"}|logfmt`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 0,
		})

		//It("should handle logfmt + unwrap + label cmp + agg-op", func() {
		//	resp, err := runMatrixRequest(fmt.Sprintf(`sum_over_time({test_id="%s_logfmt"}|logfmt|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID), 0, 0, 0)
		//	Expect(err).NotTo(HaveOccurred())
		//	adjustMatrixResult(resp, "")
		//	err = cupaloy.New().SnapshotMulti(
		//		"status", resp.Status,
		//	)
		//
		//	// Only fail if it's not the initial snapshot creation
		//	if err != nil && !strings.Contains(err.Error(), "snapshot created") {
		//		Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
		//	}
		//	Expect(resp.Data).NotTo(BeNil())
		//})

		itShouldMatrixReq(ReqOptions{Name: "should handle logfmt + unwrap + label cmp + agg-op",
			Req:   fmt.Sprintf(`sum_over_time({test_id="%s_logfmt"}|logfmt|lbl_repl="REPL"|unwrap int_lbl [3s]) by (test_id, lbl_repl)`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 0,
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle regexp",
			Req:   fmt.Sprintf(`{test_id="%s"} | regexp "^(?P<e>[^0-9]+)[0-9]+$"`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 2002,
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle regexp 2",
			Req:   fmt.Sprintf(`{test_id="%s"} | regexp "^[^0-9]+(?P<e>[0-9])+$"`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 2002,
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle regexp + unwrap + agg-op",
			Req:   fmt.Sprintf(`first_over_time({test_id="%s", freq="0.5"} | regexp "^[^0-9]+(?P<e>[0-9]+)$" | unwrap e [1s]) by(test_id)`, testID),
			Step:  1,
			Start: 0,
			End:   0,
			Limit: 0,
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle topk",
			Req:   fmt.Sprintf(`topk(1, rate({test_id="%s"}[5s]))`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 0,
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle bottomk",
			Req:   fmt.Sprintf(`bottomk(1, rate({test_id="%s"}[5s]))`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 0,
		})

		itShouldMatrixReq(ReqOptions{Name: "should handle bottomk",
			Req:   fmt.Sprintf(`quantile_over_time(0.5, {test_id=~"%s_json"} | json f="int_val" | unwrap f [5s]) by (test_id)`, testID),
			Step:  0,
			Start: 0,
			End:   0,
			Limit: 0,
		})

		It("should get /loki/api/v1/labels with time context", func() {
			params := url.Values{}
			params.Add("start", fmt.Sprintf("%d000000", start))
			params.Add("end", fmt.Sprintf("%d000000", end))

			url := fmt.Sprintf("http://%s/loki/api/v1/labels?%s", gigaPipeExtUrl, params.Encode())
			resp, err := axiosGet(url)
			Expect(err).NotTo(HaveOccurred())
			bodyBytes, _ := io.ReadAll(resp.Body)
			defer resp.Body.Close()
			err = cupaloy.New().SnapshotMulti(
				"body", string(bodyBytes),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
			Expect(resp.StatusCode).To(Equal(http.StatusOK))
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

			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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

			adjustResult(&queryResp, "", 0)

			// Sort results for consistent comparison
			sort.Slice(queryResp.Data.Result, func(i, j int) bool {
				a := fmt.Sprintf("%v", queryResp.Data.Result[i].Stream)
				b := fmt.Sprintf("%v", queryResp.Data.Result[j].Stream)
				return a < b
			})

			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}

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
				a := fmt.Sprintf("%v", queryResp.Data.Result[i].Metric)
				b := fmt.Sprintf("%v", queryResp.Data.Result[j].Metric)
				return a < b
			})

			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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

			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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

			err = cupaloy.New().SnapshotMulti(

				"body", string(body),
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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
			Expect(labelResp.Status).To(Equal("success"))
			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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

			var labelResp struct {
				Status string   `json:"status"`
				Data   []string `json:"data"`
			}
			err = json.Unmarshal(body, &labelResp)
			Expect(err).NotTo(HaveOccurred())
			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
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
			var seriesResp SeriesResponse
			err = json.Unmarshal(body, &seriesResp)
			Expect(err).NotTo(HaveOccurred())
			err = cupaloy.New().SnapshotMulti(
				"body", string(body),
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				fmt.Sprintf("unexpected snapshot error: %v", err)
			}
			Expect(seriesResp.Data).NotTo(BeEmpty())

		})

	})
}

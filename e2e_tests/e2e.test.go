package e2e_tests

import (
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	"net/http"
)

// Helper function equivalent to axiosGet
func httpGet(url string) error {
	resp, err := http.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	fmt.Println(resp.StatusCode)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("HTTP error: %d", resp.StatusCode)
	}
	return nil
}
func healthCheck() {
	It("qryn should work", func() {
		retries := 0
		for {
			err1 := httpGet(fmt.Sprintf("http://%s/ready", gigaPipeWriteUrl))
			err2 := httpGet(fmt.Sprintf("http://%s/ready", gigaPipeExtUrl))

			if err1 == nil && err2 == nil {
				break
			}

			if retries >= 10 {
				if err1 != nil {
					Fail(fmt.Sprintf("Write URL check failed after retries: %v", err1))
				}
				if err2 != nil {
					Fail(fmt.Sprintf("Ext URL check failed after retries: %v", err2))
				}
			}

			retries++
		}
	})

	//It("should check alert config", func() {
	//	type AlertRule struct {
	//		Alert       string            `yaml:"alert"`
	//		For         string            `yaml:"for"`
	//		Annotations map[string]string `yaml:"annotations"`
	//		Labels      map[string]string `yaml:"labels"`
	//		Expr        string            `yaml:"expr"`
	//	}
	//
	//	type RuleGroup struct {
	//		Name     string      `yaml:"name"`
	//		Interval string      `yaml:"interval"`
	//		Rules    []AlertRule `yaml:"rules"`
	//	}
	//
	//	// Create the rule config
	//	rule := AlertRule{
	//		Alert:       "test_rul",
	//		For:         "1m",
	//		Annotations: map[string]string{"summary": "ssssss"},
	//		Labels:      map[string]string{"lllll": "vvvvv"},
	//		Expr:        `{test_id="alert_test"}`,
	//	}
	//
	//	ruleGroup := RuleGroup{
	//		Name:     "test_group",
	//		Interval: "1s",
	//		Rules:    []AlertRule{rule},
	//	}
	//
	//	yamlData, err := yaml.Marshal(ruleGroup)
	//	Expect(err).NotTo(HaveOccurred())
	//
	//	// POST the rule config
	//	client := &http.Client{}
	//	req, err := http.NewRequest("POST", "http://localhost:3215/api/prom/rules/test_ns", strings.NewReader(string(yamlData)))
	//	Expect(err).NotTo(HaveOccurred())
	//
	//	req.Header.Set("Content-Type", "application/yaml")
	//	resp, err := client.Do(req)
	//	Expect(err).NotTo(HaveOccurred())
	//	defer resp.Body.Close()
	//
	//	// Check response status
	//	Expect(resp.StatusCode).To(Equal(http.StatusOK))
	//
	//	// GET the rules and verify
	//	ruleResp, err := http.Get("http://localhost:3215/api/prom/rules")
	//	Expect(err).NotTo(HaveOccurred())
	//	defer ruleResp.Body.Close()
	//
	//	// Parse the response
	//	var result map[string][]RuleGroup
	//	decoder := yaml.NewDecoder(ruleResp.Body)
	//	err = decoder.Decode(&result)
	//	Expect(err).NotTo(HaveOccurred())
	//
	//	// Verify the rule has been created correctly
	//	Expect(result).To(HaveKey("test_ns"))
	//	Expect(result["test_ns"]).To(HaveLen(1))
	//	Expect(result["test_ns"][0].Name).To(Equal("test_group"))
	//	Expect(result["test_ns"][0].Interval).To(Equal("1s"))
	//	Expect(result["test_ns"][0].Rules).To(HaveLen(1))
	//	Expect(result["test_ns"][0].Rules[0].Alert).To(Equal("test_rul"))
	//	Expect(result["test_ns"][0].Rules[0].For).To(Equal("1m"))
	//	Expect(result["test_ns"][0].Rules[0].Annotations).To(HaveKeyWithValue("summary", "ssssss"))
	//	Expect(result["test_ns"][0].Rules[0].Labels).To(HaveKeyWithValue("lllll", "vvvvv"))
	//	Expect(result["test_ns"][0].Rules[0].Expr).To(Equal(`{test_id="alert_test"}`))
	//
	//	// Clean up by deleting the rule namespace
	//	defer func() {
	//		deleteReq, err := http.NewRequest("DELETE", "http://localhost:3215/api/prom/rules/test_ns", nil)
	//		if err == nil {
	//			client.Do(deleteReq)
	//		}
	//	}()
	//})
}

//var _ = Describe("Qryn Tests", func() {
//
//})

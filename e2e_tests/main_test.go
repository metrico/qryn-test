package e2e_tests

import (
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	"net/http"
	"testing"

	. "github.com/onsi/gomega"
)

// TestE2E is the entry point for the Ginkgo test suite
func TestE2E(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "E2E Test Suite")
}

var _ = Describe("E2E Tests", Ordered, func() {
	healthCheck()
	writingTests()
	readingTests()
})

func readingTests() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		// Verify that all writing tests have completed before running any reading tests
		BeforeAll(func() {
			Expect(writingCompleted).To(BeTrue(), "Reading tests should only run after writing tests have completed")
			fmt.Println("Starting reading tests - confirmed writing tests are complete")
		})
		logqlReader()
		tempoTest()
		miscTest()
		//traceqlTest()
		pprofTest()

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
}

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

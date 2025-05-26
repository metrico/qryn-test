package e2e_tests

import (
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"testing"
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
		traceqlTest()
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
}

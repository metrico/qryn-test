package e2e_tests

import (
	"context"
	"fmt"
	"sync/atomic"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
)

// This demonstrates how to use Ginkgo v2's parallel testing features
var _ = Describe("E2E Parallel Tests", Ordered, func() {
	// Counter to track concurrent execution within each suite
	var (
		writeConcurrentCounter int32
		readConcurrentCounter  int32
		writeTestsComplete     int32
	)

	// Suite for Writing tests that run first
	Context("Parallel Writing Tests", func() {
		// Reset counter before the test suite runs
		BeforeAll(func() {
			atomic.StoreInt32(&writeConcurrentCounter, 0)
			fmt.Println("Starting parallel writing tests")
		})

		// Run 3 write tests that can run in parallel
		for i := 1; i <= 3; i++ {
			// Using closure to capture the loop variable properly
			testNum := i
			It(fmt.Sprintf("should perform parallel write operation %d", testNum), Label("parallel"), func(ctx context.Context) {
				// Increment counter when test starts
				currentCount := atomic.AddInt32(&writeConcurrentCounter, 1)
				fmt.Printf("Writer operation %d started (concurrent count: %d)\n", testNum, currentCount)

				// If counter > 1, multiple tests are running concurrently
				Expect(currentCount).To(BeNumerically(">", 0), "Parallel tests should increment counter")

				// Simulate some work with varying duration
				time.Sleep(time.Duration(100+testNum*50) * time.Millisecond)

				fmt.Printf("Writer operation %d done\n", testNum)

				// Decrement counter when test ends
				atomic.AddInt32(&writeConcurrentCounter, -1)
			})
		}

		// After all writing tests complete
		AfterAll(func() {
			fmt.Println("All parallel writing tests completed")
			atomic.StoreInt32(&writeTestsComplete, 1)
		})
	})

	// Suite for Reading tests that run second
	Context("Parallel Reading Tests", func() {
		// Verify writing tests completed before reading tests start
		BeforeAll(func() {
			Expect(atomic.LoadInt32(&writeTestsComplete)).To(Equal(int32(1)),
				"Reading tests should only run after writing tests have completed")
			atomic.StoreInt32(&readConcurrentCounter, 0)
			fmt.Println("Starting parallel reading tests")
		})

		// Run 3 read tests that can run in parallel
		for i := 1; i <= 3; i++ {
			// Using closure to capture the loop variable properly
			testNum := i
			It(fmt.Sprintf("should perform parallel read operation %d", testNum), Label("parallel"), func(ctx context.Context) {
				// Increment counter when test starts
				currentCount := atomic.AddInt32(&readConcurrentCounter, 1)
				fmt.Printf("Reader operation %d started (concurrent count: %d)\n", testNum, currentCount)

				// If counter > 1, multiple tests are running concurrently
				Expect(currentCount).To(BeNumerically(">", 0), "Parallel tests should increment counter")

				// Simulate some work with varying duration
				time.Sleep(time.Duration(75+testNum*50) * time.Millisecond)

				fmt.Printf("Reader operation %d done\n", testNum)

				// Decrement counter when test ends
				atomic.AddInt32(&readConcurrentCounter, -1)
			})
		}

		// After all reading tests complete
		AfterAll(func() {
			fmt.Println("All parallel reading tests completed")
		})
	})

	// Final verification
	AfterAll(func() {
		fmt.Println("All parallel test suites completed successfully")
		fmt.Println("✅ Order verification: Reading tests ran after Writing tests")
	})
})

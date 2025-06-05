package e2e_tests

import (
	"fmt"
	"github.com/bradleyjkemp/cupaloy"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"strings"

	"os"
)

func miscTest() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		It("should get /ready", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/ready", gigaPipeExtUrl))
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(200))
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

		It("should get /metrics", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/metrics", gigaPipeExtUrl))
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(200))
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

		It("should get /config", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/config", gigaPipeExtUrl))
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(200))
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

		It("should get /api/v1/rules", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/api/v1/rules", gigaPipeExtUrl))
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(200))
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

		It("should get /api/v1/metadata", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/api/v1/metadata", gigaPipeExtUrl))
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(200))
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

		It("should get /api/v1/status/buildinfo", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/api/v1/status/buildinfo", gigaPipeExtUrl))
			Expect(err).ToNot(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(200))
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

		It("should return 401 if no basic auth", func() {
			qrynLogin := os.Getenv("QRYN_LOGIN")
			if qrynLogin == "" {
				Skip("QRYN_LOGIN environment variable not set")
			}

			//headers := map[string]string{
			//	"Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte("a")),
			//}

			resp, err := axiosGet(fmt.Sprintf("http://%s/influx/api/v2/write/health", gigaPipeExtUrl))

			if err != nil {
				// Check if the error message contains status code 401
				Expect(err.Error()).To(ContainSubstring("401"))
			} else {
				defer resp.Body.Close()
				Expect(resp.StatusCode).To(Equal(401))
			}
			err = cupaloy.New().SnapshotMulti(
				"status", resp.Status,
			)

			// Only fail if it's not the initial snapshot creation
			if err != nil && !strings.Contains(err.Error(), "snapshot created") {
				Fail(fmt.Sprintf("unexpected snapshot error: %v", err))
			}
		})

	})

}

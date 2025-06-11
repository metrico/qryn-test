package e2e_tests

import (
	"fmt"
	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"net/http"
	"os"
)

func miscTest() {
	// ReadingTests suite runs after WritingTests
	Context("Reading Tests", func() {
		It("should get /ready", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/ready", gigaPipeExtUrl))
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))
		})

		It("should get /metrics", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/metrics", gigaPipeExtUrl))
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

		})

		It("should get /config", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/config", gigaPipeExtUrl))
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

		})

		It("should get /api/v1/rules", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/api/v1/rules", gigaPipeExtUrl))
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

		})

		It("should get /api/v1/metadata", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/api/v1/metadata", gigaPipeExtUrl))
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

		})

		It("should get /api/v1/status/buildinfo", func() {
			resp, err := axiosGet(fmt.Sprintf("http://%s/api/v1/status/buildinfo", gigaPipeExtUrl))
			Expect(err).NotTo(HaveOccurred())
			defer resp.Body.Close()
			Expect(resp.StatusCode).To(Equal(http.StatusOK))

		})

		It("should return 401 if no basic auth", func() {
			qrynLogin := os.Getenv("QRYN_LOGIN")
			if qrynLogin == "" {
				Skip("QRYN_LOGIN environment variable not set")
			}

			resp, err := axiosGet(fmt.Sprintf("http://%s/influx/api/v2/write/health", gigaPipeExtUrl))

			if err != nil {
				// Check if the error message contains status code 401
				Expect(err.Error()).To(ContainSubstring("401"))
			} else {
				defer resp.Body.Close()
				Expect(resp.StatusCode).To(Equal(http.StatusUnauthorized))
			}

		})

	})

}

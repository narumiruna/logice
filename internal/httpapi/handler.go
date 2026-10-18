package httpapi

import (
	"io"
	"net/http"
)

// newHandler serves liveness only. It does not check application readiness.
func newHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Err() != nil {
			return
		}
		if r.URL.Path != "/api/healthz" {
			writeJSON(w, http.StatusNotFound, `{"error":{"code":"not_found","message":"route not found"}}`)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			writeJSON(w, http.StatusMethodNotAllowed, `{"error":{"code":"method_not_allowed","message":"method not allowed"}}`)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		writeJSON(w, http.StatusOK, `{"status":"ok"}`)
	})
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// A disconnected client needs no additional response.
	_, _ = io.WriteString(w, body+"\n")
}

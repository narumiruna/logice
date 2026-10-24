package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

// newHandler keeps liveness independent of the optional telemetry reader.
func newHandler(readers ...telemetry.Reader) http.Handler {
	var reader telemetry.Reader
	if len(readers) > 0 {
		reader = readers[0]
	}
	live := newLiveHandler(reader)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Err() != nil {
			return
		}
		if r.URL.Path == "/api/healthz" {
			if r.Method != http.MethodGet && r.Method != http.MethodHead {
				methodNotAllowed(w, "GET, HEAD")
				return
			}
			w.Header().Set("Content-Type", "application/json")
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusOK)
				return
			}
			writeJSON(w, http.StatusOK, `{"status":"ok"}`)
			return
		}

		if r.URL.Path == "/api/overview" {
			serveOverview(reader, w, r)
			return
		}
		if r.URL.Path == "/api/live" {
			live.ServeHTTP(w, r)
			return
		}

		var route, traceID string
		switch {
		case r.URL.Path == "/api/traces":
			route = "traces"
		case r.URL.Path == "/api/logs":
			route = "logs"
		case strings.HasPrefix(r.URL.Path, "/api/traces/"):
			traceID = strings.TrimPrefix(r.URL.Path, "/api/traces/")
			if traceID != "" && !strings.Contains(traceID, "/") {
				route = "detail"
			}
		}
		if route == "" {
			writeError(w, http.StatusNotFound, "not_found", "route not found")
			return
		}
		if r.Method != http.MethodGet {
			methodNotAllowed(w, "GET")
			return
		}
		filter, err := parseFilter(r.URL.RawQuery, route, traceID, time.Now().UTC())
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
			return
		}
		if reader == nil {
			writeUnavailable(w)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		var body any
		switch route {
		case "traces":
			var result telemetry.TraceList
			result, err = reader.Traces(ctx, filter)
			if result.Items == nil {
				result.Items = []telemetry.TraceSummary{}
			}
			body = result
		case "logs":
			var result telemetry.LogList
			result, err = reader.Logs(ctx, filter)
			if result.Items == nil {
				result.Items = []telemetry.Log{}
			}
			body = result
		case "detail":
			var result telemetry.TraceDetail
			result, err = reader.Trace(ctx, filter.TraceID, filter)
			if result.Spans == nil {
				result.Spans = []telemetry.Span{}
			}
			if result.Logs == nil {
				result.Logs = []telemetry.Log{}
			}
			body = result
		}
		if r.Context().Err() != nil {
			return
		}
		if errors.Is(err, telemetry.ErrNotFound) && route == "detail" {
			writeError(w, http.StatusNotFound, "not_found", "trace not found")
			return
		}
		if err != nil || ctx.Err() != nil {
			writeUnavailable(w)
			return
		}
		encoded, err := json.Marshal(body)
		if err != nil {
			writeUnavailable(w)
			return
		}
		writeJSON(w, http.StatusOK, string(encoded))
	})
}

func methodNotAllowed(w http.ResponseWriter, allow string) {
	w.Header().Set("Allow", allow)
	writeError(w, http.StatusMethodNotAllowed, "method_not_allowed", "method not allowed")
}

func writeUnavailable(w http.ResponseWriter) {
	writeError(w, http.StatusServiceUnavailable, "unavailable", "telemetry storage unavailable")
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	body := struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{}
	body.Error.Code, body.Error.Message = code, message
	encoded, _ := json.Marshal(body)
	writeJSON(w, status, string(encoded))
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// A disconnected client needs no additional response.
	_, _ = io.WriteString(w, body+"\n")
}

package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

func serveOverview(reader telemetry.Reader, w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		methodNotAllowed(w, "GET")
		return
	}
	q := r.URL.Query()
	for k, v := range q {
		if len(v) != 1 || (k != "from" && k != "to" && k != "service") {
			writeError(w, 400, "invalid_query", "Use from, to, and optional service only.")
			return
		}
	}
	if q.Has("from") != q.Has("to") {
		writeError(w, 400, "invalid_query", "Set both UTC bounds.")
		return
	}
	f, err := parseFilter(r.URL.RawQuery, "traces", "", time.Now().UTC())
	if err != nil {
		writeError(w, 400, "invalid_query", err.Error())
		return
	}
	source, ok := reader.(telemetry.OverviewReader)
	if !ok {
		writeUnavailable(w)
		return
	}
	result, err := source.Overview(r.Context(), f)
	if errors.Is(err, telemetry.ErrOverviewBusy) {
		w.Header().Set("Retry-After", "2")
		writeError(w, 429, "overloaded", "Overview query capacity is full.")
		return
	}
	if err != nil {
		writeUnavailable(w)
		return
	}
	data, err := json.Marshal(result)
	if err != nil {
		writeUnavailable(w)
		return
	}
	writeJSON(w, 200, string(data))
}

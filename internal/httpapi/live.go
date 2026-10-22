package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/narumiruna/logice/internal/telemetry"
)

const liveResponseLimit = 4 << 20

func parseLiveFilter(raw string, now time.Time) (telemetry.LiveFilter, error) {
	f := telemetry.LiveFilter{From: now.Add(-5 * time.Minute).UTC(), To: now.UTC()}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return f, errors.New("invalid query parameters")
	}
	allowed := map[string]bool{"range": true, "from": true, "to": true, "service": true, "search": true, "errorsOnly": true, "minSeverity": true}
	for key, entries := range values {
		if !allowed[key] {
			return f, errors.New("unknown query parameter")
		}
		if len(entries) != 1 {
			return f, errors.New("duplicate query parameter")
		}
		if !utf8.ValidString(entries[0]) {
			return f, errors.New("invalid query encoding")
		}
	}
	if values.Has("range") && (values.Has("from") || values.Has("to")) {
		return f, errors.New("range cannot be combined with from or to")
	}
	if values.Has("from") != values.Has("to") {
		return f, errors.New("from and to must be supplied together")
	}
	if values.Has("range") {
		duration, ok := map[string]time.Duration{"1m": time.Minute, "5m": 5 * time.Minute, "15m": 15 * time.Minute}[values.Get("range")]
		if !ok {
			return f, errors.New("range must be 1m, 5m, or 15m")
		}
		f.From = f.To.Add(-duration)
	}
	if values.Has("from") {
		if !liveTimestampPattern.MatchString(values.Get("from")) || !liveTimestampPattern.MatchString(values.Get("to")) {
			return f, errors.New("bounds must be RFC3339 timestamps with at most nine fractional digits")
		}
		f.From, err = time.Parse(time.RFC3339Nano, values.Get("from"))
		if err != nil {
			return f, errors.New("from must be an RFC3339Nano timestamp")
		}
		f.To, err = time.Parse(time.RFC3339Nano, values.Get("to"))
		if err != nil {
			return f, errors.New("to must be an RFC3339Nano timestamp")
		}
		f.From = f.From.UTC()
		f.To = f.To.UTC()
	}
	f.Service = values.Get("service")
	f.Search = values.Get("search")
	if values.Has("errorsOnly") {
		// Keep an unambiguous URL boolean representation for this new endpoint.
		switch values.Get("errorsOnly") {
		case "true":
			f.ErrorsOnly = true
		case "false":
		default:
			return f, errors.New("errorsOnly must be true or false")
		}
	}
	if values.Has("minSeverity") {
		f.MinSeverity, err = strconv.Atoi(values.Get("minSeverity"))
		if err != nil {
			return f, errors.New("minSeverity must be between 0 and 24")
		}
	}
	return f, f.Validate()
}

var liveTimestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$`)

// Admission is shared by all handlers in this API process.
var liveSlots = make(chan struct{}, 2)

type liveHandler struct {
	reader telemetry.LiveReader
}

func newLiveHandler(reader telemetry.Reader) http.Handler {
	liveReader, _ := reader.(telemetry.LiveReader)
	return &liveHandler{reader: liveReader}
}

func (h *liveHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		methodNotAllowed(w, "GET")
		return
	}
	f, err := parseLiveFilter(r.URL.RawQuery, time.Now().UTC())
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid_query", err.Error())
		return
	}
	if h.reader == nil {
		writeUnavailable(w)
		return
	}
	select {
	case liveSlots <- struct{}{}:
		defer func() { <-liveSlots }()
	default:
		w.Header().Set("Retry-After", "2")
		writeError(w, http.StatusTooManyRequests, "overloaded", "too many live requests")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	result, err := h.reader.Live(ctx, f)
	if r.Context().Err() != nil {
		return
	}
	if err != nil || ctx.Err() != nil {
		writeUnavailable(w)
		return
	}
	// Check encoded size before json.Encoder can allocate its full encoding.
	// The counter includes HTML escaping and the newline without copying large
	// strings. Never clip stored content or send a partial success body.
	_, err = liveEncodedSize(ctx, result)
	if r.Context().Err() != nil {
		return
	}
	if ctx.Err() != nil {
		writeUnavailable(w)
		return
	}
	if errors.Is(err, errLiveResponseTooLarge) {
		writeError(w, http.StatusUnprocessableEntity, "response_too_large", "live response exceeds 4 MiB")
		return
	}
	if err != nil {
		writeUnavailable(w)
		return
	}
	buffer := &liveBuffer{}
	err = json.NewEncoder(buffer).Encode(result)
	if errors.Is(err, errLiveResponseTooLarge) {
		writeError(w, http.StatusUnprocessableEntity, "response_too_large", "live response exceeds 4 MiB")
		return
	}
	if err != nil {
		writeUnavailable(w)
		return
	}
	if r.Context().Err() != nil {
		return
	}
	if ctx.Err() != nil {
		writeUnavailable(w)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(buffer.Bytes())
}

var errLiveResponseTooLarge = errors.New("live response exceeds limit")

type liveBuffer struct{ bytes.Buffer }

func (b *liveBuffer) Write(p []byte) (int, error) {
	if len(p) > liveResponseLimit-b.Len() {
		return 0, errLiveResponseTooLarge
	}
	return b.Buffer.Write(p)
}

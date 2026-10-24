package telemetry

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

const (
	LiveSpanLimit       = 500
	LiveLogLimit        = 500
	LiveContextLimit    = 500
	LiveTraceGroupLimit = 100
	LiveBucketCount     = 60
)

// LiveReader reads a bounded full-window result. Reads are not transactional.
type LiveReader interface {
	Live(context.Context, LiveFilter) (LiveSnapshot, error)
}

type LiveFilter struct {
	project     string
	From, To    time.Time
	Service     string
	Search      string
	ErrorsOnly  bool
	MinSeverity int
}

func (f LiveFilter) Validate() error {
	if err := (Filter{From: f.From, To: f.To, Service: f.Service, Search: f.Search, MinSeverity: f.MinSeverity}).Validate(); err != nil {
		return err
	}
	if d := f.To.Sub(f.From); d < time.Second || d > 15*time.Minute {
		return errors.New("time range must be between one second and fifteen minutes")
	}
	return nil
}

type LiveWindow struct {
	From time.Time `json:"from"`
	To   time.Time `json:"to"`
}
type LiveFilters struct {
	Service     string `json:"service"`
	Search      string `json:"search"`
	ErrorsOnly  bool   `json:"errorsOnly"`
	MinSeverity int    `json:"minSeverity"`
}
type LiveLimits struct {
	Spans       int `json:"spans"`
	Logs        int `json:"logs"`
	Context     int `json:"context"`
	TraceGroups int `json:"traceGroups"`
}
type LiveSnapshot struct {
	Window               LiveWindow   `json:"window"`
	QueriedAt            time.Time    `json:"queriedAt"`
	Filters              LiveFilters  `json:"filters"`
	Spans                []LiveRecord `json:"spans"`
	Logs                 []LiveRecord `json:"logs"`
	Context              []LiveRecord `json:"context"`
	Histogram            []LiveBucket `json:"histogram"`
	SpansTruncated       bool         `json:"spansTruncated"`
	LogsTruncated        bool         `json:"logsTruncated"`
	ContextTruncated     bool         `json:"contextTruncated"`
	TraceGroupsTruncated bool         `json:"traceGroupsTruncated"`
	Limits               LiveLimits   `json:"limits"`
	Completeness         string       `json:"completeness"`
}

type LiveRecord struct {
	latestMatchingNs   int64
	ID                 string            `json:"id"`
	Kind               string            `json:"kind"`
	TraceID            string            `json:"traceId"`
	SpanID             string            `json:"spanId"`
	ParentSpanID       string            `json:"parentSpanId"`
	Name               string            `json:"name"`
	ServiceName        string            `json:"serviceName"`
	StartTime          time.Time         `json:"startTime"`
	DurationNs         string            `json:"durationNs"`
	StatusCode         string            `json:"statusCode"`
	StatusMessage      string            `json:"statusMessage"`
	SeverityText       string            `json:"severityText"`
	SeverityNumber     int               `json:"severityNumber"`
	Body               string            `json:"body"`
	ResourceAttributes map[string]string `json:"resourceAttributes"`
	Attributes         map[string]string `json:"attributes"`
	ScopeName          string            `json:"scopeName"`
	ScopeVersion       string            `json:"scopeVersion"`
	ScopeAttributes    map[string]string `json:"scopeAttributes"`
	ResourceSchemaURL  string            `json:"resourceSchemaUrl"`
	ScopeSchemaURL     string            `json:"scopeSchemaUrl"`
	TraceFlags         uint32            `json:"traceFlags"`
	Occurrences        string            `json:"occurrences"`
	Conflict           bool              `json:"conflict"`
	ParentConflict     bool              `json:"parentConflict"`
	ContextOnly        bool              `json:"contextOnly"`
	// Stored retains all stored fields, including duplicate map entries and nested
	// span events/links. It is not the original OTLP encoding.
	Stored map[string]json.RawMessage `json:"stored"`
}

type LiveBucket struct {
	From       time.Time `json:"from"`
	To         time.Time `json:"to"`
	Spans      string    `json:"spans"`
	Logs       string    `json:"logs"`
	ErrorSpans string    `json:"errorSpans"`
	ErrorLogs  string    `json:"errorLogs"`
}

// NewLiveSnapshot initializes all arrays, count strings, and exact boundaries.
func NewLiveSnapshot(f LiveFilter, now time.Time) LiveSnapshot {
	r := LiveSnapshot{Window: LiveWindow{f.From.UTC(), f.To.UTC()}, QueriedAt: now.UTC(), Filters: LiveFilters{f.Service, f.Search, f.ErrorsOnly, f.MinSeverity}, Spans: []LiveRecord{}, Logs: []LiveRecord{}, Context: []LiveRecord{}, Histogram: make([]LiveBucket, LiveBucketCount), Limits: LiveLimits{LiveSpanLimit, LiveLogLimit, LiveContextLimit, LiveTraceGroupLimit}, Completeness: "unknown"}
	// The maximum interval is 900s; multiplication by 60 cannot overflow.
	width := f.To.Sub(f.From).Nanoseconds()
	for i := range r.Histogram {
		r.Histogram[i] = LiveBucket{From: f.From.Add(time.Duration(int64(i) * width / 60)).UTC(), To: f.From.Add(time.Duration(int64(i+1) * width / 60)).UTC(), Spans: "0", Logs: "0", ErrorSpans: "0", ErrorLogs: "0"}
	}
	return r
}

func liveValidID(id string, length int) bool {
	if len(id) != length || id == strings.Repeat("0", length) {
		return false
	}
	_, err := hex.DecodeString(id)
	return err == nil
}

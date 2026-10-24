// Package telemetry reads exported telemetry within an authorized project.
package telemetry

import (
	"context"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

var ErrNotFound = errors.New("trace not found")

// Reader reads telemetry within a bounded time range.
type Reader interface {
	Traces(context.Context, Filter) (TraceList, error)
	Logs(context.Context, Filter) (LogList, error)
	Trace(context.Context, string, Filter) (TraceDetail, error)
}

type Filter struct {
	project     string
	From, To    time.Time
	Service     string
	Search      string
	ErrorsOnly  bool
	MinSeverity int
	TraceID     string
	Limit       int
}

// Validate checks bounds before timestamps are converted to nanoseconds.
// A zero limit selects the default limit of 50.
func (f Filter) Validate() error {
	if f.From.IsZero() || f.To.IsZero() || !f.From.Before(f.To) {
		return errors.New("from must be before to")
	}
	if f.To.Sub(f.From) > 24*time.Hour {
		return errors.New("time range must not exceed 24 hours")
	}
	for _, timestamp := range []time.Time{f.From, f.To} {
		if !timestamp.Equal(time.Unix(0, timestamp.UnixNano())) {
			return errors.New("timestamp is outside the supported nanosecond range")
		}
	}
	if len(f.Service) > 200 || len(f.Search) > 200 {
		return errors.New("service and search must not exceed 200 bytes")
	}
	if f.Limit < 0 || f.Limit > 100 {
		return errors.New("limit must be between 1 and 100")
	}
	if f.MinSeverity < 0 || f.MinSeverity > 24 {
		return errors.New("minSeverity must be between 0 and 24")
	}
	if f.TraceID != "" {
		if len(f.TraceID) != 32 || f.TraceID == strings.Repeat("0", 32) {
			return errors.New("trace ID must be 32 hexadecimal characters and nonzero")
		}
		if _, err := hex.DecodeString(f.TraceID); err != nil {
			return errors.New("trace ID must be 32 hexadecimal characters and nonzero")
		}
	}
	return nil
}

type TraceSummary struct {
	TraceID     string    `json:"traceId"`
	Name        string    `json:"name"`
	ServiceName string    `json:"serviceName"`
	StartTime   time.Time `json:"startTime"`
	EndTime     time.Time `json:"endTime"`
	DurationNs  string    `json:"durationNs"`
	SpanCount   uint64    `json:"spanCount"`
	ErrorCount  uint64    `json:"errorCount"`
}

type Span struct {
	TraceID            string            `json:"traceId"`
	SpanID             string            `json:"spanId"`
	ParentSpanID       string            `json:"parentSpanId"`
	Name               string            `json:"name"`
	ServiceName        string            `json:"serviceName"`
	StartTime          time.Time         `json:"startTime"`
	DurationNs         string            `json:"durationNs"`
	StatusCode         string            `json:"statusCode"`
	StatusMessage      string            `json:"statusMessage"`
	ResourceAttributes map[string]string `json:"resourceAttributes"`
	Attributes         map[string]string `json:"attributes"`
}

type Log struct {
	Timestamp          time.Time         `json:"timestamp"`
	TraceID            string            `json:"traceId"`
	SpanID             string            `json:"spanId"`
	ServiceName        string            `json:"serviceName"`
	SeverityText       string            `json:"severityText"`
	SeverityNumber     int               `json:"severityNumber"`
	Body               string            `json:"body"`
	ResourceAttributes map[string]string `json:"resourceAttributes"`
	Attributes         map[string]string `json:"attributes"`
}

type TraceList struct {
	Items   []TraceSummary `json:"items"`
	HasMore bool           `json:"hasMore"`
}

type LogList struct {
	Items   []Log `json:"items"`
	HasMore bool  `json:"hasMore"`
}

type TraceDetail struct {
	TraceID        string `json:"traceId"`
	Spans          []Span `json:"spans"`
	Logs           []Log  `json:"logs"`
	SpansTruncated bool   `json:"spansTruncated"`
	LogsTruncated  bool   `json:"logsTruncated"`
}

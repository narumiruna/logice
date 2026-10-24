package telemetry

import "strings"

// Project scope is supplied only by the authorized server context.
const scope = `ResourceAttributes['logice.project.id'] = ?
AND toUnixTimestamp64Nano(Timestamp) >= ? AND toUnixTimestamp64Nano(Timestamp) < ?`

func where(f Filter, logs bool) (string, []any) {
	clauses := []string{scope}
	args := []any{f.project, f.From.UnixNano(), f.To.UnixNano()}
	if f.Service != "" {
		clauses = append(clauses, "ServiceName = ?")
		args = append(args, f.Service)
	}
	if f.Search != "" {
		if logs {
			clauses = append(clauses, "position(Body, ?) > 0")
			args = append(args, f.Search)
		} else {
			clauses = append(clauses, "(position(SpanName, ?) > 0 OR position(TraceId, ?) > 0)")
			args = append(args, f.Search, f.Search)
		}
	}
	if logs {
		clauses = append(clauses, "SeverityNumber >= ?")
		args = append(args, f.MinSeverity)
	}
	if f.TraceID != "" {
		clauses = append(clauses, "TraceId = ?")
		args = append(args, strings.ToLower(f.TraceID))
	}
	return strings.Join(clauses, " AND "), args
}

// Int128 arithmetic prevents a UInt64 span duration from wrapping the span end
// or the summary duration. Summary names prefer a matching root span. Service,
// search, and time filters apply before grouping, so summaries can be partial.
func tracesQuery(f Filter) (string, []any) {
	predicate, args := where(f, false)
	having := ""
	if f.ErrorsOnly {
		// The exporter writes ptrace status names, not numeric codes. Keep the
		// healthy spans in each trace that has at least one matching error.
		having = " HAVING countIf(StatusCode = ?) > 0"
		args = append(args, "Error")
	}
	query := `SELECT TraceId,
argMin(SpanName, tuple(ParentSpanId != '', Timestamp, SpanId)), argMin(ServiceName, tuple(ParentSpanId != '', Timestamp, SpanId)),
min(Timestamp),
toString(max(toInt128(toUnixTimestamp64Nano(Timestamp)) + toInt128(Duration))),
toString(max(toInt128(toUnixTimestamp64Nano(Timestamp)) + toInt128(Duration)) - min(toInt128(toUnixTimestamp64Nano(Timestamp)))),
count(), countIf(StatusCode = 'Error')
FROM logice.otel_traces WHERE ` + predicate + `
GROUP BY TraceId` + having + ` ORDER BY min(Timestamp) DESC, TraceId ASC LIMIT ?`
	return query, append(args, listLimit(f)+1)
}

func logsQuery(f Filter, limit int) (string, []any) {
	predicate, args := where(f, true)
	query := `SELECT Timestamp, TraceId, SpanId, ServiceName, SeverityText, SeverityNumber, Body, ResourceAttributes, LogAttributes
FROM logice.otel_logs WHERE ` + predicate + `
ORDER BY Timestamp DESC, TraceId ASC, SpanId ASC, Body ASC LIMIT ?`
	return query, append(args, limit+1)
}

func spansQuery(f Filter) (string, []any) {
	predicate, args := where(f, false)
	query := `SELECT TraceId, SpanId, ParentSpanId, SpanName, ServiceName, Timestamp, Duration, StatusCode, StatusMessage, ResourceAttributes, SpanAttributes
FROM logice.otel_traces WHERE ` + predicate + `
ORDER BY Timestamp ASC, SpanId ASC LIMIT ?`
	return query, append(args, 501)
}

func listLimit(f Filter) int {
	if f.Limit == 0 {
		return 50
	}
	return f.Limit
}

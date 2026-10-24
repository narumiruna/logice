package telemetry

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"
	"time"
)

var _ LiveReader = (*Store)(nil)

// clickhouse-go replaces max_execution_time with deadline+5 seconds when a
// context advertises a deadline. Hide only that advertisement from the driver;
// Done, Err, and Value still belong to the same five-second request context.
// This preserves both server max_execution_time=5 and shared I/O cancellation.
// readonly=1 also prohibits correcting the setting with a SQL SETTINGS clause.
// Keep the ordinary deadline-bearing context for store work and HTTP checks.
type liveDriverContext struct{ context.Context }

func (liveDriverContext) Deadline() (time.Time, bool) { return time.Time{}, false }

func (s *Store) Live(ctx context.Context, f LiveFilter) (LiveSnapshot, error) {
	f.project = projectFrom(ctx)
	if f.project == "" {
		return LiveSnapshot{}, ErrScope
	}
	if err := f.Validate(); err != nil {
		return LiveSnapshot{}, err
	}
	result := NewLiveSnapshot(f, time.Now())
	// Every sequential component receives this same deadline and read limits.
	ctx, cancel := queryContext(ctx)
	defer cancel()
	var err error
	q, args := liveMatchingQuery(f, false)
	result.Spans, err = s.liveRecords(ctx, q, args, false, false)
	if err != nil {
		return LiveSnapshot{}, err
	}
	q, args = liveMatchingQuery(f, true)
	result.Logs, err = s.liveRecords(ctx, q, args, true, false)
	if err != nil {
		return LiveSnapshot{}, err
	}
	if len(result.Spans) > LiveSpanLimit {
		result.SpansTruncated = true
		result.Spans = result.Spans[:LiveSpanLimit]
	}
	if len(result.Logs) > LiveLogLimit {
		result.LogsTruncated = true
		result.Logs = result.Logs[:LiveLogLimit]
	}
	traces := liveRetainTraces(&result)
	if len(traces) > 0 {
		matching := append(append([]LiveRecord{}, result.Spans...), result.Logs...)
		q, args = liveContextQuery(f, traces, matching)
		result.Context, err = s.liveRecords(ctx, q, args, false, true)
		if err != nil {
			return LiveSnapshot{}, err
		}
		if len(result.Context) > LiveContextLimit {
			result.ContextTruncated = true
			result.Context = result.Context[:LiveContextLimit]
		}
		result.Context = liveAncestors(result.Context, matching)
	}
	for _, logs := range []bool{false, true} {
		q, args = liveHistogramQuery(f, logs)
		if err = s.liveHistogram(ctx, q, args, logs, &result); err != nil {
			return LiveSnapshot{}, err
		}
	}
	if err = ctx.Err(); err != nil {
		return LiveSnapshot{}, err
	}
	return result, nil
}

func (s *Store) liveRecords(ctx context.Context, q string, args []any, logs, contextOnly bool) ([]LiveRecord, error) {
	result := []LiveRecord{}
	rows, err := s.db.QueryContext(liveDriverContext{ctx}, q, args...)
	if err != nil {
		return result, tableError(err)
	}
	defer rows.Close()
	seen := map[string]string{}
	for rows.Next() {
		var id, payload string
		var occurrences uint64
		var conflict, parentConflict bool
		var latest int64
		if err := rows.Scan(&id, &payload, &occurrences, &conflict, &parentConflict, &latest); err != nil {
			return nil, err
		}
		if previous, ok := seen[id]; ok && previous != payload {
			return nil, errors.New("live identity collision")
		}
		seen[id] = payload
		record, err := liveDecode(payload, logs)
		if err != nil {
			return nil, err
		}
		// Verify generated content identities before returning any result.
		expected := liveIdentity(record, payload)
		if id != expected {
			return nil, errors.New("invalid live identity")
		}
		record.latestMatchingNs = latest
		record.ID = id
		record.Occurrences = strconv.FormatUint(occurrences, 10)
		record.Conflict = conflict
		record.ParentConflict = parentConflict
		record.ContextOnly = contextOnly
		result = append(result, record)
	}
	if err := rows.Err(); err != nil {
		if tableError(err) == nil {
			return []LiveRecord{}, nil
		}
		return nil, err
	}
	return result, nil
}

func liveIdentity(r LiveRecord, payload string) string {
	if r.Kind == "span" && liveValidID(r.TraceID, 32) && liveValidID(r.SpanID, 16) {
		return "span:" + r.ResourceAttributes["logice.project.id"] + ":" + strings.ToLower(r.TraceID) + ":" + strings.ToLower(r.SpanID)
	}
	sum := sha256.Sum256([]byte(payload))
	prefix := "log:v1:"
	if r.Kind == "span" {
		prefix = "span-content:v1:"
	}
	return prefix + hex.EncodeToString(sum[:])
}

func liveDecode(payload string, logs bool) (LiveRecord, error) {
	columns := liveSpanColumns
	kind := "span"
	attributeColumn := "SpanAttributes"
	if logs {
		columns = liveLogColumns
		kind = "log"
		attributeColumn = "LogAttributes"
	}
	var fields []json.RawMessage
	if err := json.Unmarshal([]byte(payload), &fields); err != nil {
		return LiveRecord{}, err
	}
	if len(fields) != len(columns) {
		return LiveRecord{}, errors.New("unexpected stored live columns")
	}
	stored := make(map[string]json.RawMessage, len(columns))
	for i, c := range columns {
		stored[c] = fields[i]
	}
	get := func(key string) string { var value string; _ = json.Unmarshal(stored[key], &value); return value }
	timestamp, err := strconv.ParseInt(get("Timestamp"), 10, 64)
	if err != nil {
		return LiveRecord{}, err
	}
	r := LiveRecord{Kind: kind, TraceID: strings.ToLower(get("TraceId")), SpanID: strings.ToLower(get("SpanId")), ParentSpanID: strings.ToLower(get("ParentSpanId")), Name: get("SpanName"), ServiceName: get("ServiceName"), StartTime: time.Unix(0, timestamp).UTC(), DurationNs: "0", StatusCode: get("StatusCode"), StatusMessage: get("StatusMessage"), SeverityText: get("SeverityText"), Body: get("Body"), ScopeName: get("ScopeName"), ScopeVersion: get("ScopeVersion"), ResourceSchemaURL: get("ResourceSchemaUrl"), ScopeSchemaURL: get("ScopeSchemaUrl"), Stored: stored}
	r.ResourceAttributes, err = liveAttributes(stored["ResourceAttributes"])
	if err != nil {
		return LiveRecord{}, err
	}
	r.Attributes, err = liveAttributes(stored[attributeColumn])
	if err != nil {
		return LiveRecord{}, err
	}
	r.ScopeAttributes, err = liveAttributes(stored["ScopeAttributes"])
	if err != nil {
		return LiveRecord{}, err
	}
	if logs {
		if err = json.Unmarshal(stored["SeverityNumber"], &r.SeverityNumber); err != nil {
			return LiveRecord{}, err
		}
		if err = json.Unmarshal(stored["TraceFlags"], &r.TraceFlags); err != nil {
			return LiveRecord{}, err
		}
	} else {
		r.DurationNs = get("Duration")
		if _, err = strconv.ParseUint(r.DurationNs, 10, 64); err != nil {
			return LiveRecord{}, err
		}
	}
	return r, nil
}

func liveAttributes(raw json.RawMessage) (map[string]string, error) {
	result := map[string]string{}
	if raw == nil {
		return result, nil
	}
	var pairs [][]string
	if err := json.Unmarshal(raw, &pairs); err != nil {
		return nil, err
	}
	for _, pair := range pairs {
		if len(pair) != 2 {
			return nil, errors.New("invalid stored attributes")
		}
		result[pair[0]] = pair[1]
	}
	return result, nil
}

func liveRetainTraces(result *LiveSnapshot) []string {
	latest := map[string]time.Time{}
	for _, records := range [][]LiveRecord{result.Spans, result.Logs} {
		for _, r := range records {
			// Invalid identifiers are content records, not trace-linkable records.
			if !liveValidID(r.TraceID, 32) || (r.Kind == "span" && !liveValidID(r.SpanID, 16)) {
				continue
			}
			// SQL always supplies this value. Unix epoch zero is a valid latest
			// timestamp, not an absent-value sentinel.
			eventTime := time.Unix(0, r.latestMatchingNs)
			if t, ok := latest[r.TraceID]; !ok || eventTime.After(t) {
				latest[r.TraceID] = eventTime
			}
		}
	}
	traces := make([]string, 0, len(latest))
	for trace := range latest {
		traces = append(traces, trace)
	}
	sort.Slice(traces, func(i, j int) bool {
		a, b := latest[traces[i]], latest[traces[j]]
		if a.Equal(b) {
			return traces[i] < traces[j]
		}
		return a.After(b)
	})
	if len(traces) > LiveTraceGroupLimit {
		result.TraceGroupsTruncated = true
		traces = traces[:LiveTraceGroupLimit]
	}
	retained := map[string]bool{}
	for _, id := range traces {
		retained[id] = true
	}
	filter := func(records []LiveRecord) []LiveRecord {
		out := make([]LiveRecord, 0, len(records))
		for _, r := range records {
			if !liveValidID(r.TraceID, 32) || (r.Kind == "span" && !liveValidID(r.SpanID, 16)) || retained[r.TraceID] {
				out = append(out, r)
			}
		}
		return out
	}
	result.Spans = filter(result.Spans)
	result.Logs = filter(result.Logs)
	return traces
}

// Keep only the available ancestor paths of matching records. This is an
// in-memory bounded graph walk, never a recursive database request.
func liveAncestors(contextRecords, matching []LiveRecord) []LiveRecord {
	byPair := map[string]LiveRecord{}
	for _, records := range [][]LiveRecord{contextRecords, matching} {
		for _, r := range records {
			if r.Kind == "span" && liveValidID(r.TraceID, 32) && liveValidID(r.SpanID, 16) {
				byPair[r.TraceID+":"+r.SpanID] = r
			}
		}
	}
	keep := map[string]bool{}
	for _, r := range matching {
		if r.Kind == "span" && !liveValidID(r.SpanID, 16) {
			continue
		}
		parent := r.ParentSpanID
		if r.Kind == "log" {
			parent = r.SpanID
		}
		if r.ParentConflict || !liveValidID(r.TraceID, 32) {
			continue
		}
		visited := map[string]bool{}
		for liveValidID(parent, 16) {
			key := r.TraceID + ":" + parent
			if visited[key] {
				break
			}
			visited[key] = true
			ancestor, ok := byPair[key]
			if !ok {
				break
			}
			keep[ancestor.ID] = true
			if ancestor.ParentConflict {
				break
			}
			parent = ancestor.ParentSpanID
		}
	}
	result := []LiveRecord{}
	for _, r := range contextRecords {
		if keep[r.ID] {
			result = append(result, r)
		}
	}
	return result
}

func (s *Store) liveHistogram(ctx context.Context, q string, args []any, logs bool, result *LiveSnapshot) error {
	rows, err := s.db.QueryContext(liveDriverContext{ctx}, q, args...)
	if err != nil {
		return tableError(err)
	}
	defer rows.Close()
	type counts struct {
		bucket        uint8
		count, errors uint64
	}
	pending := []counts{}
	for rows.Next() {
		var bucket uint8
		var count, errorsCount uint64
		if err := rows.Scan(&bucket, &count, &errorsCount); err != nil {
			return err
		}
		if int(bucket) >= len(result.Histogram) {
			return errors.New("invalid live histogram bucket")
		}
		pending = append(pending, counts{bucket, count, errorsCount})
	}
	if err := rows.Err(); err != nil {
		return tableError(err)
	}
	for _, c := range pending {
		b := &result.Histogram[c.bucket]
		if logs {
			b.Logs = strconv.FormatUint(c.count, 10)
			b.ErrorLogs = strconv.FormatUint(c.errors, 10)
		} else {
			b.Spans = strconv.FormatUint(c.count, 10)
			b.ErrorSpans = strconv.FormatUint(c.errors, 10)
		}
	}
	return nil
}

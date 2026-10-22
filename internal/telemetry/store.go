package telemetry

import (
	"context"
	"database/sql"
	"errors"
	"math/big"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

const queryTimeout = 5 * time.Second

type Store struct {
	db *sql.DB
}

var _ Reader = (*Store)(nil)

// Open configures the native ClickHouse connection without connecting or
// checking readiness. A storage outage must not prevent API liveness.
func Open(address, password string) (*Store, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || host == "" {
		return nil, errors.New("invalid ClickHouse address: expected host:port")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return nil, errors.New("invalid ClickHouse port")
	}
	db := clickhouse.OpenDB(&clickhouse.Options{
		Addr:        []string{address},
		Auth:        clickhouse.Auth{Database: "logice", Username: "logice", Password: password},
		DialTimeout: queryTimeout,
		ReadTimeout: queryTimeout,
	})
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(5 * time.Minute)
	return NewStore(db), nil
}

func NewStore(db *sql.DB) *Store { return &Store{db: db} }

func (s *Store) Close() error { return s.db.Close() }

// queryContext also applies settings to databases supplied through NewStore.
func queryContext(ctx context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(ctx, queryTimeout)
	return clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"readonly":              1,
		"max_execution_time":    5,
		"max_memory_usage":      128 << 20,
		"max_result_bytes":      8 << 20,
		"result_overflow_mode":  "throw",
		"timeout_overflow_mode": "throw",
	})), cancel
}

func (s *Store) Traces(ctx context.Context, f Filter) (TraceList, error) {
	result := TraceList{Items: []TraceSummary{}}
	if err := f.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := queryContext(ctx)
	defer cancel()
	query, args := tracesQuery(f)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return result, tableError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item TraceSummary
		var end string
		if err := rows.Scan(&item.TraceID, &item.Name, &item.ServiceName, &item.StartTime,
			&end, &item.DurationNs, &item.SpanCount, &item.ErrorCount); err != nil {
			return TraceList{Items: []TraceSummary{}}, err
		}
		item.StartTime = item.StartTime.UTC()
		item.EndTime, err = nanoTime(end)
		if err != nil {
			return TraceList{Items: []TraceSummary{}}, err
		}
		result.Items = append(result.Items, item)
	}
	if err := rows.Err(); err != nil {
		return TraceList{Items: []TraceSummary{}}, tableError(err)
	}
	if len(result.Items) > listLimit(f) {
		result.HasMore = true
		result.Items = result.Items[:listLimit(f)]
	}
	return result, nil
}

func (s *Store) Logs(ctx context.Context, f Filter) (LogList, error) {
	result := LogList{Items: []Log{}}
	if err := f.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := queryContext(ctx)
	defer cancel()
	items, err := s.logs(ctx, f, listLimit(f))
	if err != nil {
		return result, err
	}
	result.Items = items
	if len(items) > listLimit(f) {
		result.HasMore = true
		result.Items = items[:listLimit(f)]
	}
	return result, nil
}

func (s *Store) Trace(ctx context.Context, traceID string, f Filter) (TraceDetail, error) {
	// Detail reads accept only the time range and the path's trace identity.
	f = Filter{From: f.From, To: f.To, TraceID: traceID}
	result := TraceDetail{TraceID: strings.ToLower(traceID), Spans: []Span{}, Logs: []Log{}}
	if traceID == "" {
		return result, errors.New("trace ID is required")
	}
	if err := f.Validate(); err != nil {
		return result, err
	}
	ctx, cancel := queryContext(ctx)
	defer cancel()
	spans, err := s.spans(ctx, f)
	if err != nil {
		return result, err
	}
	logs, err := s.logs(ctx, f, 200)
	if err != nil {
		return result, err
	}
	result.Spans, result.Logs = spans, logs
	if len(spans) > 500 {
		result.Spans, result.SpansTruncated = spans[:500], true
	}
	if len(logs) > 200 {
		result.Logs, result.LogsTruncated = logs[:200], true
	}
	if len(spans) == 0 && len(logs) == 0 {
		return result, ErrNotFound
	}
	return result, nil
}

func (s *Store) spans(ctx context.Context, f Filter) ([]Span, error) {
	items := []Span{}
	query, args := spansQuery(f)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return items, tableError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item Span
		var duration uint64
		if err := rows.Scan(&item.TraceID, &item.SpanID, &item.ParentSpanID, &item.Name,
			&item.ServiceName, &item.StartTime, &duration, &item.StatusCode, &item.StatusMessage,
			&item.ResourceAttributes, &item.Attributes); err != nil {
			return []Span{}, err
		}
		item.StartTime = item.StartTime.UTC()
		item.DurationNs = strconv.FormatUint(duration, 10)
		item.ResourceAttributes = nonNilMap(item.ResourceAttributes)
		item.Attributes = nonNilMap(item.Attributes)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return []Span{}, tableError(err)
	}
	return items, nil
}

func (s *Store) logs(ctx context.Context, f Filter, limit int) ([]Log, error) {
	items := []Log{}
	query, args := logsQuery(f, limit)
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return items, tableError(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item Log
		if err := rows.Scan(&item.Timestamp, &item.TraceID, &item.SpanID, &item.ServiceName,
			&item.SeverityText, &item.SeverityNumber, &item.Body, &item.ResourceAttributes, &item.Attributes); err != nil {
			return []Log{}, err
		}
		item.Timestamp = item.Timestamp.UTC()
		item.ResourceAttributes = nonNilMap(item.ResourceAttributes)
		item.Attributes = nonNilMap(item.Attributes)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return []Log{}, tableError(err)
	}
	return items, nil
}

// Only ClickHouse UNKNOWN_TABLE (60) is an empty pre-ingestion result. Do not
// classify outages, authentication errors, or unstructured error text as empty.
func tableError(err error) error {
	var exception *clickhouse.Exception
	if errors.As(err, &exception) && exception.Code == 60 {
		return nil
	}
	return err
}

func nonNilMap(value map[string]string) map[string]string {
	if value == nil {
		return map[string]string{}
	}
	return value
}

// A span's end can exceed int64 nanoseconds even when its start does not.
func nanoTime(value string) (time.Time, error) {
	nanoseconds, ok := new(big.Int).SetString(value, 10)
	if !ok {
		return time.Time{}, errors.New("invalid span end timestamp")
	}
	seconds, remainder := new(big.Int), new(big.Int)
	seconds.QuoRem(nanoseconds, big.NewInt(1_000_000_000), remainder)
	if !seconds.IsInt64() {
		return time.Time{}, errors.New("span end timestamp is out of range")
	}
	result := time.Unix(seconds.Int64(), remainder.Int64()).UTC()
	if result.Year() < 0 || result.Year() > 9999 {
		return time.Time{}, errors.New("span end timestamp is out of range")
	}
	return result, nil
}

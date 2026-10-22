package telemetry

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
)

// This driver tests database/sql scanning and cancellation without a server.
type queryFunc func(context.Context, string, []driver.NamedValue) (driver.Rows, error)

type testConnector struct{ query queryFunc }

type testDriver struct{}

func (testDriver) Open(string) (driver.Conn, error) { return nil, errors.New("use connector") }
func (c testConnector) Connect(context.Context) (driver.Conn, error) {
	return testConn{query: c.query}, nil
}
func (testConnector) Driver() driver.Driver { return testDriver{} }

type testConn struct{ query queryFunc }

func (testConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unexpected prepare") }
func (testConn) Close() error                        { return nil }
func (testConn) Begin() (driver.Tx, error)           { return nil, errors.New("unexpected transaction") }
func (c testConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	return c.query(ctx, query, args)
}

type testRows struct {
	data        [][]driver.Value
	columnCount int
	terminalErr error
}

func (r *testRows) Columns() []string {
	columns := make([]string, r.columnCount)
	for i := range columns {
		columns[i] = fmt.Sprint(i)
	}
	return columns
}
func (*testRows) Close() error { return nil }
func (r *testRows) Next(dest []driver.Value) error {
	if len(r.data) == 0 {
		if r.terminalErr != nil {
			return r.terminalErr
		}
		return io.EOF
	}
	copy(dest, r.data[0])
	r.data = r.data[1:]
	return nil
}

func rows(data ...[]driver.Value) driver.Rows {
	count := 0
	if len(data) > 0 {
		count = len(data[0])
	}
	return &testRows{data: data, columnCount: count}
}

func testStore(t *testing.T, query queryFunc) *Store {
	t.Helper()
	store := NewStore(sql.OpenDB(testConnector{query: query}))
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func summaryRow() []driver.Value {
	return []driver.Value{traceID, "root", "api", testFilter().From, "1767225601123456789", "1000000000", int64(2), int64(1)}
}

func spanRow() []driver.Value {
	return []driver.Value{traceID, "0123456789abcdef", "", "root", "api", testFilter().From, uint64(18446744073709551615), "Error", "failed", map[string]string{"logice.project.id": "validation"}, map[string]string{"key": "value"}}
}

func logRow() []driver.Value {
	return []driver.Value{testFilter().From, traceID, "0123456789abcdef", "api", "ERROR", int64(17), "full record", map[string]string{"logice.project.id": "validation"}, map[string]string{"key": "value"}}
}

func TestOpenDoesNotConnect(t *testing.T) {
	store, err := Open("127.0.0.1:1", "test-password")
	if err != nil {
		t.Fatalf("Open must not ping: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	for _, address := range []string{"", "host", ":9000", "host:bad", "host:0", "host:65536"} {
		if _, err := Open(address, "password"); err == nil {
			t.Errorf("invalid address %q accepted", address)
		}
	}
}

func TestStoreEmptyAndMissingTables(t *testing.T) {
	for name, query := range map[string]queryFunc{
		"empty": func(context.Context, string, []driver.NamedValue) (driver.Rows, error) { return rows(), nil },
		"missing table": func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
			return nil, fmt.Errorf("wrapped: %w", &clickhouse.Exception{Code: 60, Message: "unknown table"})
		},
		"late missing table": func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
			return &testRows{terminalErr: &clickhouse.Exception{Code: 60}}, nil
		},
	} {
		t.Run(name, func(t *testing.T) {
			store := testStore(t, query)
			traces, err := store.Traces(context.Background(), testFilter())
			if err != nil || traces.Items == nil || len(traces.Items) != 0 || traces.HasMore {
				t.Fatalf("traces = %+v, %v", traces, err)
			}
			logs, err := store.Logs(context.Background(), testFilter())
			if err != nil || logs.Items == nil || len(logs.Items) != 0 || logs.HasMore {
				t.Fatalf("logs = %+v, %v", logs, err)
			}
			detail, err := store.Trace(context.Background(), traceID, testFilter())
			if !errors.Is(err, ErrNotFound) || detail.Spans == nil || detail.Logs == nil {
				t.Fatalf("detail = %+v, %v", detail, err)
			}
		})
	}
}

func TestStoreFailuresAreNotEmptyResults(t *testing.T) {
	for _, failure := range []error{errors.New("network unavailable"), errors.New("Code: 60 textual only"), &clickhouse.Exception{Code: 516, Message: "bad password"}} {
		store := testStore(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) { return nil, failure })
		if _, err := store.Traces(context.Background(), testFilter()); !errors.Is(err, failure) {
			t.Fatalf("trace list error = %v, want %v", err, failure)
		}
		if _, err := store.Logs(context.Background(), testFilter()); !errors.Is(err, failure) {
			t.Fatalf("log list error = %v, want %v", err, failure)
		}
		if _, err := store.Trace(context.Background(), traceID, testFilter()); !errors.Is(err, failure) {
			t.Fatalf("trace detail error = %v, want %v", err, failure)
		}
	}
}

func TestStoreScansAndTrimsLists(t *testing.T) {
	f := testFilter()
	f.Limit = 1
	store := testStore(t, func(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
		if args[len(args)-1].Value != int64(2) {
			t.Fatalf("list query must fetch limit+1: %#v", args)
		}
		if strings.Contains(query, "FROM logice.otel_traces") {
			return rows(summaryRow(), summaryRow()), nil
		}
		return rows(logRow(), logRow()), nil
	})
	traces, err := store.Traces(context.Background(), f)
	if err != nil || !traces.HasMore || len(traces.Items) != 1 {
		t.Fatalf("trace result = %+v, %v", traces, err)
	}
	trace := traces.Items[0]
	if trace.TraceID != traceID || trace.Name != "root" || trace.ServiceName != "api" || !trace.StartTime.Equal(f.From) || !trace.EndTime.Equal(f.From.Add(time.Second)) || trace.DurationNs != "1000000000" || trace.SpanCount != 2 || trace.ErrorCount != 1 {
		t.Fatalf("summary data = %+v", trace)
	}
	logs, err := store.Logs(context.Background(), f)
	if err != nil || !logs.HasMore || len(logs.Items) != 1 {
		t.Fatalf("log result = %+v, %v", logs, err)
	}
	log := logs.Items[0]
	if !log.Timestamp.Equal(f.From) || log.Body != "full record" || log.SeverityNumber != 17 || log.ResourceAttributes["logice.project.id"] != "validation" || log.Attributes["key"] != "value" {
		t.Fatalf("log data = %+v", log)
	}
}

func TestStoreTraceCapsAndData(t *testing.T) {
	store := testStore(t, func(_ context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
		count, row := 201, logRow()
		if strings.Contains(query, "FROM logice.otel_traces") {
			count, row = 501, spanRow()
		}
		if args[len(args)-1].Value != int64(count) {
			t.Fatalf("incorrect detail query cap: %#v", args)
		}
		data := make([][]driver.Value, count)
		for i := range data {
			data[i] = row
		}
		return rows(data...), nil
	})
	detail, err := store.Trace(context.Background(), strings.ToUpper(traceID), testFilter())
	if err != nil || detail.TraceID != traceID || len(detail.Spans) != 500 || len(detail.Logs) != 200 || !detail.SpansTruncated || !detail.LogsTruncated {
		t.Fatalf("detail counts = %d, %d; truncated = %v, %v; err = %v", len(detail.Spans), len(detail.Logs), detail.SpansTruncated, detail.LogsTruncated, err)
	}
	span := detail.Spans[0]
	if span.DurationNs != "18446744073709551615" || span.StatusCode != "Error" || span.StatusMessage != "failed" || span.ParentSpanID != "" || span.Attributes["key"] != "value" || !span.StartTime.Equal(testFilter().From) {
		t.Fatalf("span data = %+v", span)
	}
}

func TestStoreTraceWithOnlyOneTable(t *testing.T) {
	for _, missing := range []string{"otel_traces", "otel_logs"} {
		t.Run(missing, func(t *testing.T) {
			store := testStore(t, func(_ context.Context, query string, _ []driver.NamedValue) (driver.Rows, error) {
				if strings.Contains(query, "FROM logice."+missing) {
					return nil, &clickhouse.Exception{Code: 60}
				}
				if strings.Contains(query, "FROM logice.otel_traces") {
					row := spanRow()
					row[9], row[10] = map[string]string(nil), map[string]string(nil)
					return rows(row), nil
				}
				row := logRow()
				row[7], row[8] = map[string]string(nil), map[string]string(nil)
				return rows(row), nil
			})
			detail, err := store.Trace(context.Background(), traceID, testFilter())
			if err != nil || len(detail.Spans)+len(detail.Logs) != 1 || detail.Spans == nil || detail.Logs == nil || detail.SpansTruncated || detail.LogsTruncated {
				t.Fatalf("single-table detail = %+v, %v", detail, err)
			}
			if len(detail.Spans) > 0 && (detail.Spans[0].Attributes == nil || detail.Spans[0].ResourceAttributes == nil) {
				t.Fatal("nil span maps")
			}
			if len(detail.Logs) > 0 && (detail.Logs[0].Attributes == nil || detail.Logs[0].ResourceAttributes == nil) {
				t.Fatal("nil log maps")
			}
		})
	}
}

func TestStoreCancellationAndValidation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	called := false
	store := testStore(t, func(queryCtx context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
		called = true
		deadline, ok := queryCtx.Deadline()
		if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > queryTimeout {
			t.Fatalf("unbounded query context: %v, %v", deadline, ok)
		}
		cancel()
		<-queryCtx.Done()
		return nil, queryCtx.Err()
	})
	if _, err := store.Traces(ctx, testFilter()); !errors.Is(err, context.Canceled) || !called {
		t.Fatalf("cancellation error = %v, called = %v", err, called)
	}
	called = false
	if _, err := store.Logs(context.Background(), Filter{}); err == nil || called {
		t.Fatalf("invalid filter reached DB: %v, called = %v", err, called)
	}
	if _, err := store.Trace(context.Background(), "", testFilter()); err == nil || called {
		t.Fatalf("invalid trace ID reached DB: %v, called = %v", err, called)
	}
	parent, parentCancel := context.WithTimeout(context.Background(), time.Second)
	defer parentCancel()
	queryCtx, queryCancel := queryContext(parent)
	defer queryCancel()
	parentDeadline, _ := parent.Deadline()
	queryDeadline, _ := queryCtx.Deadline()
	if !queryDeadline.Equal(parentDeadline) {
		t.Fatal("query extended parent deadline")
	}
}

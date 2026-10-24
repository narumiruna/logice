package telemetry

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"strings"
	"testing"
	"time"
)

type liveTestConnector struct{ testConnector }

func (c liveTestConnector) Connect(context.Context) (driver.Conn, error) {
	return liveTestConn{testConn{query: c.query}}, nil
}

type liveTestConn struct{ testConn }

func (liveTestConn) CheckNamedValue(*driver.NamedValue) error { return nil }

func TestLiveDriverBudget(t *testing.T) {
	parent, cancel := context.WithTimeout(WithProject(context.Background(), "validation"), 20*time.Millisecond)
	defer cancel()
	ctx, stop := queryContext(parent)
	defer stop()
	driverCtx := liveDriverContext{ctx}
	if _, ok := driverCtx.Deadline(); ok {
		t.Fatal("driver can override max_execution_time")
	}
	if driverCtx.Done() != ctx.Done() {
		t.Fatal("driver lost shared budget")
	}
	select {
	case <-driverCtx.Done():
	case <-time.After(time.Second):
		t.Fatal("driver ignored shared deadline")
	}
	if driverCtx.Err() != context.DeadlineExceeded {
		t.Fatal("driver lost cancellation reason")
	}
	type key struct{}
	canceled, parentCancel := context.WithCancel(context.WithValue(WithProject(context.Background(), "validation"), key{}, "retained"))
	budget, budgetCancel := queryContext(canceled)
	defer budgetCancel()
	wrapped := liveDriverContext{budget}
	parentCancel()
	if wrapped.Err() != context.Canceled || wrapped.Value(key{}) != "retained" {
		t.Fatal("driver lost earlier parent cancellation or values")
	}
}

func TestLiveFiveQueriesForOneHundredTraces(t *testing.T) {
	f := liveTestFilter()
	f.Service = "matching-service"
	f.Search = "child"
	matching, ancestors := [][]driver.Value{}, [][]driver.Value{}
	for i := 0; i < 100; i++ {
		trace := fmt.Sprintf("%032x", i+1)
		for _, spec := range []struct {
			span, parent, name string
			target             *[][]driver.Value
		}{{"0000000000000002", "0000000000000001", "child", &matching}, {"0000000000000001", "", "root", &ancestors}} {
			p := liveTestPayload(t, false, map[string]any{"TraceId": trace, "SpanId": spec.span, "ParentSpanId": spec.parent, "SpanName": spec.name})
			r, err := liveDecode(p, false)
			if err != nil {
				t.Fatal(err)
			}
			*spec.target = append(*spec.target, []driver.Value{liveIdentity(r, p), p, int64(1), false, false, f.From.UnixNano()})
		}
	}
	calls := 0
	var done <-chan struct{}
	query := func(ctx context.Context, q string, args []driver.NamedValue) (driver.Rows, error) {
		calls++
		if calls == 1 {
			done = ctx.Done()
		} else if done != ctx.Done() {
			t.Fatal("component restarted budget")
		}
		if !strings.Contains(q, scope) {
			t.Fatal("component lost trusted project/time scope")
		}
		switch calls {
		case 1:
			return rows(matching...), nil
		case 2:
			return rows(), nil
		case 3:
			if !strings.Contains(q, "row_number()") || strings.Contains(q, "ServiceName =") || strings.Contains(q, "positionCaseInsensitive") {
				t.Fatal("context query lost role")
			}
			return rows(ancestors...), nil
		case 4:
			return rows([]driver.Value{int64(0), int64(100), int64(0)}), nil
		case 5:
			return rows(), nil
		default:
			t.Fatal("N+1 query")
			return rows(), nil
		}
	}
	store := NewStore(sql.OpenDB(liveTestConnector{testConnector{query: query}}))
	t.Cleanup(func() { _ = store.Close() })
	r, err := store.Live(WithProject(context.Background(), "validation"), f)
	if err != nil || calls != 5 || len(r.Spans) != 100 || len(r.Context) != 100 || r.ContextTruncated {
		t.Fatalf("bounded context: calls=%d spans=%d context=%d error=%v", calls, len(r.Spans), len(r.Context), err)
	}
}

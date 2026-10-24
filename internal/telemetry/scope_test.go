package telemetry

import (
	"context"
	"database/sql/driver"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestMissingProjectScopeFailsBeforeStorage(t *testing.T) {
	store := testStore(t, func(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
		t.Fatal("unscoped query reached storage")
		return nil, nil
	})
	ctx := context.Background()
	_, err := store.Traces(ctx, testFilter())
	if !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
	_, err = store.Logs(ctx, testFilter())
	if !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
	_, err = store.Trace(ctx, traceID, testFilter())
	if !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
	_, err = store.Live(ctx, liveTestFilter())
	if !errors.Is(err, ErrScope) {
		t.Fatal(err)
	}
}

func TestAllQueriesParameterizeProject(t *testing.T) {
	for _, project := range []string{"11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"} {
		f := testFilter()
		f.project = project
		l := liveTestFilter()
		l.project = project
		builders := []func() (string, []any){func() (string, []any) { return tracesQuery(f) }, func() (string, []any) { return spansQuery(f) }, func() (string, []any) { return logsQuery(f, 50) }, func() (string, []any) { return liveMatchingQuery(l, false) }, func() (string, []any) { return liveMatchingQuery(l, true) }, func() (string, []any) { return liveHistogramQuery(l, false) }, func() (string, []any) { return liveHistogramQuery(l, true) }, func() (string, []any) { return liveContextQuery(l, []string{traceID}, nil) }}
		for _, build := range builders {
			q, args := build()
			if !strings.Contains(q, "ResourceAttributes['logice.project.id'] = ?") || strings.Contains(q, project) {
				t.Fatal("project scope is absent or interpolated")
			}
			found := false
			for _, a := range args {
				if reflect.DeepEqual(a, project) {
					found = true
				}
			}
			if !found || strings.Count(q, "?") != len(args) {
				t.Fatal("missing project argument")
			}
		}
		id := liveIdentity(LiveRecord{Kind: "span", TraceID: traceID, SpanID: "0123456789abcdef", ResourceAttributes: map[string]string{"logice.project.id": project}}, "")
		if !strings.HasPrefix(id, "span:"+project+":") {
			t.Fatal("identity lost project", id)
		}
	}
}

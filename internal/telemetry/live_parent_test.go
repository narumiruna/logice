package telemetry

import (
	"reflect"
	"strings"
	"testing"
)

func TestLiveMatchingParentEligibility(t *testing.T) {
	const own = "abcdef0123456789"
	const parent = "fedcba9876543210"
	span := LiveRecord{ID: "matching", Kind: "span", TraceID: traceID, SpanID: own, ParentSpanID: parent}
	log := LiveRecord{ID: "matching", Kind: "log", TraceID: traceID, SpanID: parent, ParentSpanID: own}
	tests := []struct {
		name         string
		record       LiveRecord
		field, value string
		conflict     bool
		wantParent   string
		contextTrace string
		contextSpan  string
		wantAncestor bool
	}{
		{name: "span uses parent span ID", record: span, wantParent: parent, wantAncestor: true},
		{name: "log uses own span ID", record: log, wantParent: parent, wantAncestor: true},
		{name: "log ignores malformed parent span ID", record: log, field: "parent", value: "bad", wantParent: parent, wantAncestor: true},
		{name: "content conflict preserves edge", record: span, conflict: true, wantParent: parent, wantAncestor: true},
		{name: "missing own span ID", record: span, field: "span"},
		{name: "short own span ID", record: span, field: "span", value: "bad"},
		{name: "nonhex own span ID", record: span, field: "span", value: strings.Repeat("g", 16)},
		{name: "zero own span ID", record: span, field: "span", value: strings.Repeat("0", 16)},
		{name: "missing log span ID", record: log, field: "span"},
		{name: "malformed log span ID", record: log, field: "span", value: "bad"},
		{name: "zero log span ID", record: log, field: "span", value: strings.Repeat("0", 16)},
		{name: "missing trace ID", record: span, field: "trace"},
		{name: "short trace ID", record: span, field: "trace", value: "bad"},
		{name: "nonhex trace ID", record: span, field: "trace", value: strings.Repeat("g", 32)},
		{name: "zero trace ID", record: span, field: "trace", value: strings.Repeat("0", 32)},
		{name: "missing parent ID", record: span, field: "parent"},
		{name: "short parent ID", record: span, field: "parent", value: "bad"},
		{name: "nonhex parent ID", record: span, field: "parent", value: strings.Repeat("g", 16)},
		{name: "zero parent ID", record: span, field: "parent", value: strings.Repeat("0", 16)},
		{name: "span parent conflict", record: span, field: "parentConflict"},
		{name: "log parent conflict", record: log, field: "parentConflict"},
		{name: "uppercase own span ID", record: span, field: "span", value: strings.ToUpper(own), wantParent: parent, wantAncestor: true},
		{name: "uppercase trace ID", record: span, field: "trace", value: strings.ToUpper(traceID), wantParent: parent, wantAncestor: true},
		{name: "uppercase parent ID", record: span, field: "parent", value: strings.ToUpper(parent), wantParent: strings.ToUpper(parent), wantAncestor: true},
		{name: "uppercase log span ID", record: log, field: "span", value: strings.ToUpper(parent), wantParent: strings.ToUpper(parent), wantAncestor: true},
		{name: "missing context parent", record: span, wantParent: parent, contextSpan: own},
		{name: "parent from another trace", record: span, wantParent: parent, contextTrace: strings.Repeat("f", 32)},
		{name: "traversal does not normalize IDs", record: span, field: "parent", value: strings.ToUpper(parent), wantParent: strings.ToUpper(parent), contextSpan: parent},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := tt.record
			r.Conflict = tt.conflict
			switch tt.field {
			case "span":
				r.SpanID = tt.value
			case "trace":
				r.TraceID = tt.value
			case "parent":
				r.ParentSpanID = tt.value
			case "parentConflict":
				r.ParentConflict = true
			}
			f := liveTestFilter()
			f.project = "project"
			traces := []string{traceID}
			query, args := liveContextQuery(f, traces, []LiveRecord{r})
			pairs := []string{}
			if tt.wantParent != "" {
				pairs = append(pairs, strings.ToLower(r.TraceID)+":"+strings.ToLower(tt.wantParent))
			}
			wantArgs := []any{pairs, f.project, f.From.UnixNano(), f.To.UnixNano(), traces, []string{r.ID}, traces}
			if !reflect.DeepEqual(args, wantArgs) {
				t.Fatalf("query args = %#v, want %#v", args, wantArgs)
			}
			if strings.Count(query, "?") != len(wantArgs) || !strings.Contains(query, "HAVING identity NOT IN (?)") || !strings.Contains(query, "has(?, concat(traceGroup,':',splitByChar(':',identity)[4]))") {
				t.Fatalf("context placeholders or exclusions changed: %s", query)
			}
			ancestor := LiveRecord{ID: "parent", Kind: "span", TraceID: r.TraceID, SpanID: parent}
			if tt.wantParent != "" {
				ancestor.SpanID = tt.wantParent
			}
			if tt.contextSpan != "" {
				ancestor.SpanID = tt.contextSpan
			}
			if tt.contextTrace != "" {
				ancestor.TraceID = tt.contextTrace
			}
			want := []LiveRecord{}
			if tt.wantAncestor {
				want = append(want, ancestor)
			}
			if got := liveAncestors([]LiveRecord{ancestor}, []LiveRecord{r}); !reflect.DeepEqual(got, want) {
				t.Fatalf("ancestors = %#v, want %#v", got, want)
			}
		})
	}
}

func TestLiveContextExcludesAllMatchingIDs(t *testing.T) {
	const parent = "abcdef0123456789"
	matching := []LiveRecord{
		{ID: "span", Kind: "span", TraceID: traceID, SpanID: "0000000000000001", ParentSpanID: parent},
		{ID: "invalid-own-span", Kind: "span", TraceID: traceID, SpanID: "bad", ParentSpanID: parent},
		{ID: "invalid-trace", Kind: "span", TraceID: "bad", SpanID: "0000000000000001", ParentSpanID: parent},
		{ID: "conflict", Kind: "span", TraceID: traceID, SpanID: "0000000000000001", ParentSpanID: parent, ParentConflict: true},
		{ID: "missing-parent", Kind: "span", TraceID: traceID, SpanID: "0000000000000001"},
		{ID: "log", Kind: "log", TraceID: strings.ToUpper(traceID), SpanID: strings.ToUpper(parent)},
		{ID: "log", Kind: "log", TraceID: traceID, SpanID: parent},
		{ID: "", Kind: "log"},
	}
	f := liveTestFilter()
	_, args := liveContextQuery(f, []string{traceID}, matching)
	wantIDs := []string{"span", "invalid-own-span", "invalid-trace", "conflict", "missing-parent", "log", "log", ""}
	if !reflect.DeepEqual(args[5], wantIDs) {
		t.Fatalf("exclusions = %#v, want %#v", args[5], wantIDs)
	}
	pair := traceID + ":" + parent
	if want := []string{pair, pair, pair}; !reflect.DeepEqual(args[0], want) {
		t.Fatalf("parent pairs = %#v, want %#v", args[0], want)
	}
	_, args = liveContextQuery(f, []string{}, nil)
	if !reflect.DeepEqual(args[0], []string{}) || !reflect.DeepEqual(args[5], []string{}) {
		t.Fatalf("empty pairs/exclusions changed: %#v", args)
	}
}

func TestLiveAncestorTraversalBoundaries(t *testing.T) {
	root := LiveRecord{ID: "root", Kind: "span", TraceID: traceID, SpanID: "0000000000000001"}
	parent := LiveRecord{ID: "parent", Kind: "span", TraceID: traceID, SpanID: "0000000000000002", ParentSpanID: root.SpanID}
	child := LiveRecord{ID: "child", Kind: "span", TraceID: traceID, SpanID: "0000000000000003", ParentSpanID: parent.SpanID}
	ambiguous := parent
	ambiguous.ParentConflict = true
	cyclic := parent
	cyclic.ParentSpanID = child.SpanID
	missing := parent
	missing.ParentSpanID = "0000000000000004"
	tests := []struct {
		name     string
		parent   LiveRecord
		matching []LiveRecord
		want     []LiveRecord
	}{
		{name: "complete path keeps context order", parent: parent, matching: []LiveRecord{child}, want: []LiveRecord{root, parent}},
		{name: "ambiguous ancestor is kept but stops traversal", parent: ambiguous, matching: []LiveRecord{child}, want: []LiveRecord{ambiguous}},
		{name: "two node cycle terminates", parent: cyclic, matching: []LiveRecord{child}, want: []LiveRecord{cyclic}},
		{name: "matching ancestor overrides context edge", parent: parent, matching: []LiveRecord{child, {ID: "matching-parent", Kind: "span", TraceID: traceID, SpanID: parent.SpanID, ParentConflict: true}}, want: []LiveRecord{}},
		{name: "matching ancestor continues path", parent: parent, matching: []LiveRecord{child, parent}, want: []LiveRecord{root, parent}},
		{name: "missing ancestor stops path", parent: missing, matching: []LiveRecord{child}, want: []LiveRecord{missing}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := liveAncestors([]LiveRecord{root, tt.parent}, tt.matching); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("ancestors = %#v, want %#v", got, tt.want)
			}
		})
	}
}

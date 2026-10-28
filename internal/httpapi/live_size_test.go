package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

type livePreflightCancelContext struct {
	context.Context
	checks int
}

func (c *livePreflightCancelContext) Err() error {
	c.checks++
	if c.checks >= 2 {
		return context.Canceled
	}
	return nil
}

func TestLivePreflightExactSizeAndAllocation(t *testing.T) {
	f := telemetry.LiveFilter{From: time.Now().UTC(), To: time.Now().UTC().Add(time.Minute)}
	for _, body := range []string{"", `quote\" and slash/`, "<>&\x00\b\f\n\r\t\u2028\u2029é", string([]byte{0xff, 0xfe})} {
		r := telemetry.NewLiveSnapshot(f, time.Now())
		r.Filters.ErrorsOnly = true
		r.SpansTruncated = true
		r.Logs = []telemetry.LiveRecord{{Body: body, Attributes: map[string]string{body: body}, Stored: map[string]json.RawMessage{"raw": json.RawMessage(" { \"x\": [\"<>&\\n\u2028\u2029\", 2] } ")}}}
		raw, err := json.Marshal(r)
		if err != nil {
			t.Fatal(err)
		}
		n, err := liveEncodedSize(context.Background(), r)
		if err != nil || n != len(raw)+1 {
			t.Fatalf("body %q: size %d expected %d: %v", body, n, len(raw)+1, err)
		}
	}
	// Input is allocated before measurement. The preflight must not allocate
	// an escaped copy, whose size would be more than 48 MiB.
	r := telemetry.NewLiveSnapshot(f, time.Now())
	r.Logs = []telemetry.LiveRecord{{Body: strings.Repeat("<>&\x00", 2<<20)}}
	if _, err := liveEncodedSize(context.Background(), r); !errors.Is(err, errLiveResponseTooLarge) {
		t.Fatal("escaped expansion accepted")
	}
	allocs := testing.AllocsPerRun(3, func() { _, _ = liveEncodedSize(context.Background(), r) })
	if allocs > 1000 {
		t.Fatal("preflight allocates per input character", allocs)
	}
	result := testing.Benchmark(func(b *testing.B) {
		for b.Loop() {
			_, _ = liveEncodedSize(context.Background(), r)
		}
	})
	if result.AllocedBytesPerOp() > 64<<10 {
		t.Fatal("preflight allocated a large encoded copy", result.AllocedBytesPerOp())
	}
	rawResult := telemetry.NewLiveSnapshot(f, time.Now())
	rawResult.Logs = []telemetry.LiveRecord{{Stored: map[string]json.RawMessage{"large": json.RawMessage(`"` + strings.Repeat("<>&", 2<<20) + `"`)}}}
	if _, err := liveEncodedSize(context.Background(), rawResult); !errors.Is(err, errLiveResponseTooLarge) {
		t.Fatal("large raw HTML expansion accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := liveEncodedSize(ctx, r); !errors.Is(err, context.Canceled) {
		t.Fatal("preflight ignored cancellation")
	}
	midScan := &livePreflightCancelContext{Context: context.Background()}
	if _, err := liveEncodedSize(midScan, r); !errors.Is(err, context.Canceled) || midScan.checks < 2 {
		t.Fatal("preflight did not check cancellation during a large string scan")
	}
	t.Logf("oversized preflight: %.0f allocations, %d allocated bytes/op", allocs, result.AllocedBytesPerOp())
}

func TestLiveEncodedSizeUTF8(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
	}{
		{"invalid byte", "\xff"},
		{"truncated sequence", "\xe2\x82"},
		{"mixed text", "valid é \xff \ufffd"},
		{"map keys and values", map[string]string{"\xff": "\xfe"}},
		{"raw invalid byte", json.RawMessage("\"\xff\"")},
		{"raw valid replacement", json.RawMessage("\"\ufffd\"")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.value)
			if err != nil {
				t.Fatal(err)
			}
			size, err := liveEncodedSize(context.Background(), tc.value)
			if err != nil || size != len(raw)+1 {
				t.Fatalf("size %d expected %d for %s: %v", size, len(raw)+1, raw, err)
			}
		})
	}
}

func TestLiveEncodedLimit(t *testing.T) {
	b := &liveBuffer{}
	if n, err := b.Write([]byte(strings.Repeat("x", liveResponseLimit))); err != nil || n != liveResponseLimit {
		t.Fatal("exact cap rejected")
	}
	if _, err := b.Write([]byte("\n")); !errors.Is(err, errLiveResponseTooLarge) || b.Len() != liveResponseLimit {
		t.Fatal("cap overflow accepted")
	}
	reader := liveFakeReader{live: func(ctx context.Context, f telemetry.LiveFilter) (telemetry.LiveSnapshot, error) {
		r := telemetry.NewLiveSnapshot(f, time.Now())
		r.Logs = []telemetry.LiveRecord{{Stored: map[string]json.RawMessage{"bad": json.RawMessage(`invalid-secret-json`)}}}
		return r, nil
	}}
	w := httptest.NewRecorder()
	newHandler(reader).ServeHTTP(w, httptest.NewRequest("GET", "/api/live", nil))
	if w.Code != 503 || strings.Contains(w.Body.String(), "secret") || !json.Valid(w.Body.Bytes()) {
		t.Fatal("serialization exposed partial success")
	}
}

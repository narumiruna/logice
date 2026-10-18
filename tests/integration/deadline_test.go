//go:build integration

package integration

import (
	"testing"
	"time"
)

func TestStackWorkDeadline(t *testing.T) {
	now := time.Date(2026, 10, 18, 0, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name  string
		suite time.Time
		want  time.Duration
	}{
		{"no suite deadline", time.Time{}, 6*time.Minute + 45*time.Second},
		{"own work ceiling", now.Add(8 * time.Minute), 6*time.Minute + 45*time.Second},
		{"later test retains cleanup reserve", now.Add(7 * time.Minute), 5*time.Minute + 50*time.Second},
		{"exact reserve leaves no work", now.Add(70 * time.Second), 0},
		{"insufficient reserve", now.Add(30 * time.Second), -40 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := stackWorkDeadline(now, tc.suite)
			if !got.Equal(now.Add(tc.want)) {
				t.Fatalf("work deadline offset %s, want %s", got.Sub(now), tc.want)
			}
			if !tc.suite.IsZero() && tc.suite.Sub(got) < 70*time.Second {
				t.Fatal("work deadline consumes failure-log/cleanup reserve")
			}
		})
	}
}

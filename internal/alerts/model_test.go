package alerts

import (
	"errors"
	"github.com/narumiruna/logice/internal/telemetry"
	"testing"
	"time"
)

func TestAlertTransitionsAndUnknownData(t *testing.T) {
	now := time.Now().UTC()
	ratio := 0.5
	r := Rule{Kind: "error_ratio", Threshold: "0.1", MinPopulation: 10, CreatedAt: now.Add(-time.Hour), State: "pending"}
	data := telemetry.Overview{OverviewStats: telemetry.OverviewStats{Traces: "20", ErrorProportion: &ratio}}
	for i := 0; i < 2; i++ {
		var transition string
		r, transition = Evaluate(r, data, nil, now.Add(time.Duration(i)*time.Minute))
		if transition != "" || r.Active {
			t.Fatal("fired too soon")
		}
	}
	next, transition := Evaluate(r, data, nil, now.Add(2*time.Minute))
	if transition != "firing" || !next.Active {
		t.Fatal("sustained breach did not fire")
	}
	fired := now.Add(2 * time.Minute)
	next.LastNotified = &fired
	unknown, transition := Evaluate(next, data, errors.New("storage unavailable"), now.Add(3*time.Minute))
	if unknown.State != "unknown" || !unknown.Active || transition != "" {
		t.Fatal("outage treated as recovery")
	}
	data.ErrorProportion = nil
	if value, _ := Evaluate(next, data, nil, now.Add(3*time.Minute)); value.State != "unknown" {
		t.Fatal("insufficient data treated as healthy")
	}
	healthy := 0.0
	data.ErrorProportion = &healthy
	r, transition = Evaluate(unknown, data, nil, now.Add(7*time.Minute))
	if transition != "" || !r.Active {
		t.Fatal("resolved without two healthy windows")
	}
	r, transition = Evaluate(r, data, nil, now.Add(8*time.Minute))
	if transition != "resolved" || r.Active {
		t.Fatal("recovery did not resolve")
	}
	grace := Rule{Kind: "no_data", CreatedAt: now, Threshold: "0", MinPopulation: 1}
	if r, _ := Evaluate(grace, telemetry.Overview{}, nil, now.Add(time.Minute)); r.State != "pending" {
		t.Fatal("new rule ignored grace")
	}
	empty := telemetry.Overview{OverviewStats: telemetry.OverviewStats{Spans: "0", Logs: "0"}}
	for i := 0; i < 3; i++ {
		grace, transition = Evaluate(grace, empty, nil, now.Add(time.Duration(6+i)*time.Minute))
	}
	if transition != "firing" {
		t.Fatal("missing data never fired")
	}
}
func TestInvalidRuleDefinitions(t *testing.T) {
	base := Rule{Name: "Rule", Kind: "error_ratio", Threshold: "0.1", MinPopulation: 1}
	if !base.Valid() {
		t.Fatal("valid rule rejected")
	}
	for _, threshold := range []string{"NaN", "+Inf", "-1", "2"} {
		r := base
		r.Threshold = threshold
		if r.Valid() {
			t.Fatal("invalid ratio", threshold)
		}
	}
	r := base
	r.Kind = "root_p95"
	r.Threshold = "0"
	if r.Valid() {
		t.Fatal("zero latency threshold")
	}
	r.Threshold = "9223372036854775808"
	if r.Valid() {
		t.Fatal("overflow latency threshold")
	}
}

//go:build integration

package auth

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/narumiruna/logice/internal/alerts"
	"github.com/narumiruna/logice/internal/telemetry"
)

type alertFixtureReader struct {
	failed  atomic.Bool
	calls   atomic.Int32
	healthy atomic.Bool
}

func (r *alertFixtureReader) Overview(_ context.Context, f telemetry.Filter) (telemetry.Overview, error) {
	r.calls.Add(1)
	if r.failed.Load() {
		return telemetry.Overview{}, errors.New("storage outage")
	}
	ratio := 0.5
	if r.healthy.Load() {
		ratio = 0
	}
	return telemetry.Overview{From: f.From, To: f.To, OverviewStats: telemetry.OverviewStats{Traces: "20", Spans: "20", Logs: "1", RootSpans: "1", ErrorProportion: &ratio}}, nil
}
func TestDurableAlertWorker(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	crypto, err := alerts.NewCrypto(strings.Repeat("11", 32))
	if err != nil {
		t.Fatal(err)
	}
	user, project, destination, rule := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Minute).Add(45 * time.Second)
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO auth_users(id,name,active) VALUES($1,'Alert owner',true)", user)
	exec("INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Alerts',$2)", project, user)
	rawURL := "https://example.com/private/token-must-not-leak"
	exec("INSERT INTO alert_destinations(id,project_id,name,encrypted_url) VALUES($1,$2,'Receiver',$3)", destination, project, crypto.Seal(rawURL, project, destination))
	exec("INSERT INTO alert_rules(id,project_id,destination_id,name,kind,threshold,min_population,created_at,next_at) VALUES($1,$2,$3,'Errors','error_ratio','0.1',10,$4,$5)", rule, project, destination, now.Add(-time.Hour), now.Add(-time.Minute))
	reader := &alertFixtureReader{}
	var sends atomic.Int32
	var eventID string
	var mu sync.Mutex
	send := func(_ context.Context, url, id string, payload []byte) (string, bool) {
		if url != rawURL || strings.Contains(string(payload), "token-must-not-leak") {
			t.Error("destination or payload redaction")
		}
		var event struct {
			ProjectID string `json:"projectId"`
			RuleID    string `json:"ruleId"`
			EventID   string `json:"eventId"`
		}
		if json.Unmarshal(payload, &event) != nil || event.ProjectID != project || event.RuleID != rule || event.EventID != id {
			t.Error("event scope")
		}
		mu.Lock()
		eventID = id
		mu.Unlock()
		sends.Add(1)
		return "delivered", false
	}
	worker := &alerts.Worker{Pool: pool, Reader: reader, Crypto: crypto, Send: send}
	var wg sync.WaitGroup
	for n := 0; n < 4; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := worker.Tick(ctx, now); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if reader.calls.Load() != 1 {
		t.Fatal("multiple workers evaluated same window", reader.calls.Load())
	}
	if sends.Load() != 0 {
		t.Fatal("fired before sustained breach")
	}
	// A crashed claim blocks another worker until its durable lease expires.
	exec("UPDATE alert_rules SET lease_id=$2,lease_until=$3,next_at=$4 WHERE id=$1", rule, uuid.NewString(), now.Add(45*time.Second), now.Add(-time.Minute))
	if err := worker.Tick(ctx, now.Add(30*time.Second)); err != nil {
		t.Fatal(err)
	}
	if reader.calls.Load() != 1 {
		t.Fatal("an unexpired claim was stolen")
	}
	worker = &alerts.Worker{Pool: pool, Reader: reader, Crypto: crypto, Send: send}
	for _, offset := range []time.Duration{time.Minute, 2 * time.Minute} {
		if err := worker.Tick(ctx, now.Add(offset)); err != nil {
			t.Fatal(err)
		}
	}
	if sends.Load() != 1 || eventID == "" {
		t.Fatal("durable firing not delivered", sends.Load())
	}
	if err := worker.Tick(ctx, now.Add(2*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if sends.Load() != 1 {
		t.Fatal("duplicate window delivered twice")
	}
	reader.failed.Store(true)
	if err := worker.Tick(ctx, now.Add(3*time.Minute)); err != nil {
		t.Fatal(err)
	}
	var state string
	var active bool
	if err := pool.QueryRow(ctx, "SELECT state,incident_active FROM alert_rules WHERE id=$1", rule).Scan(&state, &active); err != nil || state != "unknown" || !active {
		t.Fatal("storage outage resolved incident", state, active, err)
	}
	reader.failed.Store(false)
	reader.healthy.Store(true)
	for _, offset := range []time.Duration{8 * time.Minute, 9 * time.Minute} {
		if err := worker.Tick(ctx, now.Add(offset)); err != nil {
			t.Fatal(err)
		}
	}
	if sends.Load() != 2 {
		t.Fatal("recovery notification missing", sends.Load())
	}
	var count int
	if pool.QueryRow(ctx, "SELECT count(*) FROM alert_incidents WHERE project_id=$1", project).Scan(&count) != nil || count != 2 {
		t.Fatal("incident transitions", count)
	}
	// Simulate receiver acceptance followed by a crash before the durable acknowledgement.
	replayed := eventID
	exec("UPDATE alert_deliveries SET state='pending',lease_id=$2,lease_until=$3,next_at=$3 WHERE id=$1", replayed, uuid.NewString(), now.Add(-time.Minute))
	if err := worker.Tick(ctx, now.Add(9*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if sends.Load() != 3 || eventID != replayed {
		t.Fatal("retry did not preserve the stable event ID")
	}
	// Exhausted retries produce an explicit terminal failure.
	exec("INSERT INTO alert_deliveries(id,project_id,destination_id,payload,attempts,next_at) VALUES($1,$2,$3,'{}',7,$4)", uuid.NewString(), project, destination, now)
	failing := &alerts.Worker{Pool: pool, Reader: reader, Crypto: crypto, Send: func(context.Context, string, string, []byte) (string, bool) { return "transport_failure", true }}
	if err := failing.Tick(ctx, now.Add(10*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if pool.QueryRow(ctx, "SELECT count(*) FROM alert_deliveries WHERE attempts=8 AND state='failed'").Scan(&count) != nil || count != 1 {
		t.Fatal("retry exhaustion was not terminal")
	}
	// A deleted project cannot authorize a new delivery, including a pending test notification.
	exec("INSERT INTO alert_deliveries(id,project_id,destination_id,payload) VALUES($1,$2,$3,'{}')", uuid.NewString(), project, destination)
	exec("UPDATE projects SET deleted_at=now() WHERE id=$1", project)
	if err := worker.Tick(ctx, now.Add(11*time.Minute)); err != nil {
		t.Fatal(err)
	}
	if sends.Load() != 3 {
		t.Fatal("deleted project delivered new work")
	}
	if pool.QueryRow(ctx, "SELECT count(*) FROM alert_deliveries WHERE project_id=$1 AND state='pending'", project).Scan(&count) != nil || count != 0 {
		t.Fatal("deleted project retained pending work")
	}
}

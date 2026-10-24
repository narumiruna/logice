//go:build integration

package integration

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/logice/internal/alerts"
	query "github.com/narumiruna/logice/internal/telemetry"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	trace "go.opentelemetry.io/proto/otlp/trace/v1"
)

func TestRealTelemetryAlertDelivery(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	f := newTelemetry(t)
	span := f.span("alert-error", f.parentID, nil)
	span.Status = &trace.Status{Code: trace.Status_STATUS_CODE_ERROR}
	s.exportHTTP("/v1/traces", traceRequest(span), &collectortrace.ExportTraceServiceResponse{})
	s.waitCount(db, "otel_traces", fmt.Sprintf("%x", f.traceID), 1)
	config, err := pgxpool.ParseConfig("host=127.0.0.1 user=logice dbname=logice sslmode=disable")
	s.must("PG config", err)
	host, rawPort, err := net.SplitHostPort(s.ports["postgres"])
	s.must("PG port", err)
	port, err := strconv.ParseUint(rawPort, 10, 16)
	s.must("PG number", err)
	config.ConnConfig.Host = host
	config.ConnConfig.Port = uint16(port)
	config.ConnConfig.Password = s.secrets[0]
	pool, err := pgxpool.NewWithConfig(s.ctx, config)
	s.must("PG pool", err)
	defer pool.Close()
	store, err := query.Open(s.ports["clickhouse"], s.secrets[1])
	s.must("overview reader", err)
	defer store.Close()
	crypto, err := alerts.NewCrypto(s.secrets[3])
	s.must("worker crypto", err)
	now := f.start.Add(2 * time.Minute).Truncate(time.Minute).Add(45 * time.Second)
	other := uuid.NewString()
	_, err = pool.Exec(s.ctx, "INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Empty comparison',$2)", other, fixtureUser)
	s.must("other project", err)
	for _, project := range []string{fixtureProject, other} {
		dest, rule := uuid.NewString(), uuid.NewString()
		_, err = pool.Exec(s.ctx, "INSERT INTO alert_destinations(id,project_id,name,encrypted_url) VALUES($1,$2,'Test receiver',$3)", dest, project, crypto.Seal("https://receiver.example/notify", project, dest))
		s.must("destination fixture", err)
		_, err = pool.Exec(s.ctx, "INSERT INTO alert_rules(id,project_id,destination_id,name,kind,threshold,min_population,created_at,next_at) VALUES($1,$2,$3,'Errors','error_ratio','0.1',1,$4,$5)", rule, project, dest, now.Add(-time.Hour), now.Add(-time.Minute))
		s.must("rule fixture", err)
	}
	var notifications atomic.Int32
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var event struct {
			EventID    string `json:"eventId"`
			ProjectID  string `json:"projectId"`
			Transition string `json:"transition"`
		}
		if json.NewDecoder(r.Body).Decode(&event) != nil || event.EventID != r.Header.Get("X-Logice-Event-ID") || event.ProjectID != fixtureProject || event.Transition != "firing" {
			t.Error("wrong notification identity or project")
		}
		notifications.Add(1)
		w.WriteHeader(204)
	}))
	defer receiver.Close()
	// Test-only TLS receiver transport; production uses the separately tested DNS/IP-pinned sender.
	worker := alerts.Worker{Pool: pool, Reader: store, Crypto: crypto, Send: func(ctx context.Context, _, id string, payload []byte) (string, bool) {
		req, err := http.NewRequestWithContext(ctx, "POST", receiver.URL, bytes.NewReader(payload))
		if err != nil {
			t.Error(err)
			return "transport_failure", true
		}
		req.Header.Set("X-Logice-Event-ID", id)
		res, err := receiver.Client().Do(req)
		if err != nil {
			t.Error(err)
			return "transport_failure", true
		}
		res.Body.Close()
		if res.StatusCode != 204 {
			return "rejected_status", false
		}
		return "delivered", false
	}}
	for minute := 0; minute < 3; minute++ {
		for n := 0; n < 2; n++ {
			s.must("worker evaluation", worker.Tick(s.ctx, now.Add(time.Duration(minute)*time.Minute)))
		}
	}
	if notifications.Load() != 1 {
		t.Fatal("isolated real telemetry did not produce exactly one firing notification", notifications.Load())
	}
	var unknown string
	s.must("empty project rule", pool.QueryRow(s.ctx, "SELECT state FROM alert_rules WHERE project_id=$1", other).Scan(&unknown))
	if unknown != "unknown" {
		t.Fatal("empty population treated as healthy or borrowed another project's data", unknown)
	}
}

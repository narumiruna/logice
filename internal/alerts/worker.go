package alerts

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/logice/internal/telemetry"
)

var ErrQueueFull = errors.New("notification queue full")

func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}
func Enqueue(ctx context.Context, tx pgx.Tx, project, destination, rule, revision, id string, payload []byte) error {
	if len(payload) > 16<<10 {
		return ErrQueueFull
	}
	if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(754382022)"); err != nil {
		return err
	}
	var count, local int
	if err := tx.QueryRow(ctx, "SELECT count(*),count(*) FILTER(WHERE project_id=$1) FROM alert_deliveries WHERE state='pending'", project).Scan(&count, &local); err != nil {
		return err
	}
	if count >= 1000 || local >= 100 {
		return ErrQueueFull
	}
	tag, err := tx.Exec(ctx, `INSERT INTO alert_deliveries(id,project_id,destination_id,rule_id,revision,payload) SELECT $1,$2::uuid,$3,nullif($4,'')::uuid,nullif($5,'')::bigint,$6 FROM alert_destinations d JOIN projects p ON p.id=d.project_id WHERE d.id=$3 AND d.project_id=$2::uuid AND NOT d.disabled AND p.deleted_at IS NULL`, id, project, destination, rule, revision, payload)
	if err != nil {
		return err
	}
	if tag.RowsAffected() != 1 {
		return errors.New("destination unavailable")
	}
	return nil
}

type Worker struct {
	Pool   *pgxpool.Pool
	Reader telemetry.OverviewReader
	Crypto *Crypto
	// Send is a transport dependency; nil uses the production SSRF-protected sender.
	Send func(context.Context, string, string, []byte) (string, bool)
}

func (w *Worker) Run(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return nil
		}
		var now time.Time
		step, cancel := context.WithTimeout(ctx, 20*time.Second)
		err := w.Pool.QueryRow(step, "SELECT clock_timestamp()").Scan(&now)
		if err == nil {
			err = w.Tick(step, now.UTC())
		}
		cancel()
		// Caller receives a fixed error without URLs or credentials. A restart uses durable leases.
		if err != nil && ctx.Err() == nil {
			return errors.New("alert worker cycle failed; restart after storage recovery")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
func (w *Worker) Tick(ctx context.Context, now time.Time) error {
	// Bounded cleanup. Pending deliveries expire as explicit terminal failures, never vanish.
	_, err := w.Pool.Exec(ctx, "UPDATE alert_deliveries SET state='failed',last_result='expired',lease_id=NULL WHERE id IN (SELECT id FROM alert_deliveries WHERE state='pending' AND created_at<$1::timestamptz-interval '24 hours' LIMIT 100)", now)
	if err != nil {
		return err
	}
	for _, table := range []string{"alert_deliveries", "alert_incidents"} {
		predicate := ""
		if table == "alert_deliveries" {
			predicate = " AND state<>'pending'"
		}
		if _, err = w.Pool.Exec(ctx, "DELETE FROM "+table+" WHERE id IN (SELECT id FROM "+table+" WHERE created_at<$1::timestamptz-interval '30 days'"+predicate+" ORDER BY created_at LIMIT 100)", now); err != nil {
			return err
		}
	}
	_, err = w.Pool.Exec(ctx, `UPDATE alert_deliveries SET state='canceled',lease_id=NULL WHERE id IN (SELECT q.id FROM alert_deliveries q JOIN projects p ON p.id=q.project_id JOIN alert_destinations d ON d.id=q.destination_id LEFT JOIN alert_rules r ON r.id=q.rule_id WHERE q.state='pending' AND (p.deleted_at IS NOT NULL OR d.disabled OR (q.rule_id IS NOT NULL AND (NOT r.enabled OR r.revision<>q.revision))) LIMIT 100)`)
	if err != nil {
		return err
	}
	if err = w.evaluate(ctx, now); err != nil && !errors.Is(err, ErrQueueFull) {
		return err
	}
	return w.deliver(ctx, now)
}
func (w *Worker) evaluate(ctx context.Context, now time.Time) error {
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var r Rule
	err = tx.QueryRow(ctx, `SELECT r.id::text,r.project_id::text,r.destination_id::text,r.name,r.kind,r.service,r.threshold,r.min_population,r.enabled,r.revision::text,r.state,r.bad,r.good,r.incident_active,r.last_notified,r.created_at FROM alert_rules r JOIN projects p ON p.id=r.project_id JOIN alert_destinations d ON d.id=r.destination_id AND d.project_id=r.project_id WHERE r.enabled AND NOT d.disabled AND p.deleted_at IS NULL AND r.next_at<=$1 AND (r.lease_until IS NULL OR r.lease_until<=$1) ORDER BY r.next_at,r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`, now).Scan(&r.ID, &r.ProjectID, &r.DestinationID, &r.Name, &r.Kind, &r.Service, &r.Threshold, &r.MinPopulation, &r.Enabled, &r.Revision, &r.State, &r.Bad, &r.Good, &r.Active, &r.LastNotified, &r.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	r.Lease = uuid.NewString()
	if _, err = tx.Exec(ctx, "UPDATE alert_rules SET lease_id=$2,lease_until=$3 WHERE id=$1", r.ID, r.Lease, now.Add(30*time.Second)); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	end := now.Add(-30 * time.Second).Truncate(time.Minute)
	data, readErr := w.Reader.Overview(telemetry.WithProject(ctx, r.ProjectID), telemetry.Filter{From: end.Add(-5 * time.Minute), To: end, Service: r.Service})
	next, transition := Evaluate(r, data, readErr, now)
	save, err := w.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(save)
	var live bool
	if err = save.QueryRow(ctx, "SELECT deleted_at IS NULL FROM projects WHERE id=$1 FOR UPDATE", r.ProjectID).Scan(&live); err != nil {
		return err
	}
	if !live {
		return nil
	}
	var valid bool
	if err = save.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM alert_rules WHERE id=$1 AND lease_id=$2 AND revision=$3::bigint AND enabled AND (last_window_to IS NULL OR last_window_to<$4) FOR UPDATE)`, r.ID, r.Lease, r.Revision, end).Scan(&valid); err != nil {
		return err
	}
	if !valid {
		return nil
	}
	if transition != "" {
		eventID := uuid.NewString()
		payload, _ := json.Marshal(map[string]any{"version": 1, "eventId": eventID, "projectId": r.ProjectID, "ruleId": r.ID, "ruleRevision": r.Revision, "transition": transition, "window": map[string]time.Time{"from": data.From, "to": data.To}, "statistics": data.OverviewStats})
		if err = Enqueue(ctx, save, r.ProjectID, r.DestinationID, r.ID, r.Revision, eventID, payload); err != nil {
			return err
		}
		if _, err = save.Exec(ctx, "INSERT INTO alert_incidents(id,project_id,rule_id,revision,transition,window_to) VALUES($1,$2,$3,$4::bigint,$5,$6)", eventID, r.ProjectID, r.ID, r.Revision, transition, end); err != nil {
			return err
		}
		next.LastNotified = &now
	}
	if _, err = save.Exec(ctx, `UPDATE alert_rules SET state=$3,bad=$4,good=$5,incident_active=$6,last_notified=$7,next_at=$8,lease_id=NULL,lease_until=NULL,last_window_to=$9 WHERE id=$1 AND lease_id=$2`, r.ID, r.Lease, next.State, next.Bad, next.Good, next.Active, next.LastNotified, end.Add(90*time.Second), end); err != nil {
		return err
	}
	return save.Commit(ctx)
}
func (w *Worker) deliver(ctx context.Context, now time.Time) error {
	tx, err := w.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	var id, project, destination string
	var ciphertext, payload []byte
	var attempts int
	err = tx.QueryRow(ctx, `SELECT q.id::text,q.project_id::text,q.destination_id::text,d.encrypted_url,q.payload,q.attempts FROM alert_deliveries q JOIN projects p ON p.id=q.project_id JOIN alert_destinations d ON d.id=q.destination_id AND d.project_id=q.project_id LEFT JOIN alert_rules r ON r.id=q.rule_id WHERE q.state='pending' AND q.next_at<=$1 AND (q.lease_until IS NULL OR q.lease_until<=$1) AND p.deleted_at IS NULL AND NOT d.disabled AND (q.rule_id IS NULL OR (r.enabled AND r.revision=q.revision)) ORDER BY q.next_at,q.id FOR UPDATE OF q SKIP LOCKED LIMIT 1`, now).Scan(&id, &project, &destination, &ciphertext, &payload, &attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	lease := uuid.NewString()
	if _, err = tx.Exec(ctx, "UPDATE alert_deliveries SET lease_id=$2,lease_until=$3 WHERE id=$1", id, lease, now.Add(30*time.Second)); err != nil {
		return err
	}
	if err = tx.Commit(ctx); err != nil {
		return err
	}
	raw, err := w.Crypto.Open(ciphertext, project, destination)
	result, retry := "invalid_destination", false
	if err == nil {
		send := w.Send
		if send == nil {
			send = Deliver
		}
		result, retry = send(ctx, raw, id, payload)
	}
	attempts++
	state := "failed"
	if result == "delivered" {
		state = "delivered"
	} else if retry && attempts < 8 {
		state = "pending"
	}
	delay := min(time.Duration(1<<min(attempts, 6))*5*time.Second, 5*time.Minute)
	_, err = w.Pool.Exec(ctx, "UPDATE alert_deliveries SET state=$3,attempts=$4,last_result=$5,next_at=$6,lease_id=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND state='pending'", id, lease, state, attempts, result, now.Add(delay))
	return err
}

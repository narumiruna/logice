package auth

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/narumiruna/logice/internal/alerts"
)

type destinationMetadata struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Revision string `json:"revision"`
	Disabled bool   `json:"disabled"`
}

func (s *Service) projectAlerts(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User, tail []string) {
	if len(tail) == 0 {
		projectMissing(w)
		return
	}
	section := tail[0]
	tail = tail[1:]
	if section == "destinations" {
		s.alertDestinations(w, r, tx, p, u, tail)
		return
	}
	if section == "rules" {
		s.alertRules(w, r, tx, p, u, tail)
		return
	}
	if r.Method != http.MethodGet || len(tail) != 0 || (section != "incidents" && section != "deliveries") {
		projectMissing(w)
		return
	}
	offset, ok := page(r)
	if !ok {
		projectInvalid(w)
		return
	}
	type record struct {
		ID        string    `json:"id"`
		RuleID    *string   `json:"ruleId"`
		State     string    `json:"state"`
		Result    string    `json:"result"`
		CreatedAt time.Time `json:"createdAt"`
	}
	statement := `SELECT id::text,rule_id::text,transition,''::text,created_at FROM alert_incidents WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $2`
	if section == "deliveries" {
		statement = `SELECT id::text,rule_id::text,state,last_result,created_at FROM alert_deliveries WHERE project_id=$1 ORDER BY created_at DESC,id DESC LIMIT 101 OFFSET $2`
	}
	rows, err := tx.Query(r.Context(), statement, p.ID, offset)
	if err != nil {
		unavailable(w)
		return
	}
	defer rows.Close()
	items := []record{}
	for rows.Next() {
		var item record
		if rows.Scan(&item.ID, &item.RuleID, &item.State, &item.Result, &item.CreatedAt) != nil {
			unavailable(w)
			return
		}
		items = append(items, item)
	}
	if rows.Err() != nil {
		unavailable(w)
		return
	}
	more := len(items) > 100
	if more {
		items = items[:100]
	}
	response(w, 200, map[string]any{"items": items, "hasMore": more})
}
func (s *Service) alertDestinations(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User, tail []string) {
	if len(tail) > 2 || (len(tail) > 0 && !projectID(tail[0])) {
		projectMissing(w)
		return
	}
	if r.Method == http.MethodGet && len(tail) == 0 {
		rows, err := tx.Query(r.Context(), "SELECT id::text,name,revision::text,disabled FROM alert_destinations WHERE project_id=$1 ORDER BY created_at,id LIMIT 6", p.ID)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []destinationMetadata{}
		for rows.Next() {
			var item destinationMetadata
			if rows.Scan(&item.ID, &item.Name, &item.Revision, &item.Disabled) != nil {
				unavailable(w)
				return
			}
			items = append(items, item)
		}
		if rows.Err() != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]any{"items": items})
		return
	}
	if p.Role != "Owner" {
		projectForbidden(w)
		return
	}
	var in struct {
		Name     string `json:"name"`
		URL      string `json:"url"`
		Revision string `json:"revision"`
	}
	if strictJSON(r, &in) != nil {
		projectInvalid(w)
		return
	}
	if len(tail) == 2 && tail[1] == "test" && r.Method == http.MethodPost {
		var disabled bool
		if tx.QueryRow(r.Context(), "SELECT disabled FROM alert_destinations WHERE project_id=$1 AND id=$2", p.ID, tail[0]).Scan(&disabled) != nil {
			projectMissing(w)
			return
		}
		if disabled {
			failure(w, 409, "destination_disabled", "Enable this destination first.")
			return
		}
		id := uuid.NewString()
		payload, _ := json.Marshal(map[string]any{"version": 1, "eventId": id, "projectId": p.ID, "transition": "test", "occurredAt": time.Now().UTC()})
		if err := alerts.Enqueue(r.Context(), tx, p.ID, tail[0], "", "", id, payload); err != nil {
			failure(w, 409, "queue_full", "Notification queue unavailable or full.")
			return
		}
		if err := projectAudit(r.Context(), tx, p.ID, u.ID, "test_alert_destination", tail[0]); err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 202, map[string]string{"eventId": id})
		return
	}
	if len(tail) == 0 && r.Method == http.MethodPost {
		if !validName(in.Name) || in.Revision != "" || alerts.ValidateDestination(r.Context(), in.URL) != nil {
			projectInvalid(w)
			return
		}
		var count int
		if tx.QueryRow(r.Context(), "SELECT count(*) FROM alert_destinations WHERE project_id=$1", p.ID).Scan(&count) != nil {
			unavailable(w)
			return
		}
		if count >= 5 {
			failure(w, 409, "destination_limit", "At most five destinations per project.")
			return
		}
		id := uuid.NewString()
		_, err := tx.Exec(r.Context(), "INSERT INTO alert_destinations(id,project_id,name,encrypted_url) VALUES($1,$2,$3,$4)", id, p.ID, in.Name, s.alertCrypto.Seal(in.URL, p.ID, id))
		if err == nil {
			err = projectAudit(r.Context(), tx, p.ID, u.ID, "create_alert_destination", id)
		}
		if err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 201, destinationMetadata{ID: id, Name: in.Name, Revision: "1"})
		return
	}
	if len(tail) != 1 || (r.Method != http.MethodPatch && r.Method != http.MethodDelete) {
		projectMissing(w)
		return
	}
	var revision string
	err := tx.QueryRow(r.Context(), "SELECT revision::text FROM alert_destinations WHERE project_id=$1 AND id=$2", p.ID, tail[0]).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		projectMissing(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	if revision != in.Revision {
		failure(w, 409, "destination_conflict", "Reload this destination before editing.")
		return
	}
	if r.Method == http.MethodDelete {
		_, err = tx.Exec(r.Context(), "UPDATE alert_destinations SET disabled=true,revision=revision+1 WHERE project_id=$1 AND id=$2", p.ID, tail[0])
	} else {
		if !validName(in.Name) {
			projectInvalid(w)
			return
		}
		if in.URL != "" {
			if alerts.ValidateDestination(r.Context(), in.URL) != nil {
				projectInvalid(w)
				return
			}
			_, err = tx.Exec(r.Context(), "UPDATE alert_destinations SET name=$3,encrypted_url=$4,disabled=false,revision=revision+1 WHERE project_id=$1 AND id=$2", p.ID, tail[0], in.Name, s.alertCrypto.Seal(in.URL, p.ID, tail[0]))
		} else {
			_, err = tx.Exec(r.Context(), "UPDATE alert_destinations SET name=$3,revision=revision+1 WHERE project_id=$1 AND id=$2", p.ID, tail[0], in.Name)
		}
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), "UPDATE alert_deliveries SET state='canceled',lease_id=NULL WHERE project_id=$1 AND destination_id=$2 AND state='pending'", p.ID, tail[0])
	}
	if err == nil && r.Method == http.MethodDelete {
		_, err = tx.Exec(r.Context(), "UPDATE alert_rules SET enabled=false,revision=revision+1,lease_id=NULL WHERE project_id=$1 AND destination_id=$2", p.ID, tail[0])
	}
	if err == nil {
		err = projectAudit(r.Context(), tx, p.ID, u.ID, "change_alert_destination", tail[0])
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 200, map[string]bool{"ok": true})
}
func (s *Service) alertRules(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User, tail []string) {
	if len(tail) > 1 || (len(tail) == 1 && !projectID(tail[0])) {
		projectMissing(w)
		return
	}
	if r.Method == http.MethodGet && len(tail) == 0 {
		rows, err := tx.Query(r.Context(), `SELECT id::text,project_id::text,destination_id::text,name,kind,service,threshold,min_population,enabled,revision::text,state,bad,good,incident_active,last_notified,created_at,last_window_to FROM alert_rules WHERE project_id=$1 ORDER BY created_at,id LIMIT 21`, p.ID)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []alerts.Rule{}
		for rows.Next() {
			var v alerts.Rule
			if rows.Scan(&v.ID, &v.ProjectID, &v.DestinationID, &v.Name, &v.Kind, &v.Service, &v.Threshold, &v.MinPopulation, &v.Enabled, &v.Revision, &v.State, &v.Bad, &v.Good, &v.Active, &v.LastNotified, &v.CreatedAt, &v.LastWindowTo) != nil {
				unavailable(w)
				return
			}
			if v.Enabled && v.LastWindowTo != nil && time.Since(*v.LastWindowTo) > 150*time.Second {
				v.State = "unknown"
			}
			items = append(items, v)
		}
		if rows.Err() != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]any{"items": items})
		return
	}
	if p.Role != "Owner" && p.Role != "Developer" {
		projectForbidden(w)
		return
	}
	var in struct {
		Name          string `json:"name"`
		Kind          string `json:"kind"`
		Service       string `json:"service"`
		Threshold     string `json:"threshold"`
		MinPopulation int    `json:"minPopulation"`
		DestinationID string `json:"destinationId"`
		Revision      string `json:"revision"`
		Enabled       bool   `json:"enabled"`
	}
	if strictJSON(r, &in) != nil {
		projectInvalid(w)
		return
	}
	rule := alerts.Rule{Name: in.Name, Kind: in.Kind, Service: in.Service, Threshold: in.Threshold, MinPopulation: in.MinPopulation}
	if r.Method != http.MethodDelete && (!rule.Valid() || !validName(in.Name) || !projectID(in.DestinationID)) {
		projectInvalid(w)
		return
	}
	if r.Method != http.MethodDelete {
		var valid bool
		if tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM alert_destinations WHERE project_id=$1 AND id=$2 AND NOT disabled)", p.ID, in.DestinationID).Scan(&valid) != nil {
			unavailable(w)
			return
		}
		if !valid {
			projectInvalid(w)
			return
		}
	}
	id := uuid.NewString()
	action := "create_alert_rule"
	var err error
	if r.Method == http.MethodPost && len(tail) == 0 {
		if in.Revision != "" {
			projectInvalid(w)
			return
		}
		var count int
		if tx.QueryRow(r.Context(), "SELECT count(*) FROM alert_rules WHERE project_id=$1", p.ID).Scan(&count) != nil {
			unavailable(w)
			return
		}
		if count >= 20 {
			failure(w, 409, "rule_limit", "At most twenty rules per project.")
			return
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO alert_rules(id,project_id,destination_id,name,kind,service,threshold,min_population,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", id, p.ID, in.DestinationID, in.Name, in.Kind, in.Service, in.Threshold, in.MinPopulation, in.Enabled)
	} else if len(tail) == 1 && (r.Method == http.MethodPatch || r.Method == http.MethodDelete) {
		id = tail[0]
		action = "change_alert_rule"
		var revision int64
		err = tx.QueryRow(r.Context(), "SELECT revision FROM alert_rules WHERE project_id=$1 AND id=$2", p.ID, id).Scan(&revision)
		if errors.Is(err, pgx.ErrNoRows) {
			projectMissing(w)
			return
		}
		if err != nil {
			unavailable(w)
			return
		}
		if strconv.FormatInt(revision, 10) != in.Revision {
			failure(w, 409, "rule_conflict", "Reload this rule before editing.")
			return
		}
		if r.Method == http.MethodDelete {
			_, err = tx.Exec(r.Context(), "UPDATE alert_rules SET enabled=false,revision=revision+1,lease_id=NULL WHERE project_id=$1 AND id=$2", p.ID, id)
		} else {
			_, err = tx.Exec(r.Context(), "UPDATE alert_rules SET name=$3,kind=$4,service=$5,threshold=$6,min_population=$7,destination_id=$8,enabled=$9,revision=revision+1,state='pending',bad=0,good=0,incident_active=false,last_notified=NULL,lease_id=NULL,next_at=now(),last_window_to=NULL WHERE project_id=$1 AND id=$2", p.ID, id, in.Name, in.Kind, in.Service, in.Threshold, in.MinPopulation, in.DestinationID, in.Enabled)
		}
		if err == nil {
			_, err = tx.Exec(r.Context(), "UPDATE alert_deliveries SET state='canceled',lease_id=NULL WHERE project_id=$1 AND rule_id=$2 AND state='pending'", p.ID, id)
		}
	} else {
		projectMissing(w)
		return
	}
	if err == nil {
		err = projectAudit(r.Context(), tx, p.ID, u.ID, action, id)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 200, map[string]string{"id": id})
}

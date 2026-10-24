package auth

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
)

var projectActions = map[string]bool{"create_alert_destination": true, "change_alert_destination": true, "test_alert_destination": true, "create_alert_rule": true, "change_alert_rule": true, "create": true, "patch": true, "delete": true, "member_post": true, "member_patch": true, "member_delete": true, "transfer_owner": true, "create_token": true, "revoke_token": true, "operator_account_recovery": true, "create_view": true, "view_PATCH": true, "view_DELETE": true}

type eventCursor struct {
	Project string `json:"project"`
	Action  string `json:"action"`
	From    string `json:"from"`
	To      string `json:"to"`
	High    string `json:"high"`
	Last    string `json:"last"`
}
type projectEvent struct {
	ID         string    `json:"id"`
	Action     string    `json:"action"`
	ActorID    *string   `json:"actorId"`
	ActorKind  string    `json:"actorKind"`
	ActorName  string    `json:"actorName"`
	Target     string    `json:"target"`
	OccurredAt time.Time `json:"occurredAt"`
}

func decodeEventCursor(raw []byte, cursor *eventCursor) error {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(cursor); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("invalid cursor")
	}
	return nil
}

func (s *Service) projectEvents(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project) {
	if p.Role != "Owner" {
		projectForbidden(w)
		return
	}
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	q := r.URL.Query()
	for k, v := range q {
		if len(v) != 1 || (k != "from" && k != "to" && k != "action" && k != "cursor") {
			projectInvalid(w)
			return
		}
	}
	action := q.Get("action")
	if action != "" && !projectActions[action] {
		projectInvalid(w)
		return
	}
	var c eventCursor
	raw := q.Get("cursor")
	if len(raw) > 2048 {
		projectInvalid(w)
		return
	}
	if raw != "" {
		data, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || decodeEventCursor(data, &c) != nil || c.Project != p.ID || c.Action != action || (q.Get("from") != "" && q.Get("from") != c.From) || (q.Get("to") != "" && q.Get("to") != c.To) {
			projectInvalid(w)
			return
		}
	} else {
		now := time.Now().UTC()
		c = eventCursor{Project: p.ID, Action: action, From: q.Get("from"), To: q.Get("to")}
		if c.From == "" && c.To == "" {
			c.From = now.Add(-24 * time.Hour).Format(time.RFC3339Nano)
			c.To = now.Format(time.RFC3339Nano)
		}
	}
	from, e1 := time.Parse(time.RFC3339Nano, c.From)
	to, e2 := time.Parse(time.RFC3339Nano, c.To)
	if e1 != nil || e2 != nil || !from.Before(to) || to.Sub(from) > 30*24*time.Hour {
		projectInvalid(w)
		return
	}
	var high, last int64
	if raw == "" {
		if tx.QueryRow(r.Context(), "SELECT coalesce(max(id),0) FROM project_events WHERE project_id=$1", p.ID).Scan(&high) != nil {
			unavailable(w)
			return
		}
		last = high
	} else {
		var err error
		high, err = strconv.ParseInt(c.High, 10, 64)
		if err != nil || high < 1 {
			projectInvalid(w)
			return
		}
		last, err = strconv.ParseInt(c.Last, 10, 64)
		if err != nil || last < 1 || last > high {
			projectInvalid(w)
			return
		}
		last--
	}
	rows, err := tx.Query(r.Context(), `SELECT e.id::text,e.action,e.actor_user_id::text,u.name,e.target,e.occurred_at FROM project_events e JOIN auth_users u ON u.id=e.actor_user_id WHERE e.project_id=$1 AND e.id<=$2 AND e.id<=$3 AND e.occurred_at >=$4 AND e.occurred_at<$5 AND ($6='' OR e.action=$6) ORDER BY e.id DESC LIMIT 101`, p.ID, high, last, from, to, action)
	if err != nil {
		unavailable(w)
		return
	}
	defer rows.Close()
	items := []projectEvent{}
	for rows.Next() {
		var e projectEvent
		var actor string
		if rows.Scan(&e.ID, &e.Action, &actor, &e.ActorName, &e.Target, &e.OccurredAt) != nil {
			unavailable(w)
			return
		}
		e.ActorKind = "account"
		e.ActorID = &actor
		if e.Action == "operator_account_recovery" {
			e.ActorKind = "operator"
			e.ActorID = nil
			e.ActorName = "Operator identity not recorded"
		}
		if !projectID(e.Target) {
			e.Target = "Legacy target unavailable"
		}
		items = append(items, e)
	}
	if rows.Err() != nil {
		unavailable(w)
		return
	}
	next := ""
	if len(items) > 100 {
		items = items[:100]
		c.High = strconv.FormatInt(high, 10)
		c.Last = items[99].ID
		data, _ := json.Marshal(c)
		next = base64.RawURLEncoding.EncodeToString(data)
	}
	response(w, 200, map[string]any{"items": items, "nextCursor": next, "from": c.From, "to": c.To})
}

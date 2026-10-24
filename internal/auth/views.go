package auth

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/narumiruna/logice/internal/telemetry"
)

type ViewDefinition struct {
	Version int    `json:"version"`
	Kind    string `json:"kind"`
	Live    bool   `json:"live"`
	Time    struct {
		Mode  string `json:"mode"`
		Range string `json:"range"`
		From  string `json:"from"`
		To    string `json:"to"`
	} `json:"time"`
	Filters struct {
		Service     string `json:"service"`
		Search      string `json:"search"`
		ErrorsOnly  bool   `json:"errorsOnly"`
		MinSeverity int    `json:"minSeverity"`
		TraceID     string `json:"traceId"`
		Limit       int    `json:"limit"`
	} `json:"filters"`
	Display struct {
		Headers    bool `json:"headers"`
		Follow     bool `json:"follow"`
		AutoExpand bool `json:"autoExpand"`
	} `json:"display"`
}

func strictJSON(r *http.Request, dst any) error {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return err
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return errors.New("unexpected data")
	}
	return nil
}
func (d ViewDefinition) valid() bool {
	if d.Version != 1 || (d.Kind != "traces" && d.Kind != "logs" && d.Kind != "live") || !utf8.ValidString(d.Filters.Service) || !utf8.ValidString(d.Filters.Search) {
		return false
	}
	from, to := time.Now().UTC().Add(-time.Hour), time.Now().UTC()
	if d.Time.Mode == "fixed" {
		var err error
		from, err = time.Parse(time.RFC3339Nano, d.Time.From)
		if err != nil {
			return false
		}
		to, err = time.Parse(time.RFC3339Nano, d.Time.To)
		if err != nil {
			return false
		}
		if d.Time.Range != "" || (d.Kind == "live" && (d.Live || to.Sub(from) < time.Second || to.Sub(from) > 15*time.Minute)) {
			return false
		}
	} else if d.Time.Mode == "relative" {
		if d.Time.From != "" || d.Time.To != "" {
			return false
		}
		if d.Kind == "live" {
			if d.Time.Range != "1m" && d.Time.Range != "5m" && d.Time.Range != "15m" {
				return false
			}
		} else if d.Time.Range != "15m" && d.Time.Range != "1h" && d.Time.Range != "6h" && d.Time.Range != "24h" {
			return false
		}
	} else {
		return false
	}
	if d.Kind != "live" && (d.Live || d.Display.Headers || d.Display.Follow || d.Display.AutoExpand) {
		return false
	}
	if (d.Kind == "traces" && (d.Filters.MinSeverity != 0 || d.Filters.TraceID != "")) || (d.Kind == "logs" && d.Filters.ErrorsOnly) || (d.Kind == "live" && d.Filters.TraceID != "") {
		return false
	}
	f := telemetry.Filter{From: from, To: to, Service: d.Filters.Service, Search: d.Filters.Search, ErrorsOnly: d.Filters.ErrorsOnly, MinSeverity: d.Filters.MinSeverity, TraceID: d.Filters.TraceID, Limit: d.Filters.Limit}
	return f.Validate() == nil && d.Filters.Limit >= 1
}

type savedView struct {
	ID         string          `json:"id"`
	Name       string          `json:"name"`
	Definition json.RawMessage `json:"definition"`
	Revision   string          `json:"revision"`
	CreatorID  string          `json:"creatorId"`
	UpdaterID  string          `json:"updaterId"`
	CreatedAt  time.Time       `json:"createdAt"`
	UpdatedAt  time.Time       `json:"updatedAt"`
}

func (s *Service) projectViews(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User, tail []string) {
	if len(tail) > 1 || (len(tail) == 1 && !projectID(tail[0])) {
		projectMissing(w)
		return
	}
	if r.Method == http.MethodGet {
		offset, ok := page(r)
		if !ok {
			projectInvalid(w)
			return
		}
		id := ""
		if len(tail) == 1 {
			id = tail[0]
		}
		rows, err := tx.Query(r.Context(), `SELECT id::text,name,definition,revision::text,creator_user_id::text,updater_user_id::text,created_at,updated_at FROM project_views WHERE project_id=$1 AND ($2='' OR id::text=$2) ORDER BY id LIMIT 101 OFFSET $3`, p.ID, id, offset)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []savedView{}
		for rows.Next() {
			var v savedView
			if rows.Scan(&v.ID, &v.Name, &v.Definition, &v.Revision, &v.CreatorID, &v.UpdaterID, &v.CreatedAt, &v.UpdatedAt) != nil {
				unavailable(w)
				return
			}
			items = append(items, v)
		}
		if rows.Err() != nil {
			unavailable(w)
			return
		}
		if id != "" {
			if len(items) == 0 {
				projectMissing(w)
			} else {
				response(w, 200, items[0])
			}
			return
		}
		more := len(items) > 100
		if more {
			items = items[:100]
		}
		response(w, 200, map[string]any{"items": items, "hasMore": more})
		return
	}
	if p.Role != "Owner" && p.Role != "Developer" {
		projectForbidden(w)
		return
	}
	var in struct {
		Name       string         `json:"name"`
		Definition ViewDefinition `json:"definition"`
		Revision   string         `json:"revision"`
	}
	if strictJSON(r, &in) != nil {
		projectInvalid(w)
		return
	}
	if r.Method == http.MethodPost && len(tail) == 0 {
		raw, _ := json.Marshal(in.Definition)
		if !validName(in.Name) || !in.Definition.valid() || len(raw) > 16<<10 || in.Revision != "" {
			projectInvalid(w)
			return
		}
		var count int
		if tx.QueryRow(r.Context(), "SELECT count(*) FROM project_views WHERE project_id=$1", p.ID).Scan(&count) != nil {
			unavailable(w)
			return
		}
		if count >= 100 {
			failure(w, 409, "view_limit", "Saved view limit reached.")
			return
		}
		id := uuid.NewString()
		_, err := tx.Exec(r.Context(), "INSERT INTO project_views(id,project_id,name,definition,creator_user_id,updater_user_id) VALUES($1,$2,$3,$4,$5,$5)", id, p.ID, in.Name, raw, u.ID)
		if err == nil {
			err = projectAudit(r.Context(), tx, p.ID, u.ID, "create_view", id)
		}
		if err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 201, map[string]string{"id": id, "revision": "1"})
		return
	}
	if len(tail) != 1 || (r.Method != http.MethodPatch && r.Method != http.MethodDelete) {
		w.Header().Set("Allow", "GET, POST, PATCH, DELETE")
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	revision, err := strconv.ParseInt(in.Revision, 10, 64)
	if err != nil || revision < 1 {
		projectInvalid(w)
		return
	}
	var current int64
	err = tx.QueryRow(r.Context(), "SELECT revision FROM project_views WHERE project_id=$1 AND id=$2", p.ID, tail[0]).Scan(&current)
	if errors.Is(err, pgx.ErrNoRows) {
		projectMissing(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	if revision != current {
		failure(w, 409, "view_conflict", "This view changed. Reload before editing.")
		return
	}
	if r.Method == http.MethodDelete {
		if in.Name != "" || in.Definition.Version != 0 {
			projectInvalid(w)
			return
		}
		_, err = tx.Exec(r.Context(), "DELETE FROM project_views WHERE project_id=$1 AND id=$2", p.ID, tail[0])
	} else {
		raw, _ := json.Marshal(in.Definition)
		if !validName(in.Name) || !in.Definition.valid() || len(raw) > 16<<10 {
			projectInvalid(w)
			return
		}
		_, err = tx.Exec(r.Context(), "UPDATE project_views SET name=$3,definition=$4,revision=revision+1,updater_user_id=$5,updated_at=now() WHERE project_id=$1 AND id=$2", p.ID, tail[0], in.Name, raw, u.ID)
	}
	if err == nil {
		err = projectAudit(r.Context(), tx, p.ID, u.ID, "view_"+r.Method, tail[0])
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 200, map[string]bool{"ok": true})
}

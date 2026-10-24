package auth

import (
	"context"
	"crypto/subtle"
	"errors"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/narumiruna/logice/internal/telemetry"
)

type Project struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	OwnerID   string    `json:"ownerId"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"createdAt"`
}
type ProjectToken struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	CreatorID string     `json:"creatorId"`
	CreatedAt time.Time  `json:"createdAt"`
	ExpiresAt *time.Time `json:"expiresAt"`
	RevokedAt *time.Time `json:"revokedAt"`
	Status    string     `json:"status"`
	Token     string     `json:"token,omitempty"`
}

func projectID(raw string) bool { id, err := uuid.Parse(raw); return err == nil && id.String() == raw }

func page(r *http.Request) (int, bool) {
	q := r.URL.Query()
	if r.URL.RawQuery == "" {
		return 0, true
	}
	if len(q) != 1 || len(q["offset"]) != 1 {
		return 0, false
	}
	n, e := strconv.Atoi(q.Get("offset"))
	return n, e == nil && n >= 0 && n <= 100000
}

func (s *Service) projectMutation(w http.ResponseWriter, r *http.Request) bool {
	csrf := s.readCookie(r, "csrf")
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" || r.Header.Get("Origin") != s.settings.origin || csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
		failure(w, 403, "csrf_failed", "Request origin or CSRF token is invalid.")
		return false
	}
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		failure(w, 415, "invalid_content_type", "JSON is required.")
		return false
	}
	if !s.limits.allow(csrf, time.Now()) {
		w.Header().Set("Retry-After", "60")
		failure(w, 429, "rate_limited", "Too many requests.")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	return true
}

// lockProject serializes mutations and evaluates access under the same row lock.
func lockProject(ctx context.Context, tx pgx.Tx, id, user string) (Project, error) {
	var p Project
	err := tx.QueryRow(ctx, `SELECT id::text,name,owner_user_id::text,created_at FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, id).Scan(&p.ID, &p.Name, &p.OwnerID, &p.CreatedAt)
	if err != nil {
		return p, err
	}
	if p.OwnerID == user {
		p.Role = "Owner"
		return p, nil
	}
	err = tx.QueryRow(ctx, "SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2", id, user).Scan(&p.Role)
	return p, err
}

func projectAudit(ctx context.Context, tx pgx.Tx, pid, actor, action, target string) error {
	_, err := tx.Exec(ctx, "INSERT INTO project_events(project_id,actor_user_id,action,target) VALUES($1,$2,$3,$4)", pid, actor, action, target)
	return err
}
func projectMissing(w http.ResponseWriter) {
	failure(w, 404, "not_found", "Project or resource not found.")
}
func projectForbidden(w http.ResponseWriter) {
	failure(w, 403, "forbidden", "Project role does not permit this action.")
}
func projectInvalid(w http.ResponseWriter) {
	failure(w, 400, "invalid_request", "Invalid project request or unavailable account.")
}

// projectRoute owns explicit project URLs. Unscoped telemetry routes never reach storage.
func (s *Service) projectRoute(w http.ResponseWriter, r *http.Request, u *User, next http.Handler) {
	originalContext := r.Context()
	ctx, cancel := context.WithTimeout(originalContext, 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/"), "/")
	if len(parts) == 0 || parts[0] != "projects" {
		projectMissing(w)
		return
	}
	if r.Method != http.MethodGet && !s.projectMutation(w, r) {
		return
	}
	if len(parts) == 1 {
		s.projectCollection(w, r, u)
		return
	}
	if !projectID(parts[1]) {
		projectMissing(w)
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	p, err := lockProject(r.Context(), tx, parts[1], u.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		projectMissing(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	if len(parts) >= 3 && (parts[2] == "traces" || parts[2] == "logs" || parts[2] == "live") {
		if err = tx.Commit(r.Context()); err != nil {
			unavailable(w)
			return
		}
		clone := r.Clone(telemetry.WithProject(originalContext, p.ID))
		clone.URL.Path = "/api/" + strings.Join(parts[2:], "/")
		next.ServeHTTP(w, clone)
		return
	}
	if r.Method == http.MethodGet && r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		projectForbidden(w)
		return
	}
	if len(parts) == 2 {
		if r.Method == http.MethodGet {
			response(w, 200, p)
			return
		}
		if p.Role != "Owner" {
			projectForbidden(w)
			return
		}
		switch r.Method {
		case http.MethodPatch:
			var in struct {
				Name string `json:"name"`
			}
			if decode(r, &in) != nil || !validName(in.Name) {
				projectInvalid(w)
				return
			}
			_, err = tx.Exec(r.Context(), "UPDATE projects SET name=$2 WHERE id=$1", p.ID, in.Name)
			p.Name = in.Name
		case http.MethodDelete:
			var in struct{}
			if decode(r, &in) != nil {
				projectInvalid(w)
				return
			}
			_, err = tx.Exec(r.Context(), "UPDATE projects SET deleted_at=now() WHERE id=$1", p.ID)
			if err == nil {
				_, err = tx.Exec(r.Context(), "UPDATE project_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE project_id=$1", p.ID)
			}
		default:
			w.Header().Set("Allow", "GET, PATCH, DELETE")
			failure(w, 405, "method_not_allowed", "Method not allowed.")
			return
		}
		if err == nil {
			err = projectAudit(r.Context(), tx, p.ID, u.ID, strings.ToLower(r.Method), p.ID)
		}
		if err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 200, p)
		return
	}
	switch parts[2] {
	case "members":
		s.projectMembers(w, r, tx, p, u, parts[3:])
	case "owner":
		if len(parts) != 3 {
			projectMissing(w)
			return
		}
		s.projectOwner(w, r, tx, p, u)
	case "tokens":
		s.projectTokens(w, r, tx, p, u, parts[3:])
	default:
		projectMissing(w)
	}
}

func (s *Service) projectCollection(w http.ResponseWriter, r *http.Request, u *User) {
	if r.Method == http.MethodGet {
		offset, ok := page(r)
		if !ok {
			projectInvalid(w)
			return
		}
		rows, err := s.pool.Query(r.Context(), `SELECT p.id::text,p.name,p.owner_user_id::text,p.created_at,CASE WHEN p.owner_user_id=$1 THEN 'Owner' ELSE m.role END FROM projects p LEFT JOIN project_members m ON m.project_id=p.id AND m.user_id=$1 WHERE p.deleted_at IS NULL AND (p.owner_user_id=$1 OR m.user_id=$1) ORDER BY p.id LIMIT 101 OFFSET $2`, u.ID, offset)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []Project{}
		for rows.Next() {
			var p Project
			if rows.Scan(&p.ID, &p.Name, &p.OwnerID, &p.CreatedAt, &p.Role) != nil {
				unavailable(w)
				return
			}
			items = append(items, p)
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
		return
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "GET, POST")
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	var in struct {
		Name string `json:"name"`
	}
	if decode(r, &in) != nil || !validName(in.Name) || r.URL.RawQuery != "" {
		projectInvalid(w)
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	var active bool
	if tx.QueryRow(r.Context(), "SELECT active FROM auth_users WHERE id=$1 FOR UPDATE", u.ID).Scan(&active) != nil {
		unavailable(w)
		return
	}
	if !active {
		denied(w)
		return
	}
	var count int
	if tx.QueryRow(r.Context(), "SELECT count(*) FROM projects WHERE owner_user_id=$1 AND deleted_at IS NULL", u.ID).Scan(&count) != nil {
		unavailable(w)
		return
	}
	if count >= 100 {
		failure(w, 409, "project_limit", "Project limit reached.")
		return
	}
	p := Project{ID: uuid.NewString(), Name: in.Name, OwnerID: u.ID, Role: "Owner"}
	err = tx.QueryRow(r.Context(), "INSERT INTO projects(id,name,owner_user_id) VALUES($1,$2,$3) RETURNING created_at", p.ID, p.Name, u.ID).Scan(&p.CreatedAt)
	if err == nil {
		err = projectAudit(r.Context(), tx, p.ID, u.ID, "create", p.ID)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 201, p)
}

func (s *Service) projectMembers(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User, tail []string) {
	if r.Method == http.MethodGet && len(tail) == 0 {
		offset, ok := page(r)
		if !ok {
			projectInvalid(w)
			return
		}
		rows, err := tx.Query(r.Context(), `SELECT u.id::text,u.name,m.role FROM (SELECT owner_user_id AS user_id,'Owner' AS role FROM projects WHERE id=$1 UNION ALL SELECT user_id,role FROM project_members WHERE project_id=$1) m JOIN auth_users u ON u.id=m.user_id ORDER BY u.id LIMIT 101 OFFSET $2`, p.ID, offset)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []map[string]string{}
		for rows.Next() {
			var id, name, role string
			if rows.Scan(&id, &name, &role) != nil {
				unavailable(w)
				return
			}
			items = append(items, map[string]string{"userId": id, "name": name, "role": role})
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
		return
	}
	if p.Role != "Owner" {
		projectForbidden(w)
		return
	}
	var in struct {
		UserID string `json:"userId"`
		Role   string `json:"role"`
	}
	if decode(r, &in) != nil || r.URL.RawQuery != "" {
		projectInvalid(w)
		return
	}
	if len(tail) == 1 {
		in.UserID = tail[0]
	} else if len(tail) != 0 {
		projectMissing(w)
		return
	}
	if !projectID(in.UserID) || in.UserID == p.OwnerID {
		projectInvalid(w)
		return
	}
	if r.Method != http.MethodDelete && in.Role != "Developer" && in.Role != "Viewer" {
		projectInvalid(w)
		return
	}
	var active bool
	err := tx.QueryRow(r.Context(), "SELECT active FROM auth_users WHERE id=$1", in.UserID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !active) {
		projectInvalid(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	var tagRows int64
	switch {
	case r.Method == http.MethodPost && len(tail) == 0:
		tag, e := tx.Exec(r.Context(), "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", p.ID, in.UserID, in.Role)
		err = e
		tagRows = tag.RowsAffected()
	case r.Method == http.MethodPatch && len(tail) == 1:
		tag, e := tx.Exec(r.Context(), "UPDATE project_members SET role=$3 WHERE project_id=$1 AND user_id=$2", p.ID, in.UserID, in.Role)
		err = e
		tagRows = tag.RowsAffected()
	case r.Method == http.MethodDelete && len(tail) == 1:
		tag, e := tx.Exec(r.Context(), "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", p.ID, in.UserID)
		err = e
		tagRows = tag.RowsAffected()
	default:
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	if tagRows != 1 {
		projectInvalid(w)
		return
	}
	err = projectAudit(r.Context(), tx, p.ID, u.ID, "member_"+strings.ToLower(r.Method), in.UserID)
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 200, map[string]string{"status": "ok"})
}

func (s *Service) projectOwner(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User) {
	if p.Role != "Owner" {
		projectForbidden(w)
		return
	}
	if r.Method != http.MethodPost {
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	var in struct {
		UserID string `json:"userId"`
	}
	if decode(r, &in) != nil || !projectID(in.UserID) || in.UserID == u.ID || r.URL.RawQuery != "" {
		projectInvalid(w)
		return
	}
	// Lock the recipient account to serialize the ownership quota with creation.
	var active bool
	err := tx.QueryRow(r.Context(), "SELECT active FROM auth_users WHERE id=$1 FOR UPDATE", in.UserID).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !active) {
		projectInvalid(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	var count int
	if tx.QueryRow(r.Context(), "SELECT count(*) FROM projects WHERE owner_user_id=$1 AND deleted_at IS NULL", in.UserID).Scan(&count) != nil {
		unavailable(w)
		return
	}
	if count >= 100 {
		failure(w, 409, "project_limit", "Project limit reached.")
		return
	}
	tag, err := tx.Exec(r.Context(), "DELETE FROM project_members WHERE project_id=$1 AND user_id=$2", p.ID, in.UserID)
	if err != nil {
		unavailable(w)
		return
	}
	if tag.RowsAffected() != 1 {
		projectInvalid(w)
		return
	}
	_, err = tx.Exec(r.Context(), "UPDATE projects SET owner_user_id=$2 WHERE id=$1", p.ID, in.UserID)
	if err == nil {
		_, err = tx.Exec(r.Context(), "INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'Developer')", p.ID, u.ID)
	}
	if err == nil {
		err = projectAudit(r.Context(), tx, p.ID, u.ID, "transfer_owner", in.UserID)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 200, map[string]string{"status": "ok"})
}

func (s *Service) projectTokens(w http.ResponseWriter, r *http.Request, tx pgx.Tx, p Project, u *User, tail []string) {
	if p.Role == "Viewer" {
		projectForbidden(w)
		return
	}
	if r.Method == http.MethodGet && len(tail) == 0 {
		offset, ok := page(r)
		if !ok {
			projectInvalid(w)
			return
		}
		rows, err := tx.Query(r.Context(), "SELECT id::text,name,creator_user_id::text,created_at,expires_at,revoked_at FROM project_tokens WHERE project_id=$1 ORDER BY created_at,id LIMIT 101 OFFSET $2", p.ID, offset)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []ProjectToken{}
		for rows.Next() {
			var t ProjectToken
			if rows.Scan(&t.ID, &t.Name, &t.CreatorID, &t.CreatedAt, &t.ExpiresAt, &t.RevokedAt) != nil {
				unavailable(w)
				return
			}
			t.Status = "active"
			if t.RevokedAt != nil {
				t.Status = "revoked"
			} else if t.ExpiresAt != nil && !t.ExpiresAt.After(time.Now()) {
				t.Status = "expired"
			}
			items = append(items, t)
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
		return
	}
	if r.Method != http.MethodPost {
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.URL.RawQuery != "" {
		projectInvalid(w)
		return
	}
	if len(tail) == 2 && tail[1] == "revoke" && projectID(tail[0]) {
		var in struct{}
		if decode(r, &in) != nil {
			projectInvalid(w)
			return
		}
		tag, err := tx.Exec(r.Context(), "UPDATE project_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE project_id=$1 AND id=$2", p.ID, tail[0])
		if err != nil {
			unavailable(w)
			return
		}
		if tag.RowsAffected() != 1 {
			projectMissing(w)
			return
		}
		err = projectAudit(r.Context(), tx, p.ID, u.ID, "revoke_token", tail[0])
		if err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]string{"status": "ok"})
		return
	}
	if len(tail) != 0 {
		projectMissing(w)
		return
	}
	var in struct {
		Name      string     `json:"name"`
		ExpiresAt *time.Time `json:"expiresAt"`
	}
	if decode(r, &in) != nil || !validName(in.Name) || (in.ExpiresAt != nil && (!in.ExpiresAt.After(time.Now()) || in.ExpiresAt.Year() > 9999)) {
		projectInvalid(w)
		return
	}
	var count int
	if tx.QueryRow(r.Context(), "SELECT count(*) FROM project_tokens WHERE project_id=$1 AND revoked_at IS NULL", p.ID).Scan(&count) != nil {
		unavailable(w)
		return
	}
	if count >= 100 {
		failure(w, 409, "token_limit", "Token limit reached. Revoke unused tokens.")
		return
	}
	t := ProjectToken{ID: uuid.NewString(), Name: in.Name, CreatorID: u.ID, ExpiresAt: in.ExpiresAt, Token: token(), Status: "active"}
	err := tx.QueryRow(r.Context(), "INSERT INTO project_tokens(id,project_id,name,token_hash,creator_user_id,expires_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING created_at", t.ID, p.ID, t.Name, digest(t.Token), u.ID, t.ExpiresAt).Scan(&t.CreatedAt)
	if err == nil {
		err = projectAudit(r.Context(), tx, p.ID, u.ID, "create_token", t.ID)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 201, t)
}

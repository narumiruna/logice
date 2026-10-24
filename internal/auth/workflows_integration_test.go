//go:build integration

package auth

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestSavedViewsAndAuditBoundary(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal("migration retry", err)
	}
	if err := Ready(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	ids := []string{uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()}
	sessions := []string{token(), token(), token(), token()}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	for i, id := range ids {
		exec("INSERT INTO auth_users(id,name,active,admin) VALUES($1,$2,true,$3)", id, fmt.Sprintf("Actor %d", i), i == 3)
		exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(sessions[i]), id)
	}
	p, other := uuid.NewString(), uuid.NewString()
	exec("INSERT INTO projects(id,name,owner_user_id) VALUES($1,'One',$2),($3,'Other',$4)", p, ids[0], other, ids[3])
	exec("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'Developer'),($1,$3,'Viewer')", p, ids[1], ids[2])
	call := func(actor int, path, method, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := authRequest(s, method, "/api/projects/"+path, body).WithContext(ctx)
		r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: sessions[actor]})
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	definition := `{"version":1,"kind":"traces","live":false,"time":{"mode":"relative","range":"1h","from":"","to":""},"filters":{"service":"private-search","search":"sensitive body","errorsOnly":true,"minSeverity":0,"traceId":"","limit":50},"display":{"headers":false,"follow":false,"autoExpand":false}}`
	payload := `{"name":"Shared","definition":` + definition + `}`
	for _, actor := range []int{2, 3} {
		want := 403
		if actor == 3 {
			want = 404
		}
		if w := call(actor, p+"/views", "POST", payload); w.Code != want {
			t.Fatal("unauthorized create", actor, w.Code)
		}
	}
	w := call(1, p+"/views", "POST", payload)
	var created struct {
		ID       string
		Revision string
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &created) != nil || created.ID == "" || created.Revision != "1" {
		t.Fatal("create", w.Code)
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal("migration changed existing saved data", err)
	}
	for _, actor := range []int{0, 1, 2} {
		if w := call(actor, p+"/views/"+created.ID, "GET", ""); w.Code != 200 {
			t.Fatal("read", actor, w.Code)
		}
	}
	if w := call(3, other+"/views/"+created.ID, "GET", ""); w.Code != 404 {
		t.Fatal("cross-project ID", w.Code)
	}
	malformed := []string{strings.Replace(payload, `"version":1`, `"version":2`, 1), strings.Replace(payload, `"search":"sensitive body"`, `"sql":"DROP TABLE projects"`, 1), strings.Replace(payload, `"range":"1h"`, `"range":"100h"`, 1), strings.Replace(payload, `"limit":50`, `"limit":101`, 1)}
	for _, body := range malformed {
		if w := call(0, p+"/views", "POST", body); w.Code != 400 {
			t.Fatal("invalid definition", w.Code)
		}
	}
	update := `{"name":"Updated","definition":` + definition + `,"revision":"1"}`
	if w := call(0, p+"/views/"+created.ID, "PATCH", update); w.Code != 200 {
		t.Fatal("update", w.Code)
	}
	if w := call(0, p+"/views/"+created.ID, "PATCH", update); w.Code != 409 {
		t.Fatal("stale update", w.Code)
	}
	if w := call(0, p+"/views/"+created.ID, "DELETE", `{"revision":"1"}`); w.Code != 409 {
		t.Fatal("stale delete", w.Code)
	}
	exec("INSERT INTO project_events(project_id,actor_user_id,action,target) SELECT $1::uuid,$2::uuid,'patch',$1::text FROM generate_series(1,104)", p, ids[0])
	exec("INSERT INTO project_events(id,project_id,actor_user_id,action,target) OVERRIDING SYSTEM VALUE VALUES(9007199254740993,$1::uuid,$2::uuid,'patch',$1::text)", p, ids[0])
	for _, actor := range []int{1, 2, 3} {
		want := 403
		if actor == 3 {
			want = 404
		}
		if w := call(actor, p+"/events", "GET", ""); w.Code != want {
			t.Fatal("audit read", actor, w.Code)
		}
	}
	var first struct {
		Items []projectEvent `json:"items"`
		Next  string         `json:"nextCursor"`
		From  string
		To    string
	}
	w = call(0, p+"/events", "GET", "")
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &first) != nil || len(first.Items) != 100 || first.Next == "" || first.Items[0].ID != "9007199254740993" {
		t.Fatal("first audit page", w.Code, len(first.Items))
	}
	if strings.Contains(w.Body.String(), "sensitive body") || strings.Contains(w.Body.String(), "private-search") {
		t.Fatal("search leaked into audit")
	}
	exec("INSERT INTO project_events(id,project_id,actor_user_id,action,target) OVERRIDING SYSTEM VALUE VALUES(9007199254740994,$1::uuid,$2::uuid,'patch',$1::text)", p, ids[0])
	w = call(0, p+"/events?cursor="+first.Next, "GET", "")
	var second struct{ Items []projectEvent }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &second) != nil || len(second.Items) != 7 {
		t.Fatal("second page", w.Code, len(second.Items))
	}
	for _, e := range second.Items {
		if e.ID == "9007199254740994" || e.ID == first.Items[99].ID {
			t.Fatal("pagination duplicate/new insertion")
		}
	}
	if w := call(3, other+"/events?cursor="+first.Next, "GET", ""); w.Code != 400 {
		t.Fatal("cursor project binding", w.Code)
	}
	for _, q := range []string{"cursor=bad", "action=arbitrary", "from=no&to=no", "from=" + time.Now().Add(-31*24*time.Hour).UTC().Format(time.RFC3339) + "&to=" + time.Now().UTC().Format(time.RFC3339)} {
		if w := call(0, p+"/events?"+q, "GET", ""); w.Code != 400 {
			t.Fatal("audit filter", q, w.Code)
		}
	}
	exec("INSERT INTO project_events(project_id,actor_user_id,action,target) VALUES($1,$2,'operator_account_recovery',$3)", p, ids[0], ids[0])
	w = call(0, p+"/events?action=operator_account_recovery&from="+time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)+"&to="+time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "GET", "")
	var operators struct{ Items []projectEvent }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &operators) != nil || len(operators.Items) != 1 || operators.Items[0].ActorID != nil || operators.Items[0].ActorKind != "operator" {
		t.Fatalf("operator event attribution: status=%d items=%+v", w.Code, operators.Items)
	}
	exec("ALTER TABLE project_events ADD CONSTRAINT workflow_audit_failure CHECK(action != 'create_view') NOT VALID")
	if w := call(0, p+"/views", "POST", payload); w.Code != 503 {
		t.Fatal("audit failure", w.Code)
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM project_views WHERE project_id=$1", p).Scan(&count); err != nil || count != 1 {
		t.Fatal("view/audit not atomic", err, count)
	}
	exec("ALTER TABLE project_events DROP CONSTRAINT workflow_audit_failure")
	if w := call(0, p+"/views/"+created.ID, "DELETE", `{"revision":"2"}`); w.Code != 200 {
		t.Fatal("delete", w.Code)
	}
	exec("INSERT INTO project_views(id,project_id,name,definition,creator_user_id,updater_user_id) SELECT gen_random_uuid(),$1,'Quota',$2,$3,$3 FROM generate_series(1,100)", p, []byte(definition), ids[0])
	if w := call(0, p+"/views", "POST", payload); w.Code != 409 {
		t.Fatal("saved view quota not enforced", w.Code)
	}
	if w := call(0, p+"/owner", "POST", `{"userId":"`+ids[1]+`"}`); w.Code != 200 {
		t.Fatal("ownership transfer", w.Code)
	}
	if w := call(0, p+"/events", "GET", ""); w.Code != 403 {
		t.Fatal("previous Owner retained audit access", w.Code)
	}
	if w := call(1, p+"/events", "GET", ""); w.Code != 200 {
		t.Fatal("new Owner denied audit access", w.Code)
	}
	exec("INSERT INTO project_events(project_id,actor_user_id,action,target) SELECT $1::uuid,$2::uuid,'patch',$1::text FROM generate_series(1,10000)", other, ids[3])
	exec("ANALYZE project_events")
	planRows, err := pool.Query(ctx, "EXPLAIN SELECT id FROM project_events WHERE project_id=$1 ORDER BY id DESC LIMIT 101", p)
	if err != nil {
		t.Fatal(err)
	}
	var queryPlan strings.Builder
	for planRows.Next() {
		var line string
		if planRows.Scan(&line) != nil {
			t.Fatal("cannot read audit query plan")
		}
		queryPlan.WriteString(line)
	}
	planRows.Close()
	if !strings.Contains(queryPlan.String(), "project_events_page") {
		t.Fatal("audit pagination did not use its project-scoped index", queryPlan.String())
	}
	// Older readers keep the unchanged authentication-v2 readiness contract.
	var version int
	if pool.QueryRow(ctx, "SELECT max(version) FROM auth_schema_versions").Scan(&version) != nil || version != 2 {
		t.Fatal("legacy auth schema contract changed")
	}
}

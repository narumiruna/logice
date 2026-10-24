//go:build integration

package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestAlertManagementBoundaries(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
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
	for n, id := range ids {
		exec("INSERT INTO auth_users(id,name,active,admin) VALUES($1,'Actor',true,$2)", id, n == 3)
		exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(sessions[n]), id)
	}
	project, other, dest, foreign := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec("INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Project',$2),($3,'Other',$4)", project, ids[0], other, ids[3])
	exec("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'Developer'),($1,$3,'Viewer')", project, ids[1], ids[2])
	secretURL := "https://example.com/private/destination-secret"
	exec("INSERT INTO alert_destinations(id,project_id,name,encrypted_url) VALUES($1,$2,'Receiver',$3),($4,$5,'Other receiver',$6)", dest, project, s.alertCrypto.Seal(secretURL, project, dest), foreign, other, s.alertCrypto.Seal(secretURL, other, foreign))
	call := func(actor int, path, method, body string) *httptest.ResponseRecorder {
		r := authRequest(s, method, "/api/projects/"+path, body).WithContext(ctx)
		r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: sessions[actor]})
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	for n := 0; n < 3; n++ {
		w := call(n, project+"/alerts/destinations", "GET", "")
		if w.Code != 200 || strings.Contains(w.Body.String(), "destination-secret") || strings.Contains(w.Body.String(), "encrypted_url") {
			t.Fatal("destination metadata", n, w.Code)
		}
	}
	if w := call(3, project+"/alerts/rules", "GET", ""); w.Code != 404 {
		t.Fatal("platform admin override", w.Code)
	}
	if w := call(1, project+"/alerts/destinations", "POST", `{"name":"Denied","url":"https://127.0.0.1/"}`); w.Code != 403 {
		t.Fatal("developer destination mutation", w.Code)
	}
	if w := call(0, project+"/alerts/destinations", "POST", `{"name":"Unsafe","url":"https://127.0.0.1/"}`); w.Code != 400 {
		t.Fatal("private HTTPS endpoint accepted", w.Code)
	}
	payload := `{"name":"Errors","kind":"error_ratio","service":"","threshold":"0.1","minPopulation":10,"enabled":true,"destinationId":"` + dest + `"}`
	if w := call(2, project+"/alerts/rules", "POST", payload); w.Code != 403 {
		t.Fatal("Viewer rule creation", w.Code)
	}
	if w := call(1, project+"/alerts/rules", "POST", strings.Replace(payload, dest, foreign, 1)); w.Code != 400 {
		t.Fatal("foreign destination", w.Code)
	}
	w := call(1, project+"/alerts/rules", "POST", payload)
	var made struct{ ID string }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &made) != nil || made.ID == "" {
		t.Fatal("Developer create rule", w.Code)
	}
	exec("UPDATE alert_rules SET state='resolved',last_window_to=now()-interval '10 minutes' WHERE id=$1", made.ID)
	stale := call(2, project+"/alerts/rules", "GET", "")
	if stale.Code != 200 || !strings.Contains(stale.Body.String(), `"state":"unknown"`) {
		t.Fatal("stale rule state appeared healthy", stale.Code)
	}
	update := strings.TrimSuffix(payload, "}") + `,"revision":"1"}`
	if w := call(0, project+"/alerts/rules/"+made.ID, "PATCH", update); w.Code != 200 {
		t.Fatal("rule edit", w.Code)
	}
	if w := call(0, project+"/alerts/rules/"+made.ID, "PATCH", update); w.Code != 409 {
		t.Fatal("stale rule edit", w.Code)
	}
	if w := call(2, project+"/alerts/destinations/"+dest+"/test", "POST", `{}`); w.Code != 403 {
		t.Fatal("Viewer queued notification", w.Code)
	}
	if w := call(0, project+"/alerts/destinations/"+dest+"/test", "POST", `{}`); w.Code != 202 {
		t.Fatal("test notification acceptance", w.Code)
	}
	exec("INSERT INTO alert_deliveries(id,project_id,destination_id,payload) SELECT gen_random_uuid(),$1,$2,'{}' FROM generate_series(1,999)", other, foreign)
	if w := call(0, project+"/alerts/destinations/"+dest+"/test", "POST", `{}`); w.Code != 409 {
		t.Fatal("global outbox quota", w.Code)
	}
	exec("DELETE FROM alert_deliveries WHERE project_id=$1", other)
	exec("INSERT INTO alert_deliveries(id,project_id,destination_id,payload) SELECT gen_random_uuid(),$1,$2,'{}' FROM generate_series(1,99)", project, dest)
	if w := call(0, project+"/alerts/destinations/"+dest+"/test", "POST", `{}`); w.Code != 409 {
		t.Fatal("project outbox quota", w.Code)
	}
	if w := call(0, project+"/alerts/destinations/"+dest, "DELETE", `{"revision":"1"}`); w.Code != 200 {
		t.Fatal("disable destination", w.Code)
	}
	var enabled bool
	if pool.QueryRow(ctx, "SELECT enabled FROM alert_rules WHERE id=$1", made.ID).Scan(&enabled) != nil || enabled {
		t.Fatal("disabling destination retained enabled rule")
	}
	var pending int
	if pool.QueryRow(ctx, "SELECT count(*) FROM alert_deliveries WHERE project_id=$1 AND state='pending'", project).Scan(&pending) != nil || pending != 0 {
		t.Fatal("destination left pending notifications")
	}
}

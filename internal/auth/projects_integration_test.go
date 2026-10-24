//go:build integration

package auth

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestProjectAccessAndTokenLifecycle(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	users := map[string]string{}
	sessions := map[string]string{}
	for _, role := range []string{"owner", "developer", "viewer", "outsider", "admin"} {
		id := uuid.NewString()
		users[role] = id
		sessions[role] = token()
		exec("INSERT INTO auth_users(id,name,active,admin) VALUES($1,$2,true,$3)", id, role, role == "admin")
		exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(sessions[role]), id)
	}
	call := func(role, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		r := authRequest(s, method, path, body).WithContext(ctx)
		if role != "" {
			r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: sessions[role]})
		}
		w := httptest.NewRecorder()
		s.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { response(w, 200, map[string]string{"status": "query"}) })).ServeHTTP(w, r)
		return w
	}
	check := func(w *httptest.ResponseRecorder, status int) {
		t.Helper()
		if w.Code != status {
			t.Fatalf("status %d want %d: %s", w.Code, status, w.Body.String())
		}
	}
	decodeProject := func(w *httptest.ResponseRecorder) Project {
		t.Helper()
		check(w, 201)
		var p Project
		if json.Unmarshal(w.Body.Bytes(), &p) != nil {
			t.Fatal("invalid project")
		}
		return p
	}
	p := decodeProject(call("owner", "POST", "/api/projects", `{"name":"Primary"}`))
	base := "/api/projects/" + p.ID
	foreign := decodeProject(call("outsider", "POST", "/api/projects", `{"name":"Foreign"}`))
	for _, role := range []string{"outsider", "admin"} {
		check(call(role, "GET", base, ""), 404)
		check(call(role, "GET", base+"/traces", ""), 404)
	}
	check(call("", "GET", base, ""), 401)
	for _, role := range []string{"developer", "viewer"} {
		payload, _ := json.Marshal(map[string]string{"userId": users[role], "role": map[string]string{"developer": "Developer", "viewer": "Viewer"}[role]})
		check(call("owner", "POST", base+"/members", string(payload)), 200)
	}
	for _, role := range []string{"owner", "developer", "viewer"} {
		check(call(role, "GET", base+"/traces", ""), 200)
		check(call(role, "GET", base+"/logs", ""), 200)
		check(call(role, "GET", base+"/live", ""), 200)
		check(call(role, "GET", base+"/members", ""), 200)
	}
	check(call("viewer", "GET", base+"/tokens", ""), 403)
	check(call("viewer", "POST", base+"/tokens", `{"name":"denied"}`), 403)
	check(call("developer", "PATCH", base, `{"name":"denied"}`), 403)
	check(call("developer", "POST", base+"/members", `{}`), 403)
	check(call("owner", "DELETE", base+"/members/"+users["owner"], `{}`), 400)
	check(call("owner", "PATCH", base+"/members/"+users["viewer"], `{"role":"Owner"}`), 400)
	check(call("owner", "POST", base+"/members", `{"userId":"`+uuid.NewString()+`","role":"Viewer"}`), 400)
	check(call("owner", "GET", base+"/tokens?offset=-1", ""), 400)
	check(call("owner", "GET", base+"/members?offset=1&offset=2", ""), 400)
	check(call("owner", "GET", "/api/projects/not-uuid", ""), 404)
	check(call("owner", "GET", "/api/traces", ""), 404)
	check(call("owner", "POST", base+"/tokens", `{"name":"bad","expiresAt":"2000-01-01T00:00:00Z"}`), 400)
	// A real upstream sees only trusted metadata and the infrastructure credential.
	var seen int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen++
		if r.Header.Get("Authorization") != "Bearer internal-test" || len(r.Header.Values("X-Logice-Project-Id")) != 1 || r.Header.Get("X-Logice-Project-Id") != p.ID || r.Header.Get("X-Forwarded-For") != "" {
			t.Error("untrusted upstream metadata")
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != "fixture" {
			t.Error("payload changed")
		}
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(202)
		_, _ = w.Write([]byte("partial-success"))
	}))
	defer upstream.Close()
	if err := s.ConfigureIngestion(upstream.URL, "internal-test"); err != nil {
		t.Fatal(err)
	}
	tokenResponse := call("developer", "POST", base+"/tokens", `{"name":"application"}`)
	check(tokenResponse, 201)
	var created ProjectToken
	if json.Unmarshal(tokenResponse.Body.Bytes(), &created) != nil || !validToken(created.Token) {
		t.Fatal("invalid token")
	}
	if w := call("owner", "GET", base+"/tokens", ""); strings.Contains(w.Body.String(), created.Token) || strings.Contains(w.Body.String(), "token_hash") {
		t.Fatal("secret in list")
	}
	ingest := func(raw string, extra func(*http.Request)) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/v1/traces", strings.NewReader("fixture")).WithContext(ctx)
		r.Header.Set("Content-Type", "application/x-protobuf")
		r.Header.Set("Authorization", "Bearer "+raw)
		r.Header.Add("X-Logice-Project-Id", foreign.ID)
		r.Header.Add("x-logice-project-id", "forged")
		r.Header.Set("X-Forwarded-For", "forged")
		if extra != nil {
			extra(r)
		}
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	w := ingest(created.Token, nil)
	check(w, 202)
	if w.Body.String() != "partial-success" {
		t.Fatal("upstream body changed")
	}
	check(ingest(token(), nil), 401)
	check(ingest(created.Token, func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+token()) }), 401)
	check(ingest(created.Token, func(r *http.Request) { r.ContentLength = ingestionBodyLimit + 1 }), 413)
	check(ingest(created.Token, func(r *http.Request) {
		r.Body = io.NopCloser(bytes.NewReader(make([]byte, ingestionBodyLimit+1)))
		r.ContentLength = -1
	}), 413)
	check(ingest(created.Token, func(r *http.Request) { r.Header.Set("Content-Encoding", "br") }), 415)
	// Application credentials cannot query or manage projects without a session.
	r := authRequest(s, "GET", base, "")
	r.Header.Set("Authorization", "Bearer "+created.Token)
	w = httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	check(w, 401)
	check(call("owner", "DELETE", base+"/members/"+users["developer"], `{}`), 200)
	check(call("developer", "GET", base+"/traces", ""), 404)
	check(ingest(created.Token, nil), 202)
	check(call("owner", "POST", "/api/projects/"+foreign.ID+"/tokens/"+created.ID+"/revoke", `{}`), 404)
	check(call("outsider", "POST", "/api/projects/"+foreign.ID+"/tokens/"+created.ID+"/revoke", `{}`), 404)
	check(call("owner", "POST", base+"/tokens/"+created.ID+"/revoke", `{}`), 200)
	check(call("owner", "POST", base+"/tokens/"+created.ID+"/revoke", `{}`), 200)
	check(ingest(created.Token, nil), 401)
	exec("UPDATE project_tokens SET revoked_at=NULL,expires_at=now()-interval '1 second' WHERE id=$1", created.ID)
	check(ingest(created.Token, nil), 401)
	exec("UPDATE project_tokens SET expires_at=NULL WHERE id=$1", created.ID)
	// CSRF and method checks apply to all project mutations.
	r = authRequest(s, "PATCH", base, `{"name":"bad"}`)
	r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: sessions["owner"]})
	r.Header.Del("Origin")
	w = httptest.NewRecorder()
	s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
	check(w, 403)
	// Transfer is atomic; concurrent transfers from the former Owner cannot both win.
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Go(func() { statuses <- call("owner", "POST", base+"/owner", `{"userId":"`+users["viewer"]+`"}`).Code })
	}
	wg.Wait()
	close(statuses)
	success := 0
	for code := range statuses {
		if code == 200 {
			success++
		} else if code != 403 {
			t.Errorf("transfer status %d", code)
		}
	}
	if success != 1 {
		t.Fatal("transfer not serialized")
	}
	check(call("owner", "GET", base+"/tokens", ""), 200)
	check(call("owner", "DELETE", base, `{}`), 403)
	check(call("viewer", "DELETE", base, `{}`), 200)
	check(ingest(created.Token, nil), 401)
	check(call("viewer", "GET", base, ""), 404)
	var events int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM project_events WHERE project_id=$1", p.ID).Scan(&events); err != nil || events < 8 {
		t.Fatal("missing audit events", err)
	}
	if seen != 2 {
		t.Fatalf("rejected requests reached upstream: %d", seen)
	}
	// Operator recovery preserves the Owner UUID and project ownership.
	recoveredProject := decodeProject(call("owner", "POST", "/api/projects", `{"name":"Recovery"}`))
	recoveredBase := "/api/projects/" + recoveredProject.ID
	recoveredTokenResponse := call("owner", "POST", recoveredBase+"/tokens", `{"name":"recovery-token"}`)
	check(recoveredTokenResponse, 201)
	var recoveredToken ProjectToken
	if json.Unmarshal(recoveredTokenResponse.Body.Bytes(), &recoveredToken) != nil {
		t.Fatal("decode recovery token")
	}
	if _, err := Recover(ctx, pool, users["owner"]); err != nil {
		t.Fatal(err)
	}
	check(call("owner", "GET", recoveredBase, ""), 401)
	// The authentication suite checks enrollment. This fixture resumes the same UUID
	// after enrollment to test project ownership and revocation independently.
	exec("UPDATE auth_users SET active=true WHERE id=$1", users["owner"])
	sessions["owner"] = token()
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(sessions["owner"]), users["owner"])
	check(call("owner", "GET", recoveredBase, ""), 200)
	check(call("owner", "POST", recoveredBase+"/tokens/"+recoveredToken.ID+"/revoke", `{}`), 200)
	var recoveryEvents int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM project_events WHERE project_id=$1 AND action='operator_account_recovery'", recoveredProject.ID).Scan(&recoveryEvents); err != nil || recoveryEvents != 1 {
		t.Fatal("missing project recovery event", err)
	}
	// Readiness must reject an old schema even when its other tables exist.
	exec("DELETE FROM auth_schema_versions WHERE version=2")
	if Ready(ctx, pool) == nil {
		t.Fatal("old schema ready")
	}
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	pool.Close()
	check(ingest(created.Token, nil), 503)
	check(call("owner", "GET", base, ""), 503)
}

func TestProjectCreationAndTokenQuotas(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	user := uuid.NewString()
	session := token()
	for _, statement := range []struct {
		sql  string
		args []any
	}{{"INSERT INTO auth_users(id,name,active) VALUES($1,'Quota',true)", []any{user}}, {"INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", []any{digest(session), user}}} {
		if _, err := pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	call := func(path string) *httptest.ResponseRecorder {
		r := authRequest(s, "POST", path, `{"name":"quota"}`).WithContext(ctx)
		r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	for range 99 {
		if w := call("/api/projects"); w.Code != 201 {
			t.Fatal(w.Code)
		}
	}
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for range 2 {
		wg.Go(func() { codes <- call("/api/projects").Code })
	}
	wg.Wait()
	close(codes)
	success := 0
	for code := range codes {
		if code == 201 {
			success++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if success != 1 {
		t.Fatal("project quota race")
	}
	var id string
	if err := pool.QueryRow(ctx, "SELECT id::text FROM projects LIMIT 1").Scan(&id); err != nil {
		t.Fatal(err)
	}
	path := "/api/projects/" + id + "/tokens"
	for range 99 {
		if w := call(path); w.Code != 201 {
			t.Fatal(w.Code)
		}
	}
	codes = make(chan int, 2)
	for range 2 {
		wg.Go(func() { codes <- call(path).Code })
	}
	wg.Wait()
	close(codes)
	success = 0
	for code := range codes {
		if code == 201 {
			success++
		} else if code != 409 {
			t.Fatal(code)
		}
	}
	if success != 1 {
		t.Fatal("token quota race")
	}
}

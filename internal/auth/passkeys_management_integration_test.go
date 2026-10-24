//go:build integration

package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

func TestPasskeyMetadataAndAuthorization(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	user, other := uuid.NewString(), uuid.NewString()
	session := token()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO auth_users(id,name,active,admin) VALUES($1,'Owner',true,true),($2,'Other',true,false)", user, other)
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), user)
	credential := webauthn.Credential{ID: []byte("raw-credential-id-must-not-appear"), PublicKey: []byte("public-key-not-metadata")}
	raw, _ := json.Marshal(credential)
	id, otherID := uuid.NewString(), uuid.NewString()
	exec("INSERT INTO auth_credentials(id,user_id,data,management_id) VALUES($1,$2,$3,$4)", credential.ID, user, raw, id)
	exec("INSERT INTO auth_credentials(id,user_id,data,management_id) VALUES('other',$1,'{}',$2)", other, otherID)
	call := func(path, method, body string) *httptest.ResponseRecorder {
		r := authRequest(s, method, "/api/auth/passkeys"+path, body).WithContext(ctx)
		r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	w := call("", "GET", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), id) || strings.Contains(w.Body.String(), "public-key") || strings.Contains(w.Body.String(), "credential-id") || strings.Contains(w.Body.String(), otherID) || !strings.Contains(w.Body.String(), `"createdAt":null`) {
		t.Fatal("metadata boundary", w.Code)
	}
	if w := call("/rename", "POST", `{"id":"`+otherID+`","name":"denied"}`); w.Code != 404 {
		t.Fatal("renamed another user's key", w.Code)
	}
	if w := call("/rename", "POST", `{"id":"`+id+`","name":"Backup"}`); w.Code != 200 {
		t.Fatal("rename", w.Code)
	}
	if w := call("/authorize/begin", "POST", `{"operation":"remove","target":"`+id+`"}`); w.Code != 409 {
		t.Fatal("last credential removal begin", w.Code)
	}
	for _, body := range []string{`{"operation":"add","name":"x","userId":"` + other + `"}`, `{"operation":"remove","target":"bad"}`, `{"operation":"unsupported"}`} {
		if w := call("/authorize/begin", "POST", body); w.Code != 400 {
			t.Fatal("invalid management request", w.Code)
		}
	}
	for _, path := range []string{"/authorize/finish", "/add/finish"} {
		if w := call(path, "POST", `{}`); w.Code != 401 {
			t.Fatal("proofless operation accepted", path, w.Code)
		}
	}
	// A saturated credential quota is enforced before any registration options are issued.
	for n := 1; n < 8; n++ {
		exec("INSERT INTO auth_credentials(id,user_id,data) VALUES($1,$2,$3)", []byte(uuid.NewString()), user, raw)
	}
	if w := call("/authorize/begin", "POST", `{"operation":"add","name":"Ninth"}`); w.Code != 409 {
		t.Fatal("credential quota", w.Code)
	}
	var audits int
	if pool.QueryRow(ctx, "SELECT count(*) FROM auth_events WHERE user_id=$1 AND action='passkey_renamed'", user).Scan(&audits) != nil || audits != 1 {
		t.Fatal("rename audit")
	}
}

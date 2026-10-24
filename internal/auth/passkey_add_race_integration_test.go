//go:build integration

package auth

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

func registrationProof(t *testing.T, id, public []byte, challenge string) string {
	t.Helper()
	client, _ := json.Marshal(map[string]any{"type": "webauthn.create", "challenge": challenge, "origin": "https://example.test", "crossOrigin": false})
	rp := sha256.Sum256([]byte("example.test"))
	data := append([]byte{}, rp[:]...)
	data = append(data, 0x45) // User presence, user verification, attested credential data.
	data = append(data, make([]byte, 4+16)...)
	length := make([]byte, 2)
	binary.BigEndian.PutUint16(length, uint16(len(id)))
	data = append(data, length...)
	data = append(data, id...)
	data = append(data, public...)
	attestation, err := cbor.Marshal(map[string]any{"fmt": "none", "authData": data, "attStmt": map[string]any{}})
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	payload, _ := json.Marshal(map[string]any{"id": encode(id), "rawId": encode(id), "type": "public-key", "response": map[string]any{"clientDataJSON": encode(client), "attestationObject": encode(attestation)}, "clientExtensionResults": map[string]any{}})
	return string(payload)
}

func TestVerifiedRegistrationRemovalRace(t *testing.T) {
	for _, order := range []string{"registration_first", "removal_first", "concurrent", "duplicate", "audit_failure", "recovery"} {
		t.Run(order, func(t *testing.T) { verifiedRegistrationRemoval(t, order) })
	}
}

func verifiedRegistrationRemoval(t *testing.T, order string) {
	t.Helper()
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	user, session := uuid.NewString(), token()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO auth_users(id,name,active) VALUES($1,'Registration race',true)", user)
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), user)
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: private.X.FillBytes(make([]byte, 32)), -3: private.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	rawID, target := []byte(uuid.NewString()), uuid.NewString()
	for _, id := range [][]byte{rawID, []byte(uuid.NewString())} {
		credential, _ := json.Marshal(webauthn.Credential{ID: id, PublicKey: public, AttestationType: "none"})
		exec("INSERT INTO auth_credentials(id,user_id,data,management_id) VALUES($1,$2,$3,$4)", id, user, credential, target)
		target = uuid.NewString()
	}
	var removeTarget string
	if pool.QueryRow(ctx, "SELECT management_id::text FROM auth_credentials WHERE user_id=$1 AND id<>$2", user, rawID).Scan(&removeTarget) != nil {
		t.Fatal("missing removal target")
	}
	challenge := func(w *httptest.ResponseRecorder) string {
		t.Helper()
		var v struct {
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		}
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &v) != nil || v.PublicKey.Challenge == "" {
			t.Fatal("missing WebAuthn challenge", w.Code)
		}
		return v.PublicKey.Challenge
	}
	finish := func(begin *http.Request, options *httptest.ResponseRecorder, path, payload string) *http.Request {
		r := httptest.NewRequest("POST", "/api/auth/passkeys/"+path, strings.NewReader(payload)).WithContext(ctx)
		r.Header = begin.Header.Clone()
		r.Header.Del("Cookie")
		cookies := map[string]*http.Cookie{}
		for _, cookie := range begin.Cookies() {
			cookies[cookie.Name] = cookie
		}
		for _, cookie := range options.Result().Cookies() {
			cookies[cookie.Name] = cookie
		}
		for _, cookie := range cookies {
			if cookie.MaxAge >= 0 {
				r.AddCookie(cookie)
			}
		}
		return r
	}
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
		return w
	}
	add := authRequest(s, "POST", "/api/auth/passkeys/authorize/begin", `{"operation":"add","name":"Backup"}`).WithContext(ctx)
	add.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
	options := serve(add)
	proof := managementProof(t, private, rawID, user, challenge(options), "https://example.test", "example.test", 0x05)
	assertion := finish(add, options, "authorize/finish", proof)
	registration := serve(assertion)
	newID := []byte(uuid.NewString())
	if order == "duplicate" {
		newID = rawID
	}
	register := finish(add, registration, "add/finish", registrationProof(t, newID, public, challenge(registration)))
	remove := authRequest(s, "POST", "/api/auth/passkeys/authorize/begin", `{"operation":"remove","target":"`+removeTarget+`"}`).WithContext(ctx)
	remove.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
	removeOptions := serve(remove)
	removeFinish := finish(remove, removeOptions, "authorize/finish", managementProof(t, private, rawID, user, challenge(removeOptions), "https://example.test", "example.test", 0x05, 2))
	results := make([]int, 2)
	if order == "recovery" {
		if _, err := Recover(ctx, pool, user); err != nil {
			t.Fatal(err)
		}
		if serve(register).Code != 401 || serve(removeFinish).Code != 401 {
			t.Fatal("recovery did not invalidate pending credential changes")
		}
		var count int
		if pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", user).Scan(&count) != nil || count != 0 {
			t.Fatal("a pending registration restored a recovered credential")
		}
		return
	}
	switch order {
	case "duplicate", "audit_failure":
		if order == "audit_failure" {
			exec("ALTER TABLE auth_events ADD CONSTRAINT registration_audit_failure CHECK(action <> 'passkey_added') NOT VALID")
		}
		results[0] = serve(register).Code
		if results[0] != 401 && results[0] != 503 {
			t.Fatal("duplicate or unaudited registration succeeded", results[0])
		}
		var count int
		if pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", user).Scan(&count) != nil || count != 2 {
			t.Fatal("failed registration changed credentials")
		}
		if _, err := sessionUser(ctx, pool, session); err != nil {
			t.Fatal("failed registration revoked the session")
		}
		results[1] = serve(removeFinish).Code
	case "registration_first":
		results[0], results[1] = serve(register).Code, serve(removeFinish).Code
		if results[0] != 200 {
			t.Fatal("verified registration failed before removal", results)
		}
	case "removal_first":
		results[1], results[0] = serve(removeFinish).Code, serve(register).Code
		if results[0] != 401 {
			t.Fatal("stale registration survived removal", results)
		}
	default:
		var wg sync.WaitGroup
		for i, r := range []*http.Request{register, removeFinish} {
			wg.Add(1)
			go func() { defer wg.Done(); results[i] = serve(r).Code }()
		}
		wg.Wait()
	}
	if (results[0] != 200 && results[0] != 401 && ((order != "duplicate" && order != "audit_failure") || results[0] != 503)) || results[1] != 200 {
		t.Fatal("unexpected registration/removal results", results)
	}
	var keys, adds, removals int
	if pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", user).Scan(&keys) != nil || pool.QueryRow(ctx, "SELECT count(*) FROM auth_events WHERE user_id=$1 AND action='passkey_added'", user).Scan(&adds) != nil || pool.QueryRow(ctx, "SELECT count(*) FROM auth_events WHERE user_id=$1 AND action='passkey_removed'", user).Scan(&removals) != nil {
		t.Fatal("cannot inspect committed race result")
	}
	if removals != 1 || keys != 1+adds || (results[0] == 200) != (adds == 1) {
		t.Fatal("registration/removal was not serialized atomically", keys, adds, removals)
	}
}

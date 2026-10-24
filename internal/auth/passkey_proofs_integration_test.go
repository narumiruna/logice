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
	"testing"

	"github.com/fxamacker/cbor/v2"
	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
)

func managementProof(t *testing.T, private *ecdsa.PrivateKey, id []byte, user, challenge, origin, rpID string, flags byte, counters ...uint32) string {
	t.Helper()
	client, _ := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": challenge, "origin": origin, "crossOrigin": false})
	rp := sha256.Sum256([]byte(rpID))
	data := append([]byte{}, rp[:]...)
	data = append(data, flags)
	counter := make([]byte, 4)
	value := uint32(1)
	if len(counters) > 0 {
		value = counters[0]
	}
	binary.BigEndian.PutUint32(counter, value)
	data = append(data, counter...)
	clientHash := sha256.Sum256(client)
	signed := append(append([]byte{}, data...), clientHash[:]...)
	hash := sha256.Sum256(signed)
	signature, err := ecdsa.SignASN1(rand.Reader, private, hash[:])
	if err != nil {
		t.Fatal(err)
	}
	encode := base64.RawURLEncoding.EncodeToString
	payload, _ := json.Marshal(map[string]any{"id": encode(id), "rawId": encode(id), "type": "public-key", "response": map[string]any{"clientDataJSON": encode(client), "authenticatorData": encode(data), "signature": encode(signature), "userHandle": encode([]byte(user))}, "clientExtensionResults": map[string]any{}})
	return string(payload)
}
func TestManagementProofBoundaries(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	user, session, secondSession := uuid.NewString(), token(), token()
	otherUser, otherSession := uuid.NewString(), token()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO auth_users(id,name,active) VALUES($1,'Proof actor',true)", user)
	exec("INSERT INTO auth_users(id,name,active) VALUES($1,'Other proof actor',true)", otherUser)
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(otherSession), otherUser)
	for _, v := range []string{session, secondSession} {
		exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(v), user)
	}
	private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	public, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: private.X.FillBytes(make([]byte, 32)), -3: private.Y.FillBytes(make([]byte, 32))})
	if err != nil {
		t.Fatal(err)
	}
	rawID := []byte(uuid.NewString())
	management := uuid.NewString()
	credential, _ := json.Marshal(webauthn.Credential{ID: rawID, PublicKey: public, AttestationType: "none"})
	exec("INSERT INTO auth_credentials(id,user_id,data,management_id) VALUES($1,$2,$3,$4)", rawID, user, credential, management)
	exec("INSERT INTO auth_credentials(id,user_id,data) VALUES($1,$2,$3)", []byte(uuid.NewString()), user, credential)
	for _, kind := range []string{"missing_uv", "wrong_origin", "wrong_rp", "wrong_challenge", "wrong_session", "wrong_account", "stale_account", "stale_browser", "expired", "audit_failure", "valid"} {
		t.Run(kind, func(t *testing.T) {
			begin := authRequest(s, "POST", "/api/auth/passkeys/authorize/begin", `{"operation":"remove","target":"`+management+`"}`).WithContext(ctx)
			begin.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
			w := httptest.NewRecorder()
			s.Wrap(http.NotFoundHandler()).ServeHTTP(w, begin)
			var options struct {
				PublicKey struct {
					Challenge string `json:"challenge"`
				} `json:"publicKey"`
			}
			if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &options) != nil {
				t.Fatal("begin", w.Code)
			}
			origin, rp, challenge, flags := "https://example.test", "example.test", options.PublicKey.Challenge, byte(0x05)
			switch kind {
			case "missing_uv":
				flags = 0x01
			case "wrong_origin":
				origin = "https://other.test"
			case "wrong_rp":
				rp = "other.test"
			case "wrong_challenge":
				challenge = token()
			case "stale_account":
				exec("UPDATE auth_users SET generation=generation+1 WHERE id=$1", user)
			case "stale_browser":
				exec("UPDATE auth_browsers SET generation=generation+1 WHERE token_hash=$1", digest(begin.Header.Get("X-CSRF-Token")))
			case "expired":
				exec("UPDATE auth_ceremonies SET expires_at=now()-interval '1 second'")
			case "audit_failure":
				exec("ALTER TABLE auth_events ADD CONSTRAINT management_audit_failure CHECK(action <> 'passkey_removed') NOT VALID")
			}
			payload := managementProof(t, private, rawID, user, challenge, origin, rp, flags)
			req := httptest.NewRequest("POST", "/api/auth/passkeys/authorize/finish", strings.NewReader(payload)).WithContext(ctx)
			req.Header = begin.Header.Clone()
			for _, cookie := range w.Result().Cookies() {
				req.AddCookie(cookie)
			}
			if kind == "wrong_session" || kind == "wrong_account" {
				cookies := req.Cookies()
				req.Header.Del("Cookie")
				for _, cookie := range cookies {
					if cookie.Name == s.cookieName("session") {
						cookie.Value = secondSession
						if kind == "wrong_account" {
							cookie.Value = otherSession
						}
					}
					req.AddCookie(cookie)
				}
			}
			result := httptest.NewRecorder()
			s.Wrap(http.NotFoundHandler()).ServeHTTP(result, req)
			expected := 401
			if kind == "valid" {
				expected = 200
			} else if kind == "audit_failure" {
				expected = 503
			}
			if result.Code != expected {
				t.Fatal("management proof result", result.Code, expected)
			}
			if kind == "audit_failure" {
				exec("ALTER TABLE auth_events DROP CONSTRAINT management_audit_failure")
				var count int
				if pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", user).Scan(&count) != nil || count != 2 {
					t.Fatal("audit failure removed a credential")
				}
				if _, err := sessionUser(ctx, pool, session); err != nil {
					t.Fatal("audit failure revoked the current session")
				}
			}
			if kind != "valid" {
				return
			}
			// A valid assertion cannot be replayed, even with the newly rotated session.
			replay := httptest.NewRequest("POST", "/api/auth/passkeys/authorize/finish", strings.NewReader(payload)).WithContext(ctx)
			replay.Header = begin.Header.Clone()
			for _, cookie := range w.Result().Cookies() {
				replay.AddCookie(cookie)
			}
			cookies := replay.Cookies()
			replay.Header.Del("Cookie")
			for _, cookie := range cookies {
				if cookie.Name != s.cookieName("session") {
					replay.AddCookie(cookie)
				}
			}
			for _, cookie := range result.Result().Cookies() {
				if cookie.Name == s.cookieName("session") {
					replay.AddCookie(cookie)
				}
			}
			again := httptest.NewRecorder()
			s.Wrap(http.NotFoundHandler()).ServeHTTP(again, replay)
			if again.Code != 401 {
				t.Fatal("management proof replay accepted", again.Code)
			}
		})
	}
}

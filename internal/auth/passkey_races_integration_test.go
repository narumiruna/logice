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

func TestConcurrentVerifiedPasskeyRemoval(t *testing.T) {
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
	exec("INSERT INTO auth_users(id,name,active) VALUES($1,'Verified actor',true)", user)
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), user)
	type device struct {
		private    *ecdsa.PrivateKey
		raw        []byte
		management string
	}
	devices := []device{}
	for n := 0; n < 2; n++ {
		private, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		key, err := cbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: private.X.FillBytes(make([]byte, 32)), -3: private.Y.FillBytes(make([]byte, 32))})
		if err != nil {
			t.Fatal(err)
		}
		id := []byte(uuid.NewString())
		metadata := uuid.NewString()
		credential := webauthn.Credential{ID: id, PublicKey: key, AttestationType: "none"}
		raw, _ := json.Marshal(credential)
		exec("INSERT INTO auth_credentials(id,user_id,data,management_id) VALUES($1,$2,$3,$4)", id, user, raw, metadata)
		devices = append(devices, device{private, id, metadata})
	}
	finish := []*http.Request{}
	for _, device := range devices {
		begin := authRequest(s, "POST", "/api/auth/passkeys/authorize/begin", `{"operation":"remove","target":"`+device.management+`"}`).WithContext(ctx)
		begin.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
		response := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(response, begin)
		var options struct {
			PublicKey struct {
				Challenge string `json:"challenge"`
			} `json:"publicKey"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &options) != nil {
			t.Fatal("begin removal", response.Code)
		}
		client, _ := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": options.PublicKey.Challenge, "origin": "https://example.test", "crossOrigin": false})
		rp := sha256.Sum256([]byte("example.test"))
		data := append([]byte{}, rp[:]...)
		data = append(data, 0x05)
		counter := make([]byte, 4)
		binary.BigEndian.PutUint32(counter, 1)
		data = append(data, counter...)
		clientHash := sha256.Sum256(client)
		signed := append(append([]byte{}, data...), clientHash[:]...)
		hash := sha256.Sum256(signed)
		signature, err := ecdsa.SignASN1(rand.Reader, device.private, hash[:])
		if err != nil {
			t.Fatal(err)
		}
		encode := base64.RawURLEncoding.EncodeToString
		payload, _ := json.Marshal(map[string]any{"id": encode(device.raw), "rawId": encode(device.raw), "type": "public-key", "response": map[string]any{"clientDataJSON": encode(client), "authenticatorData": encode(data), "signature": encode(signature), "userHandle": encode([]byte(user))}, "clientExtensionResults": map[string]any{}})
		request := httptest.NewRequest("POST", "/api/auth/passkeys/authorize/finish", strings.NewReader(string(payload))).WithContext(ctx)
		request.Header.Set("Origin", "https://example.test")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-CSRF-Token", begin.Header.Get("X-CSRF-Token"))
		for _, cookie := range begin.Cookies() {
			request.AddCookie(cookie)
		}
		for _, cookie := range response.Result().Cookies() {
			request.AddCookie(cookie)
		}
		finish = append(finish, request)
	}
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, request := range finish {
		wg.Add(1)
		go func(r *http.Request) {
			defer wg.Done()
			w := httptest.NewRecorder()
			s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
			statuses <- w.Code
		}(request)
	}
	wg.Wait()
	close(statuses)
	successes := 0
	for status := range statuses {
		if status == 200 {
			successes++
		} else if status != 401 && status != 409 {
			t.Fatal("unexpected removal result", status)
		}
	}
	var count int
	if pool.QueryRow(ctx, "SELECT count(*) FROM auth_credentials WHERE user_id=$1", user).Scan(&count) != nil || count != 1 || successes != 1 {
		t.Fatal("last-key race", successes, count)
	}
	if pool.QueryRow(ctx, "SELECT count(*) FROM auth_events WHERE user_id=$1 AND action='passkey_removed'", user).Scan(&count) != nil || count != 1 {
		t.Fatal("removal audit not atomic")
	}
	if _, err := sessionUser(ctx, pool, session); err == nil {
		t.Fatal("old account session retained access")
	}
}

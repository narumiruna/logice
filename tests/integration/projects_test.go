//go:build integration

package integration

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/narumiruna/logice/internal/auth"
	"github.com/narumiruna/logice/internal/httpapi"
	query "github.com/narumiruna/logice/internal/telemetry"
)

const fixtureProject = "11111111-1111-4111-8111-111111111111"
const fixtureUser = "22222222-2222-4222-8222-222222222222"

// setupProjects creates disposable application credentials through the real APIs.
func (s *stack) setupProjects() {
	config, err := pgxpool.ParseConfig(fmt.Sprintf("host=%s user=logice dbname=logice sslmode=disable", strings.Split(s.ports["postgres"], ":")[0]))
	s.must("configure project database", err)
	var port int
	_, err = fmt.Sscanf(strings.Split(s.ports["postgres"], ":")[1], "%d", &port)
	s.must("parse project database port", err)
	config.ConnConfig.Port = uint16(port)
	config.ConnConfig.Password = s.secrets[0]
	pool, err := pgxpool.NewWithConfig(s.ctx, config)
	s.must("open project database", err)
	s.t.Cleanup(pool.Close)
	s.must("migrate project database", auth.Migrate(s.ctx, pool))
	_, err = pool.Exec(s.ctx, "INSERT INTO auth_users(id,name,active) VALUES($1,'Integration owner',true)", fixtureUser)
	s.must("create project owner", err)
	rawBytes, err := hex.DecodeString(randomHex(s.t, 32))
	s.must("generate session", err)
	session := base64.RawURLEncoding.EncodeToString(rawBytes)
	hash := sha256.Sum256([]byte(session))
	_, err = pool.Exec(s.ctx, "INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", hash[:], fixtureUser)
	s.must("create project session", err)
	service, err := auth.New(auth.Config{Origin: "http://localhost:5173", EncryptionKey: s.secrets[3]}, pool)
	s.must("configure project authorization", err)
	s.must("configure ingestion proxy", service.ConfigureIngestion("http://"+s.ports["http"], s.secrets[2]))
	store, err := query.Open(s.ports["clickhouse"], s.secrets[1])
	s.must("open project store", err)
	s.t.Cleanup(func() { _ = store.Close() })
	server := httptest.NewServer(service.Wrap(httpapi.NewServer(store).Handler))
	s.t.Cleanup(server.Close)
	s.applicationURL = server.URL
	s.applicationSession = session
	// The stable UUID is an explicit fixture, not an application fallback.
	_, err = pool.Exec(s.ctx, "INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Integration project',$2)", fixtureProject, fixtureUser)
	s.must("create explicit fixture project", err)
	csrfReq, err := http.NewRequestWithContext(s.ctx, "GET", server.URL+"/api/auth/csrf", nil)
	s.must("create CSRF request", err)
	res, err := s.http.Do(csrfReq)
	s.must("get CSRF token", err)
	var csrf struct {
		Token string `json:"csrfToken"`
	}
	s.must("decode CSRF token", json.NewDecoder(res.Body).Decode(&csrf))
	_ = res.Body.Close()
	req, err := http.NewRequestWithContext(s.ctx, "POST", server.URL+"/api/projects/"+fixtureProject+"/tokens", strings.NewReader(`{"name":"integration"}`))
	s.must("create project token request", err)
	req.Header.Set("Origin", "http://localhost:5173")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-CSRF-Token", csrf.Token)
	for _, cookie := range res.Cookies() {
		req.AddCookie(cookie)
	}
	req.AddCookie(&http.Cookie{Name: "logice-dev-session", Value: session})
	res, err = s.http.Do(req)
	s.must("create project token", err)
	defer res.Body.Close()
	if res.StatusCode != 201 {
		s.t.Fatalf("create integration token status %d", res.StatusCode)
	}
	var created struct {
		Token string `json:"token"`
	}
	s.must("decode project token", json.NewDecoder(res.Body).Decode(&created))
	s.applicationToken = created.Token
	s.secrets = append(s.secrets, created.Token, session)
}

func scopedHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(w, r.WithContext(query.WithProject(r.Context(), fixtureProject)))
	})
}

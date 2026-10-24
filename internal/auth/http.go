package auth

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service owns the authentication boundary. Static web assets contain no user data.
type Service struct {
	settings  *settings
	pool      *pgxpool.Pool
	limits    limiter
	ingestion http.Handler
}

// New validates trusted origin and encryption settings. A nil database is never an auth bypass.
func New(c Config, pool *pgxpool.Pool) (*Service, error) {
	s, err := configure(c)
	if err != nil {
		return nil, err
	}
	return &Service{settings: s, pool: pool}, nil
}

func (s *Service) cookieName(kind string) string {
	if s.settings.secure {
		return "__Host-logice-" + kind
	}
	return "logice-dev-" + kind
}
func (s *Service) cookie(w http.ResponseWriter, kind, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: s.cookieName(kind), Value: value, Path: "/", Secure: s.settings.secure, HttpOnly: true, SameSite: http.SameSiteLaxMode, MaxAge: age})
}
func (s *Service) readCookie(r *http.Request, kind string) string {
	c, err := r.Cookie(s.cookieName(kind))
	if err != nil || !validToken(c.Value) {
		return ""
	}
	return c.Value
}
func (s *Service) csrf(w http.ResponseWriter, r *http.Request) string {
	raw := s.readCookie(r, "csrf")
	if raw == "" {
		raw = token()
		s.cookie(w, "csrf", raw, 7*24*60*60)
	}
	return raw
}
func response(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if body != nil {
		_ = json.NewEncoder(w).Encode(body)
	}
}
func failure(w http.ResponseWriter, status int, code, message string) {
	response(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}
func denied(w http.ResponseWriter) {
	failure(w, http.StatusUnauthorized, "unauthorized", "Authentication required or credentials invalid.")
}
func unavailable(w http.ResponseWriter) {
	failure(w, http.StatusServiceUnavailable, "auth_unavailable", "Authentication is unavailable. Try again later.")
}
func decode(r *http.Request, v any) error {
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(v); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return errors.New("unexpected request data")
	}
	return nil
}

// Wrap requires sessions and project access for application APIs, and separate
// project bearer tokens for OTLP. Liveness and authentication entry points are explicit exceptions.
// Neither forwarded headers nor Cloudflare identity headers confer authentication.
func (s *Service) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.URL.Path == "/v1/traces" || r.URL.Path == "/v1/logs" {
			if s.ingestion == nil {
				unavailable(w)
				return
			}
			s.ingestion.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api" {
			next.ServeHTTP(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		if strings.HasPrefix(r.URL.Path, "/api/auth/") {
			s.serve(w, r.WithContext(ctx))
			return
		}
		if s.pool == nil {
			unavailable(w)
			return
		}
		u, err := sessionUser(ctx, s.pool, s.readCookie(r, "session"))
		cancel()
		if errors.Is(err, errDenied) {
			denied(w)
			return
		}
		if err != nil {
			unavailable(w)
			return
		}
		// Query handlers own their deadlines. Preserve client cancellation, but
		// do not pass the authentication deadline into telemetry work.
		s.projectRoute(w, r, u, next)
	})
}

func (s *Service) serve(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path
	readOnly := path == "/api/auth/csrf" || path == "/api/auth/session"
	if (readOnly && r.Method != http.MethodGet) || (!readOnly && r.Method != http.MethodPost) {
		w.Header().Set("Allow", map[bool]string{true: "GET", false: "POST"}[readOnly])
		failure(w, 405, "method_not_allowed", "Method not allowed.")
		return
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		failure(w, 403, "csrf_failed", "Request origin is not allowed.")
		return
	}
	if !readOnly {
		csrf := s.readCookie(r, "csrf")
		if r.Header.Get("Origin") != s.settings.origin || csrf == "" || subtle.ConstantTimeCompare([]byte(csrf), []byte(r.Header.Get("X-CSRF-Token"))) != 1 {
			failure(w, 403, "csrf_failed", "Request origin or CSRF token is invalid.")
			return
		}
		mediaType, _, mediaErr := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if mediaErr != nil || mediaType != "application/json" {
			failure(w, 415, "invalid_content_type", "JSON is required.")
			return
		}
		// Browsers behind Nginx/cloudflared share a socket peer. Do not trust
		// forwarded IP headers or let one browser consume every peer's quota.
		// Logout must remain available even when the ceremony budget is exhausted.
		if path != "/api/auth/logout" && !s.limits.allow(csrf, time.Now()) {
			w.Header().Set("Retry-After", "60")
			failure(w, 429, "rate_limited", "Too many authentication requests. Try again later.")
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	}
	if path == "/api/auth/csrf" {
		response(w, 200, map[string]string{"csrfToken": s.csrf(w, r)})
		return
	}
	if s.pool == nil {
		unavailable(w)
		return
	}
	if !readOnly {
		version, err := browserVersion(r.Context(), s.pool, s.readCookie(r, "csrf"))
		if err != nil {
			unavailable(w)
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), browserVersionKey{}, version))
	}
	switch path {
	case "/api/auth/session":
		u, err := sessionUser(r.Context(), s.pool, s.readCookie(r, "session"))
		if errors.Is(err, errDenied) {
			denied(w)
			return
		}
		if err != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]any{"user": u, "csrfToken": s.csrf(w, r)})
	case "/api/auth/logout":
		if err := logout(r.Context(), s.pool, s.readCookie(r, "csrf"), s.readCookie(r, "session")); err != nil {
			unavailable(w)
			return
		}
		s.cookie(w, "session", "", -1)
		s.cookie(w, "ceremony", "", -1)
		w.WriteHeader(204)
	case "/api/auth/invitations":
		s.invitation(w, r)
	case "/api/auth/enroll/begin":
		s.beginEnrollment(w, r)
	case "/api/auth/enroll/finish":
		s.finishEnrollment(w, r)
	case "/api/auth/login/begin":
		s.beginLogin(w, r)
	case "/api/auth/login/finish":
		s.finishLogin(w, r)
	default:
		failure(w, 404, "not_found", "Route not found.")
	}
}

type browserVersionKey struct{}

type ceremony struct {
	BrowserVersion int64                `json:"browserVersion"`
	Session        webauthn.SessionData `json:"session"`
	UserID         string               `json:"userId,omitempty"`
	Generation     int64                `json:"generation,omitempty"`
	Invitation     []byte               `json:"invitation,omitempty"` // hash only, not the raw invitation
}

func (s *Service) saveCeremony(w http.ResponseWriter, r *http.Request, kind string, state ceremony) error {
	raw := token()
	state.BrowserVersion, _ = r.Context().Value(browserVersionKey{}).(int64)
	data, err := json.Marshal(state)
	if err != nil {
		return err
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		return err
	}
	defer rollback(tx)
	var version int64
	if err = tx.QueryRow(r.Context(), "SELECT generation FROM auth_browsers WHERE token_hash=$1 FOR UPDATE", digest(s.readCookie(r, "csrf"))).Scan(&version); err != nil {
		return err
	}
	if version != state.BrowserVersion {
		return errDenied
	}
	// Beginning a new ceremony invalidates the previous ceremony in this browser.
	if previous := s.readCookie(r, "ceremony"); previous != "" {
		if _, err = tx.Exec(r.Context(), "DELETE FROM auth_ceremonies WHERE token_hash=$1", digest(previous)); err != nil {
			return err
		}
	}
	_, err = tx.Exec(r.Context(), "INSERT INTO auth_ceremonies(token_hash,kind,csrf_hash,data) VALUES($1,$2,$3,$4)", digest(raw), kind, digest(s.readCookie(r, "csrf")), s.settings.seal(data, kind+":"+raw))
	if err != nil {
		return err
	}
	if err = tx.Commit(r.Context()); err != nil {
		return err
	}
	s.cookie(w, "ceremony", raw, 300)
	return nil
}
func (s *Service) consume(w http.ResponseWriter, r *http.Request, kind string) (*ceremony, error) {
	raw := s.readCookie(r, "ceremony")
	if raw == "" {
		return nil, errDenied
	}
	s.cookie(w, "ceremony", "", -1)
	var encrypted []byte
	err := s.pool.QueryRow(r.Context(), `DELETE FROM auth_ceremonies
 WHERE token_hash=$1 AND kind=$2 AND csrf_hash=$3 AND expires_at>now() RETURNING data`, digest(raw), kind, digest(s.readCookie(r, "csrf"))).Scan(&encrypted)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errDenied
	}
	if err != nil {
		return nil, err
	}
	data, err := s.settings.open(encrypted, kind+":"+raw)
	if err != nil {
		return nil, errDenied
	}
	var state ceremony
	if json.Unmarshal(data, &state) != nil {
		return nil, errDenied
	}
	return &state, nil
}
func (s *Service) ceremonyError(w http.ResponseWriter, err error) {
	if errors.Is(err, errDenied) {
		denied(w)
	} else {
		unavailable(w)
	}
}

func (s *Service) invitation(w http.ResponseWriter, r *http.Request) {
	actor, err := sessionUser(r.Context(), s.pool, s.readCookie(r, "session"))
	if errors.Is(err, errDenied) {
		denied(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	if !actor.Admin {
		failure(w, 403, "forbidden", "Administrator access required.")
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if decode(r, &input) != nil || !validName(input.Name) {
		failure(w, 400, "invalid_name", "Provide a name with 1 to 80 characters.")
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	// Lock the actor to serialize invitation creation against operator recovery.
	user, active, err := loadUser(r.Context(), tx, actor.ID)
	if err != nil {
		unavailable(w)
		return
	}
	if !active || !user.Admin {
		denied(w)
		return
	}
	id := uuid.NewString()
	if _, err = tx.Exec(r.Context(), "INSERT INTO auth_users(id,name) VALUES($1,$2)", id, input.Name); err != nil {
		unavailable(w)
		return
	}
	v, err := invite(r.Context(), tx, id)
	if err != nil {
		unavailable(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	response(w, 201, v)
}

func (s *Service) beginEnrollment(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Token string `json:"token"`
		Name  string `json:"name"`
	}
	if decode(r, &input) != nil || !validToken(input.Token) {
		denied(w)
		return
	}
	var id string
	err := s.pool.QueryRow(r.Context(), "SELECT user_id::text FROM auth_invitations WHERE token_hash=$1 AND expires_at>now()", digest(input.Token)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		denied(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	u, active, err := loadUser(r.Context(), tx, id)
	if err != nil {
		unavailable(w)
		return
	}
	if active {
		denied(w)
		return
	}
	// The invitation's operator-selected account name cannot be changed by the visitor.
	options, session, err := s.settings.web.BeginRegistration(u)
	if err != nil {
		unavailable(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	state := ceremony{Session: *session, UserID: u.ID, Generation: u.generation, Invitation: digest(input.Token)}
	if s.saveCeremony(w, r, "enroll", state) != nil {
		unavailable(w)
		return
	}
	response(w, 200, options)
}

func (s *Service) finishEnrollment(w http.ResponseWriter, r *http.Request) {
	state, err := s.consume(w, r, "enroll")
	if err != nil {
		s.ceremonyError(w, err)
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	u, active, err := loadUser(r.Context(), tx, state.UserID)
	if err != nil {
		unavailable(w)
		return
	}
	if active || u.generation != state.Generation {
		denied(w)
		return
	}
	// Verify that recovery or another browser has not revoked/consumed the invitation.
	var invitationHash []byte
	err = tx.QueryRow(r.Context(), "DELETE FROM auth_invitations WHERE user_id=$1 AND token_hash=$2 AND expires_at>now() RETURNING token_hash", u.ID, state.Invitation).Scan(&invitationHash)
	if errors.Is(err, pgx.ErrNoRows) {
		denied(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	credential, err := s.settings.web.FinishRegistration(u, state.Session, r)
	if err != nil {
		denied(w)
		return
	}
	data, err := json.Marshal(credential)
	if err != nil {
		unavailable(w)
		return
	}
	if _, err = tx.Exec(r.Context(), "INSERT INTO auth_credentials(id,user_id,data) VALUES($1,$2,$3)", credential.ID, u.ID, data); err != nil {
		denied(w)
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE auth_users SET active=true WHERE id=$1", u.ID); err != nil {
		unavailable(w)
		return
	}
	s.complete(w, r, tx, u, state.BrowserVersion)
}

func (s *Service) beginLogin(w http.ResponseWriter, r *http.Request) {
	var input struct{}
	if decode(r, &input) != nil {
		failure(w, 400, "invalid_request", "Invalid request.")
		return
	}
	options, session, err := s.settings.web.BeginDiscoverableLogin(webauthn.WithUserVerification("required"))
	if err != nil {
		unavailable(w)
		return
	}
	if s.saveCeremony(w, r, "login", ceremony{Session: *session}) != nil {
		unavailable(w)
		return
	}
	response(w, 200, options)
}
func (s *Service) finishLogin(w http.ResponseWriter, r *http.Request) {
	state, err := s.consume(w, r, "login")
	if err != nil {
		s.ceremonyError(w, err)
		return
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	var account *User
	var lookupFailure error
	lookup := func(rawID, handle []byte) (webauthn.User, error) {
		if _, err := uuid.Parse(string(handle)); err != nil {
			return nil, errDenied
		}
		u, active, err := loadUser(r.Context(), tx, string(handle))
		if err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				lookupFailure = err
			}
			return nil, err
		}
		if !active {
			return nil, errDenied
		}
		account = u
		return u, nil
	}
	_, credential, err := s.settings.web.FinishPasskeyLogin(lookup, state.Session, r)
	if lookupFailure != nil {
		unavailable(w)
		return
	}
	if err != nil {
		denied(w)
		return
	}
	if account == nil {
		denied(w)
		return
	}
	if credential.Authenticator.CloneWarning {
		log.Print("passkey signature counter warning")
		// Synced authenticators can legitimately reset counters. Device-bound
		// counter regression requires operator recovery instead of a new session.
		if !credential.Flags.BackupEligible {
			denied(w)
			return
		}
	}
	// Apply library counter and backup-state semantics, including valid synced zero counters.
	data, err := json.Marshal(credential)
	if err != nil {
		unavailable(w)
		return
	}
	tag, err := tx.Exec(r.Context(), "UPDATE auth_credentials SET data=$1 WHERE id=$2 AND user_id=$3", data, credential.ID, account.ID)
	if err != nil || tag.RowsAffected() != 1 {
		unavailable(w)
		return
	}
	s.complete(w, r, tx, account, state.BrowserVersion)
}
func (s *Service) complete(w http.ResponseWriter, r *http.Request, tx pgx.Tx, u *User, expectedVersion int64) {
	var version int64
	if err := tx.QueryRow(r.Context(), "SELECT generation FROM auth_browsers WHERE token_hash=$1 FOR UPDATE", digest(s.readCookie(r, "csrf"))).Scan(&version); err != nil {
		unavailable(w)
		return
	}
	if version != expectedVersion {
		denied(w)
		return
	}
	raw, err := newSession(r.Context(), tx, u.ID, s.readCookie(r, "session"))
	if err != nil {
		unavailable(w)
		return
	}
	if _, err := tx.Exec(r.Context(), "UPDATE auth_sessions SET browser_hash=$1 WHERE token_hash=$2", digest(s.readCookie(r, "csrf")), digest(raw)); err != nil {
		unavailable(w)
		return
	}
	if tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	s.cookie(w, "session", raw, 7*24*60*60)
	response(w, 200, map[string]any{"user": u})
}

type bucket struct {
	count int
	until time.Time
}
type limiter struct {
	mu      sync.Mutex
	clients map[string]bucket
	global  bucket
}

func (l *limiter) allow(address string, now time.Time) bool {
	host := address
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.clients == nil {
		l.clients = map[string]bucket{}
	}
	if !now.Before(l.global.until) {
		l.global = bucket{until: now.Add(time.Minute)}
	}
	if l.global.count >= 300 {
		return false
	}
	b := l.clients[host]
	if !now.Before(b.until) {
		b = bucket{until: now.Add(time.Minute)}
	}
	if b.count >= 30 {
		return false
	}
	if len(l.clients) >= 4096 {
		for k, v := range l.clients {
			if !now.Before(v.until) {
				delete(l.clients, k)
			}
		}
		if _, exists := l.clients[host]; !exists && len(l.clients) >= 4096 {
			return false
		}
	}
	l.global.count++
	b.count++
	l.clients[host] = b
	return true
}

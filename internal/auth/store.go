package auth

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/webauthn"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

var errDenied = errors.New("authentication denied")

// User identifies an account in the single shared telemetry project.
type User struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Admin       bool   `json:"admin"`
	generation  int64
	credentials []webauthn.Credential
}

func (u *User) WebAuthnID() []byte                         { return []byte(u.ID) }
func (u *User) WebAuthnName() string                       { return u.Name }
func (u *User) WebAuthnDisplayName() string                { return u.Name }
func (u *User) WebAuthnCredentials() []webauthn.Credential { return u.credentials }

// Open connects using DATABASE_URL or standard PG* environment settings.
func Open(ctx context.Context, databaseURL string) (*pgxpool.Pool, error) {
	if databaseURL == "" && (os.Getenv("PGHOST") == "" || os.Getenv("PGUSER") == "" || os.Getenv("PGDATABASE") == "") {
		return nil, errors.New("set DATABASE_URL or explicit PGHOST, PGUSER, and PGDATABASE for authentication storage")
	}
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, errors.New("invalid authentication database configuration")
	}
	cfg.MaxConns = 8
	cfg.ConnConfig.ConnectTimeout = 5 * time.Second
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, errors.New("cannot open authentication database")
	}
	if err = pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, errors.New("authentication database unavailable")
	}
	return pool, nil
}

// Migrate applies the additive schema atomically and serializes concurrent callers.
func Migrate(ctx context.Context, pool *pgxpool.Pool) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(754382019)"); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, schema); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Ready fails startup closed until the migration has been applied.
func Ready(ctx context.Context, pool *pgxpool.Pool) error {
	var version int
	if err := pool.QueryRow(ctx, "SELECT max(version) FROM auth_schema_versions").Scan(&version); err != nil || version != 1 {
		return errors.New("authentication schema unavailable; run logice migrate")
	}
	return nil
}

func rollback(tx pgx.Tx) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = tx.Rollback(ctx)
}
func validName(name string) bool {
	return utf8.ValidString(name) && strings.TrimSpace(name) == name && utf8.RuneCountInString(name) > 0 && utf8.RuneCountInString(name) <= 80 && strings.IndexFunc(name, unicode.IsControl) == -1
}

// Invitation is returned only to the operator or an authenticated administrator.
type Invitation struct {
	Token     string    `json:"token"`
	ExpiresAt time.Time `json:"expiresAt"`
}

func invite(ctx context.Context, tx pgx.Tx, userID string) (Invitation, error) {
	v := Invitation{Token: token(), ExpiresAt: time.Now().UTC().Add(time.Hour)}
	_, err := tx.Exec(ctx, "INSERT INTO auth_invitations(token_hash,user_id,expires_at) VALUES($1,$2,$3)", digest(v.Token), userID, v.ExpiresAt)
	return v, err
}

// Bootstrap creates exactly one initial administrator, including under races.
func Bootstrap(ctx context.Context, pool *pgxpool.Pool, name string) (Invitation, error) {
	if !validName(name) {
		return Invitation{}, errors.New("name must contain 1 to 80 characters without surrounding whitespace or control characters")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Invitation{}, err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "SELECT pg_advisory_xact_lock(754382020)"); err != nil {
		return Invitation{}, err
	}
	var exists bool
	if err = tx.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM auth_users)").Scan(&exists); err != nil {
		return Invitation{}, err
	}
	if exists {
		return Invitation{}, errors.New("administrator bootstrap has already been performed; use operator recovery")
	}
	id := uuid.NewString()
	if _, err = tx.Exec(ctx, "INSERT INTO auth_users(id,name,admin) VALUES($1,$2,true)", id, name); err != nil {
		return Invitation{}, err
	}
	v, err := invite(ctx, tx, id)
	if err != nil {
		return Invitation{}, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO auth_events(action,user_id) VALUES('bootstrap',$1)", id); err != nil {
		return Invitation{}, err
	}
	return v, tx.Commit(ctx)
}

// Recover is operator-only. Revoke all login paths before issuing a replacement invitation.
func Recover(ctx context.Context, pool *pgxpool.Pool, userID string) (Invitation, error) {
	if _, err := uuid.Parse(userID); err != nil {
		return Invitation{}, errors.New("user must be a UUID")
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		return Invitation{}, err
	}
	defer rollback(tx)
	tag, err := tx.Exec(ctx, "UPDATE auth_users SET active=false,generation=generation+1 WHERE id=$1", userID)
	if err != nil {
		return Invitation{}, err
	}
	if tag.RowsAffected() != 1 {
		return Invitation{}, errors.New("account not found")
	}
	for _, table := range []string{"auth_sessions", "auth_credentials", "auth_invitations"} {
		if _, err = tx.Exec(ctx, "DELETE FROM "+table+" WHERE user_id=$1", userID); err != nil {
			return Invitation{}, err
		}
	}
	v, err := invite(ctx, tx, userID)
	if err != nil {
		return Invitation{}, err
	}
	if _, err = tx.Exec(ctx, "INSERT INTO auth_events(action,user_id) VALUES('operator_recovery',$1)", userID); err != nil {
		return Invitation{}, err
	}
	return v, tx.Commit(ctx)
}

func loadUser(ctx context.Context, tx pgx.Tx, id string) (*User, bool, error) {
	u := &User{}
	var active bool
	err := tx.QueryRow(ctx, "SELECT id::text,name,admin,active,generation FROM auth_users WHERE id=$1 FOR UPDATE", id).Scan(&u.ID, &u.Name, &u.Admin, &active, &u.generation)
	if err != nil {
		return nil, false, err
	}
	rows, err := tx.Query(ctx, "SELECT data FROM auth_credentials WHERE user_id=$1", id)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		var c webauthn.Credential
		if err = rows.Scan(&raw); err != nil {
			return nil, false, err
		}
		if err = json.Unmarshal(raw, &c); err != nil {
			return nil, false, err
		}
		u.credentials = append(u.credentials, c)
	}
	return u, active, rows.Err()
}

func sessionUser(ctx context.Context, pool *pgxpool.Pool, raw string) (*User, error) {
	if !validToken(raw) {
		return nil, errDenied
	}
	u := &User{}
	// Idle expiry never extends the absolute seven-day deadline.
	err := pool.QueryRow(ctx, `UPDATE auth_sessions s SET last_seen=now() FROM auth_users u
 WHERE s.token_hash=$1 AND u.id=s.user_id AND u.active
 AND s.expires_at>now() AND s.last_seen>now()-interval '24 hours'
 RETURNING u.id::text,u.name,u.admin`, digest(raw)).Scan(&u.ID, &u.Name, &u.Admin)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errDenied
	}
	return u, err
}

func newSession(ctx context.Context, tx pgx.Tx, userID, previous string) (string, error) {
	if validToken(previous) {
		if _, err := tx.Exec(ctx, "DELETE FROM auth_sessions WHERE token_hash=$1", digest(previous)); err != nil {
			return "", err
		}
	}
	raw := token()
	_, err := tx.Exec(ctx, "INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(raw), userID)
	return raw, err
}

// Cleanup removes expired state without changing the request-time expiry checks.
func Cleanup(ctx context.Context, pool *pgxpool.Pool) error {
	for _, statement := range []string{
		"DELETE FROM auth_ceremonies WHERE expires_at<=now()",
		"DELETE FROM auth_sessions WHERE expires_at<=now() OR last_seen<=now()-interval '24 hours'",
		"DELETE FROM auth_invitations WHERE expires_at<=now()",
		"DELETE FROM auth_browsers WHERE touched_at<=now()-interval '7 days'",
	} {
		if _, err := pool.Exec(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

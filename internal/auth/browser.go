package auth

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// browserVersion binds ceremonies and sessions to a browser's CSRF cookie.
// Every begin request captures this version before creating challenge options.
func browserVersion(ctx context.Context, pool *pgxpool.Pool, csrf string) (int64, error) {
	var version int64
	err := pool.QueryRow(ctx, `INSERT INTO auth_browsers(token_hash) VALUES($1)
 ON CONFLICT(token_hash) DO UPDATE SET touched_at=now()
 RETURNING generation`, digest(csrf)).Scan(&version)
	return version, err
}

// logout serializes with challenge persistence and session issuance. A finish
// that committed first is revoked here; one that commits later sees a changed version.
func logout(ctx context.Context, pool *pgxpool.Pool, csrf, session string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(tx)
	if _, err = tx.Exec(ctx, "UPDATE auth_browsers SET generation=generation+1,touched_at=now() WHERE token_hash=$1", digest(csrf)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM auth_ceremonies WHERE csrf_hash=$1", digest(csrf)); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, "DELETE FROM auth_sessions WHERE browser_hash=$1 OR token_hash=$2", digest(csrf), digest(session)); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

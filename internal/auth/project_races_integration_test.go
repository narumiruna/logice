//go:build integration

package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestProjectQueuedMutationRechecksRoleAndDeletion(t *testing.T) {
	pool, ctx := disposablePostgres(t)
	if err := Migrate(ctx, pool); err != nil {
		t.Fatal(err)
	}
	s := testService(t, "https://example.test")
	s.pool = pool
	owner, developer, project := uuid.NewString(), uuid.NewString(), uuid.NewString()
	session := token()
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec("INSERT INTO auth_users(id,name,active) VALUES($1,'Owner',true),($2,'Developer',true)", owner, developer)
	exec("INSERT INTO projects(id,name,owner_user_id) VALUES($1,'Race',$2)", project, owner)
	exec("INSERT INTO project_members(project_id,user_id,role) VALUES($1,$2,'Developer')", project, developer)
	exec("INSERT INTO auth_sessions(token_hash,user_id) VALUES($1,$2)", digest(session), developer)
	for _, deleting := range []bool{false, true} {
		exec("UPDATE project_members SET role='Developer' WHERE project_id=$1 AND user_id=$2", project, developer)
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollback(tx)
		if _, err = tx.Exec(ctx, "SELECT id FROM projects WHERE id=$1 FOR UPDATE", project); err != nil {
			t.Fatal(err)
		}
		done := make(chan int, 1)
		go func() {
			r := authRequest(s, "POST", "/api/projects/"+project+"/tokens", `{"name":"queued"}`).WithContext(ctx)
			r.AddCookie(&http.Cookie{Name: s.cookieName("session"), Value: session})
			w := httptest.NewRecorder()
			s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
			done <- w.Code
		}()
		// Observe the actual blocked project SELECT, not a scheduler timing assumption.
		deadline := time.Now().Add(3 * time.Second)
		for {
			var waiting int
			if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%FROM projects WHERE id=%'").Scan(&waiting); err != nil {
				t.Fatal(err)
			}
			if waiting > 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("project request did not wait on row lock")
			}
			time.Sleep(10 * time.Millisecond)
		}
		if deleting {
			_, err = tx.Exec(ctx, "UPDATE projects SET deleted_at=now() WHERE id=$1", project)
		} else {
			_, err = tx.Exec(ctx, "UPDATE project_members SET role='Viewer' WHERE project_id=$1 AND user_id=$2", project, developer)
		}
		if err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		want := 403
		if deleting {
			want = 404
		}
		select {
		case status := <-done:
			if status != want {
				t.Fatalf("queued mutation status %d want %d", status, want)
			}
		case <-time.After(6 * time.Second):
			t.Fatal("queued mutation did not complete")
		}
	}
	var count int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM project_tokens WHERE project_id=$1", project).Scan(&count); err != nil || count != 0 {
		t.Fatal("stale authority created a token", err)
	}
}

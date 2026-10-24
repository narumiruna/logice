package auth

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

func (s *Service) passkeys(w http.ResponseWriter, r *http.Request) {
	actor, err := sessionUser(r.Context(), s.pool, s.readCookie(r, "session"))
	if errors.Is(err, errDenied) {
		denied(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/auth/passkeys")
	var state *ceremony
	if path == "/authorize/finish" || path == "/add/finish" {
		kind := "manage_assert"
		if path == "/add/finish" {
			kind = "credential_add"
		}
		state, err = s.consume(w, r, kind)
		if err != nil {
			s.ceremonyError(w, err)
			return
		}
	}
	tx, err := s.pool.Begin(r.Context())
	if err != nil {
		unavailable(w)
		return
	}
	defer rollback(tx)
	user, active, err := loadUser(r.Context(), tx, actor.ID)
	if err != nil {
		unavailable(w)
		return
	}
	if !active {
		denied(w)
		return
	}
	if path == "" {
		if r.URL.RawQuery != "" {
			projectInvalid(w)
			return
		}
		type metadata struct {
			ID         string     `json:"id"`
			Name       string     `json:"name"`
			CreatedAt  *time.Time `json:"createdAt"`
			LastUsedAt *time.Time `json:"lastUsedAt"`
		}
		rows, err := tx.Query(r.Context(), "SELECT management_id::text,name,created_at,last_used_at FROM auth_credentials WHERE user_id=$1 ORDER BY management_id LIMIT 9", user.ID)
		if err != nil {
			unavailable(w)
			return
		}
		defer rows.Close()
		items := []metadata{}
		for rows.Next() {
			var c metadata
			if rows.Scan(&c.ID, &c.Name, &c.CreatedAt, &c.LastUsedAt) != nil {
				unavailable(w)
				return
			}
			items = append(items, c)
		}
		if rows.Err() != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]any{"items": items})
		return
	}
	if path == "/rename" {
		var input struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		}
		if strictJSON(r, &input) != nil || !projectID(input.ID) || !validName(input.Name) {
			projectInvalid(w)
			return
		}
		tag, err := tx.Exec(r.Context(), "UPDATE auth_credentials SET name=$3 WHERE user_id=$1 AND management_id=$2", user.ID, input.ID, input.Name)
		if err != nil {
			unavailable(w)
			return
		}
		if tag.RowsAffected() != 1 {
			projectMissing(w)
			return
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO auth_events(action,user_id) VALUES('passkey_renamed',$1)", user.ID)
		if err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]bool{"ok": true})
		return
	}
	if path == "/authorize/begin" {
		var input struct {
			Operation string `json:"operation"`
			Target    string `json:"target"`
			Name      string `json:"name"`
		}
		if strictJSON(r, &input) != nil || (input.Operation != "add" && input.Operation != "remove") || (input.Operation == "add" && (!validName(input.Name) || input.Target != "")) || (input.Operation == "remove" && (!projectID(input.Target) || input.Name != "")) {
			projectInvalid(w)
			return
		}
		if len(user.credentials) >= 8 && input.Operation == "add" {
			failure(w, 409, "credential_limit", "At most eight Passkeys are allowed.")
			return
		}
		if input.Operation == "remove" {
			var exists bool
			if tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM auth_credentials WHERE user_id=$1 AND management_id=$2)", user.ID, input.Target).Scan(&exists) != nil {
				unavailable(w)
				return
			}
			if !exists {
				projectMissing(w)
				return
			}
			if len(user.credentials) <= 1 {
				failure(w, 409, "last_passkey", "Add a backup before removing the last Passkey.")
				return
			}
		}
		options, session, err := s.settings.web.BeginLogin(user, webauthn.WithUserVerification(protocol.VerificationRequired))
		if err != nil {
			unavailable(w)
			return
		}
		state := ceremony{Session: *session, UserID: user.ID, Generation: user.generation, Operation: input.Operation, Target: input.Target, CredentialName: input.Name, SessionHash: digest(s.readCookie(r, "session"))}
		if tx.Commit(r.Context()) != nil || s.saveCeremony(w, r, "manage_assert", state) != nil {
			unavailable(w)
			return
		}
		response(w, 200, options)
		return
	}
	kind := "manage_assert"
	if path == "/add/finish" {
		kind = "credential_add"
	} else if path != "/authorize/finish" {
		projectMissing(w)
		return
	}
	// Proof consumption precedes the user lock and is not rolled back on failure.
	if state == nil {
		denied(w)
		return
	}
	version, _ := r.Context().Value(browserVersionKey{}).(int64)
	if state.UserID != user.ID || state.Generation != user.generation || state.BrowserVersion != version || !bytes.Equal(state.SessionHash, digest(s.readCookie(r, "session"))) {
		denied(w)
		return
	}
	var currentVersion int64
	if tx.QueryRow(r.Context(), "SELECT generation FROM auth_browsers WHERE token_hash=$1 FOR UPDATE", digest(s.readCookie(r, "csrf"))).Scan(&currentVersion) != nil {
		unavailable(w)
		return
	}
	var sessionExists bool
	if tx.QueryRow(r.Context(), "SELECT EXISTS(SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND user_id=$2 AND expires_at>now() AND last_seen>now()-interval '24 hours')", digest(s.readCookie(r, "session")), user.ID).Scan(&sessionExists) != nil {
		unavailable(w)
		return
	}
	if currentVersion != state.BrowserVersion || !sessionExists {
		denied(w)
		return
	}
	if kind == "credential_add" {
		if state.Operation != "add" || len(user.credentials) >= 8 {
			failure(w, 409, "credential_limit", "Cannot add another Passkey.")
			return
		}
		credential, err := s.settings.web.FinishRegistration(user, state.Session, r)
		if err != nil {
			denied(w)
			return
		}
		raw, err := json.Marshal(credential)
		if err != nil {
			unavailable(w)
			return
		}
		_, err = tx.Exec(r.Context(), "INSERT INTO auth_credentials(id,user_id,data,name,created_at) VALUES($1,$2,$3,$4,now())", credential.ID, user.ID, raw, state.CredentialName)
		if err == nil {
			_, err = tx.Exec(r.Context(), "INSERT INTO auth_events(action,user_id) VALUES('passkey_added',$1)", user.ID)
		}
		if err != nil || tx.Commit(r.Context()) != nil {
			unavailable(w)
			return
		}
		response(w, 200, map[string]bool{"ok": true})
		return
	}
	credential, err := s.settings.web.FinishLogin(user, state.Session, r)
	if err != nil || (credential.Authenticator.CloneWarning && !credential.Flags.BackupEligible) {
		denied(w)
		return
	}
	raw, err := json.Marshal(credential)
	if err != nil {
		unavailable(w)
		return
	}
	if _, err = tx.Exec(r.Context(), "UPDATE auth_credentials SET data=$1,last_used_at=now() WHERE id=$2 AND user_id=$3", raw, credential.ID, user.ID); err != nil {
		unavailable(w)
		return
	}
	if state.Operation == "add" {
		exclusions := []protocol.CredentialDescriptor{}
		for _, c := range user.credentials {
			exclusions = append(exclusions, c.Descriptor())
		}
		options, session, err := s.settings.web.BeginRegistration(user, webauthn.WithExclusions(exclusions))
		if err != nil {
			unavailable(w)
			return
		}
		state.Session = *session
		if tx.Commit(r.Context()) != nil || s.saveCeremony(w, r, "credential_add", *state) != nil {
			unavailable(w)
			return
		}
		response(w, 200, options)
		return
	}
	if state.Operation != "remove" || len(user.credentials) <= 1 {
		failure(w, 409, "last_passkey", "The last Passkey cannot be removed.")
		return
	}
	tag, err := tx.Exec(r.Context(), "DELETE FROM auth_credentials WHERE user_id=$1 AND management_id=$2", user.ID, state.Target)
	if err != nil {
		unavailable(w)
		return
	}
	if tag.RowsAffected() != 1 {
		projectMissing(w)
		return
	}
	for _, statement := range []string{"UPDATE auth_users SET generation=generation+1 WHERE id=$1", "DELETE FROM auth_sessions WHERE user_id=$1", "INSERT INTO auth_events(action,user_id) VALUES('passkey_removed',$1)"} {
		if _, err = tx.Exec(r.Context(), statement, user.ID); err != nil {
			unavailable(w)
			return
		}
	}
	s.complete(w, r, tx, user, state.BrowserVersion)
}

package auth

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func (s *Service) profile(w http.ResponseWriter, r *http.Request) {
	actor, err := sessionUser(r.Context(), s.pool, s.readCookie(r, "session"))
	if errors.Is(err, errDenied) {
		denied(w)
		return
	}
	if err != nil {
		unavailable(w)
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || !validName(input.Name) {
		failure(w, 400, "invalid_name", "Provide a name with 1 to 80 characters.")
		return
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		failure(w, 400, "invalid_request", "Invalid profile request.")
		return
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
	_, err = tx.Exec(r.Context(), "UPDATE auth_users SET name=$2 WHERE id=$1", user.ID, input.Name)
	if err == nil {
		_, err = tx.Exec(r.Context(), "INSERT INTO auth_events(action,user_id) VALUES('profile_updated',$1)", user.ID)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		unavailable(w)
		return
	}
	user.Name = input.Name
	response(w, 200, map[string]any{"user": user})
}

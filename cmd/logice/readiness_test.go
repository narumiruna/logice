package main

import (
	"context"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/narumiruna/logice/internal/auth"
	"github.com/narumiruna/logice/internal/httpapi"
)

func TestReadinessDoesNotBypassApplicationAuthentication(t *testing.T) {
	accounts, err := auth.New(auth.Config{Origin: "http://localhost:5173", EncryptionKey: strings.Repeat("ab", 32)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := httpapi.NewServer()
	server.Handler = httpapi.WithReadiness(accounts.Wrap(server.Handler), func(context.Context) error { return nil })
	for _, tc := range []struct {
		path string
		want int
	}{
		{"/api/readyz", 200}, {"/api/healthz", 200},
		{"/api/projects", 503}, {"/api/readyz/", 503}, {"/api/auth/session", 503},
	} {
		w := httptest.NewRecorder()
		server.Handler.ServeHTTP(w, httptest.NewRequest("GET", tc.path, nil))
		if w.Code != tc.want {
			t.Fatalf("%s status=%d want=%d", tc.path, w.Code, tc.want)
		}
	}
}

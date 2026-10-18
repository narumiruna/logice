package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthz(t *testing.T) {
	for _, target := range []string{"/api/healthz", "/api/healthz?check=live"} {
		t.Run(target, func(t *testing.T) {
			response := httptest.NewRecorder()
			newHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", response.Code)
			}
			assertJSON(t, response, `{"status":"ok"}`)
		})
	}
}

func TestHealthzHead(t *testing.T) {
	response := httptest.NewRecorder()
	newHandler().ServeHTTP(response, httptest.NewRequest(http.MethodHead, "/api/healthz", nil))
	if response.Code != http.StatusOK || response.Body.Len() != 0 {
		t.Fatalf("HEAD response: status = %d, body = %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q", got)
	}
}

func TestUnknownRoute(t *testing.T) {
	for _, target := range []string{"/", "/missing", "/api/missing", "/api/readyz", "/api/healthz/", "/index.html", "/assets/app.js"} {
		t.Run(target, func(t *testing.T) {
			response := httptest.NewRecorder()
			newHandler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, target, nil))
			if response.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", response.Code)
			}
			assertJSON(t, response, `{"error":{"code":"not_found","message":"route not found"}}`)
		})
	}
}

func TestWrongMethod(t *testing.T) {
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions} {
		t.Run(method, func(t *testing.T) {
			response := httptest.NewRecorder()
			newHandler().ServeHTTP(response, httptest.NewRequest(method, "/api/healthz", nil))
			if response.Code != http.StatusMethodNotAllowed {
				t.Fatalf("status = %d, want 405", response.Code)
			}
			if got := response.Header().Get("Allow"); got != "GET, HEAD" {
				t.Fatalf("Allow = %q, want GET, HEAD", got)
			}
			assertJSON(t, response, `{"error":{"code":"method_not_allowed","message":"method not allowed"}}`)
		})
	}
}

func TestHandlerCanceledRequest(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/healthz", nil).WithContext(ctx)
	response := httptest.NewRecorder()
	newHandler().ServeHTTP(response, request)
	if response.Flushed || response.Body.Len() != 0 || len(response.Header()) != 0 {
		t.Fatalf("canceled request wrote a response: %+v", response)
	}
}

func assertJSON(t *testing.T, response *httptest.ResponseRecorder, want string) {
	t.Helper()
	if got := response.Header().Get("Content-Type"); got != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", got)
	}
	if !json.Valid(response.Body.Bytes()) {
		t.Fatalf("invalid JSON: %q", response.Body.String())
	}
	if got := response.Body.String(); got != want+"\n" {
		t.Fatalf("body = %q, want %q", got, want+"\n")
	}
}

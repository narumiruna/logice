package auth

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func authRequest(s *Service, method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	raw := token()
	r.AddCookie(&http.Cookie{Name: s.cookieName("csrf"), Value: raw})
	r.Header.Set("X-CSRF-Token", raw)
	r.Header.Set("Origin", s.settings.origin)
	r.Header.Set("Content-Type", "application/json")
	return r
}

func TestCSRFControls(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*http.Request)
		status int
	}{
		{"valid", func(r *http.Request) {}, 503},
		{"json charset", func(r *http.Request) { r.Header.Set("Content-Type", "application/json; charset=utf-8") }, 503},
		{"method", func(r *http.Request) { r.Method = "GET" }, 405},
		{"missing origin", func(r *http.Request) { r.Header.Del("Origin") }, 403},
		{"wrong origin", func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, 403},
		{"origin suffix", func(r *http.Request) { r.Header.Set("Origin", "https://example.test.evil.test") }, 403},
		{"origin slash", func(r *http.Request) { r.Header.Set("Origin", "https://example.test/") }, 403},
		{"cross site", func(r *http.Request) { r.Header.Set("Sec-Fetch-Site", "cross-site") }, 403},
		{"missing cookie", func(r *http.Request) { r.Header.Del("Cookie") }, 403},
		{"wrong token", func(r *http.Request) { r.Header.Set("X-CSRF-Token", token()) }, 403},
		{"missing token", func(r *http.Request) { r.Header.Del("X-CSRF-Token") }, 403},
		{"form", func(r *http.Request) { r.Header.Set("Content-Type", "application/x-www-form-urlencoded") }, 415},
		{"missing content type", func(r *http.Request) { r.Header.Del("Content-Type") }, 415},
		{"jsonp", func(r *http.Request) { r.Header.Set("Content-Type", "application/jsonp") }, 415},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := testService(t, "https://example.test")
			r := authRequest(s, "POST", "/api/auth/login/begin", "{}")
			tc.change(r)
			w := httptest.NewRecorder()
			s.Wrap(http.NotFoundHandler()).ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
		})
	}
}

func TestNilDatabaseBoundaryAndTrustedOrigin(t *testing.T) {
	s := testService(t, "https://example.test")
	for _, tc := range []struct {
		path   string
		status int
		next   bool
	}{
		{"/api/healthz", 204, true}, {"/", 204, true}, {"/api/query", 503, false}, {"/api", 503, false}, {"/api/auth/session", 503, false}, {"/api/auth/csrf", 200, false},
	} {
		t.Run(tc.path, func(t *testing.T) {
			called := false
			h := s.Wrap(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(204) }))
			r := httptest.NewRequest("GET", tc.path, nil)
			r.Host = "evil.test"
			for _, key := range []string{"Forwarded", "X-Forwarded-Host", "X-Forwarded-Proto", "Cf-Access-Authenticated-User-Email", "Cf-Access-Jwt-Assertion"} {
				r.Header.Set(key, "attacker.test")
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || called != tc.next {
				t.Fatalf("status=%d next=%v", w.Code, called)
			}
			if s.settings.web.Config.RPID != "example.test" || len(s.settings.web.Config.RPOrigins) != 1 || s.settings.web.Config.RPOrigins[0] != "https://example.test" {
				t.Fatal("request changed RP configuration")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing no-store")
			}
		})
	}
	for _, path := range []string{"/api/auth/csrf", "/api/auth/session"} {
		w := httptest.NewRecorder()
		s.Wrap(http.NotFoundHandler()).ServeHTTP(w, authRequest(s, "POST", path, "{}"))
		if w.Code != 405 || w.Header().Get("Allow") != "GET" {
			t.Fatal("read-only route accepts POST")
		}
	}
}

func TestCookieFlags(t *testing.T) {
	for _, origin := range []string{"https://example.test", "http://localhost:3000"} {
		s := testService(t, origin)
		for _, kind := range []string{"session", "csrf", "ceremony"} {
			for _, age := range []int{300, -1} {
				w := httptest.NewRecorder()
				s.cookie(w, kind, token(), age)
				cookies := w.Result().Cookies()
				if len(cookies) != 1 {
					t.Fatal("expected one cookie")
				}
				c := cookies[0]
				if c.Name != s.cookieName(kind) || c.Path != "/" || c.Domain != "" || !c.HttpOnly || c.SameSite != http.SameSiteLaxMode || c.Secure != s.settings.secure || c.MaxAge != age {
					t.Fatalf("unsafe cookie: %+v", c)
				}
			}
		}
		r := httptest.NewRequest("GET", "/", nil)
		w := httptest.NewRecorder()
		raw := s.csrf(w, r)
		if !validToken(raw) {
			t.Fatal("invalid CSRF")
		}
		r.AddCookie(w.Result().Cookies()[0])
		w = httptest.NewRecorder()
		if s.csrf(w, r) != raw || len(w.Result().Cookies()) != 0 {
			t.Fatal("CSRF cookie not reused")
		}
	}
}

func TestLimiter(t *testing.T) {
	now := time.Now()
	t.Run("per browser and expiry", func(t *testing.T) {
		var l limiter
		for range 30 {
			if !l.allow("browser-one", now) {
				t.Fatal("early rejection")
			}
		}
		if l.allow("browser-one", now) {
			t.Fatal("browser limit bypassed")
		}
		if !l.allow("browser-two", now) || l.global.count != 31 {
			t.Fatal("one browser charged rejected requests to the global budget or blocked another browser")
		}
		if !l.allow("browser-one", now.Add(time.Minute)) {
			t.Fatal("expired bucket rejected")
		}
	})
	t.Run("concurrent global", func(t *testing.T) {
		var l limiter
		var accepted atomic.Int32
		var wg sync.WaitGroup
		for i := range 600 {
			wg.Go(func() {
				if l.allow(fmt.Sprintf("client-%d", i), now) {
					accepted.Add(1)
				}
			})
		}
		wg.Wait()
		if accepted.Load() != 300 {
			t.Fatalf("accepted %d", accepted.Load())
		}
	})
	t.Run("bounded and cleanup", func(t *testing.T) {
		var l limiter
		for i := range 4096 {
			if !l.allow(fmt.Sprintf("client-%d", i), now.Add(time.Duration(i/200)*time.Second*61)) {
				t.Fatal("early rejection")
			}
		}
		if len(l.clients) > 4096 {
			t.Fatal("unbounded limiter")
		}
		l.global = bucket{} // Isolate the map bound from the global rate bound.
		if l.allow("new-client", now) {
			t.Fatal("map bound bypassed")
		}
		if !l.allow("new-client", now.Add(24*time.Hour)) || len(l.clients) > 4096 {
			t.Fatal("expired clients not removed")
		}
	})
}

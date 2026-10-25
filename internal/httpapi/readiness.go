package httpapi

import (
	"context"
	"net/http"
	"time"
)

// WithReadiness adds only a bounded status probe. The callback must honor its
// context. One probe can use dependencies at a time; overload fails closed.
func WithReadiness(next http.Handler, check func(context.Context) error) http.Handler {
	return withReadiness(next, check, 2*time.Second)
}

func withReadiness(next http.Handler, check func(context.Context) error, timeout time.Duration) http.Handler {
	slot := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/readyz" {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Type", "application/json")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			methodNotAllowed(w, "GET, HEAD")
			return
		}
		status := http.StatusServiceUnavailable
		select {
		case slot <- struct{}{}:
			defer func() { <-slot }()
			ctx, cancel := context.WithTimeout(r.Context(), timeout)
			defer cancel()
			if check != nil && ctx.Err() == nil && check(ctx) == nil && ctx.Err() == nil {
				status = http.StatusOK
			}
		default:
			// Do not queue public probe requests behind a storage outage.
		}
		w.WriteHeader(status)
		if r.Method == http.MethodGet {
			if status == http.StatusOK {
				_, _ = w.Write([]byte("{\"status\":\"ready\"}\n"))
			} else {
				_, _ = w.Write([]byte("{\"status\":\"unavailable\"}\n"))
			}
		}
	})
}

package auth

import (
	"bytes"
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const ingestionBodyLimit = 8 << 20

// ConfigureIngestion sets trusted infrastructure configuration before serving requests.
func (s *Service) ConfigureIngestion(endpoint, credential string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || strings.TrimSpace(credential) == "" || strings.ContainsAny(credential, "\r\n") {
		return errors.New("invalid internal Collector configuration")
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	transport.MaxConnsPerHost = 128
	transport.MaxIdleConnsPerHost = 16
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	slots := make(chan struct{}, 128)
	// Stream length-delimited input. Bound unknown-length and response buffers
	// independently so 128 large requests cannot allocate a GiB in the API.
	bodyBuffers := make(chan struct{}, 4)
	responseBuffers := make(chan struct{}, 4)
	s.ingestion = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			failure(w, 405, "method_not_allowed", "Method not allowed.")
			return
		}
		if r.URL.RawQuery != "" {
			projectInvalid(w)
			return
		}
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || media != "application/x-protobuf" {
			failure(w, 415, "invalid_content_type", "OTLP HTTP protobuf is required.")
			return
		}
		if len(r.Header.Values("Authorization")) != 1 {
			denied(w)
			return
		}
		scheme, raw, ok := strings.Cut(r.Header.Get("Authorization"), " ")
		if !ok || !strings.EqualFold(scheme, "Bearer") || !validToken(raw) {
			denied(w)
			return
		}
		if s.pool == nil {
			unavailable(w)
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			w.Header().Set("Retry-After", "1")
			failure(w, 429, "overloaded", "Ingestion capacity reached.")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
		defer cancel()
		var project string
		err = s.pool.QueryRow(ctx, `SELECT p.id::text FROM project_tokens t JOIN projects p ON p.id=t.project_id WHERE t.token_hash=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now()) AND p.deleted_at IS NULL`, digest(raw)).Scan(&project)
		if errors.Is(err, pgx.ErrNoRows) {
			denied(w)
			return
		}
		if err != nil {
			unavailable(w)
			return
		}
		if r.ContentLength > ingestionBodyLimit {
			failure(w, 413, "payload_too_large", "OTLP payload is too large.")
			return
		}
		var body io.Reader = r.Body
		if r.ContentLength < 0 {
			select {
			case bodyBuffers <- struct{}{}:
				defer func() { <-bodyBuffers }()
			default:
				w.Header().Set("Retry-After", "1")
				failure(w, 429, "overloaded", "Ingestion buffering capacity reached.")
				return
			}
			data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, ingestionBodyLimit))
			if err != nil {
				var tooLarge *http.MaxBytesError
				if errors.As(err, &tooLarge) {
					failure(w, 413, "payload_too_large", "OTLP payload is too large.")
				} else {
					projectInvalid(w)
				}
				return
			}
			body = bytes.NewReader(data)
		}
		upstream := *u
		upstream.Path = r.URL.Path
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, upstream.String(), body)
		if err != nil {
			unavailable(w)
			return
		}
		if r.ContentLength >= 0 {
			req.ContentLength = r.ContentLength
		}
		// A fresh allowlisted header map removes all client project/forwarding metadata,
		// including case variants, duplicates, and Connection-nominated headers.
		req.Header.Set("Content-Type", "application/x-protobuf")
		encoding := r.Header.Values("Content-Encoding")
		if len(encoding) > 1 || (len(encoding) == 1 && encoding[0] != "gzip" && encoding[0] != "identity") {
			failure(w, 415, "invalid_encoding", "Unsupported content encoding.")
			return
		}
		if len(encoding) == 1 {
			req.Header.Set("Content-Encoding", encoding[0])
		}
		req.Header.Set("Authorization", "Bearer "+credential)
		req.Header.Set("X-Logice-Project-Id", project)
		res, err := client.Do(req)
		if err != nil {
			failure(w, 502, "collector_unavailable", "Collector is unavailable.")
			return
		}
		defer res.Body.Close()
		select {
		case responseBuffers <- struct{}{}:
			defer func() { <-responseBuffers }()
		case <-ctx.Done():
			failure(w, 502, "collector_unavailable", "Collector response deadline exceeded.")
			return
		}
		responseBody, err := io.ReadAll(io.LimitReader(res.Body, (1<<20)+1))
		if err != nil || len(responseBody) > 1<<20 {
			failure(w, 502, "invalid_collector_response", "Collector response is unavailable or too large.")
			return
		}
		for _, h := range []string{"Content-Type", "Content-Encoding", "Retry-After"} {
			if v := res.Header.Get(h); v != "" {
				w.Header().Set(h, v)
			}
		}
		w.WriteHeader(res.StatusCode)
		_, _ = w.Write(responseBody)
	})
	return nil
}

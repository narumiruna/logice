package auth

import (
	"bytes"
	"context"
	"encoding/base64"
	"strings"
	"testing"
)

const testKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func testService(t *testing.T, origin string) *Service {
	t.Helper()
	s, err := New(Config{Origin: origin, EncryptionKey: testKey}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestConfigureOrigin(t *testing.T) {
	for _, origin := range []string{"https://example.test", "https://example.test:8443", "http://localhost", "http://localhost:3000"} {
		t.Run(origin, func(t *testing.T) {
			s := testService(t, origin)
			if s.settings.origin != origin || s.settings.secure != strings.HasPrefix(origin, "https:") {
				t.Fatal("origin settings changed")
			}
		})
	}
	for _, origin := range []string{"", "http://example.test", "http://127.0.0.1", "http://[::1]", "https://example.test/", "https://example.test/path", "https://user@example.test", "https://example.test?x=1", "https://example.test#x", "https://example.test?", "https://example.test#", "//example.test", "HTTPS://example.test"} {
		t.Run("reject_"+origin, func(t *testing.T) {
			if _, err := configure(Config{Origin: origin, EncryptionKey: testKey}); err == nil {
				t.Fatalf("accepted %q", origin)
			}
		})
	}
}

func TestEncryption(t *testing.T) {
	for _, key := range []string{"", strings.Repeat("a", 63), strings.Repeat("a", 65), strings.Repeat("g", 64), strings.Repeat("aa", 16)} {
		if _, err := configure(Config{Origin: "https://example.test", EncryptionKey: key}); err == nil {
			t.Fatalf("accepted invalid key length %d", len(key))
		}
	}
	s := testService(t, "https://example.test").settings
	plain := []byte(`{"challenge":"fake-test-challenge"}`)
	encrypted := s.seal(plain, "login:token")
	got, err := s.open(encrypted, "login:token")
	if err != nil || !bytes.Equal(got, plain) {
		t.Fatalf("round trip: %q %v", got, err)
	}
	if bytes.Equal(encrypted, s.seal(plain, "login:token")) {
		t.Fatal("nonce reused")
	}
	wrongKey, err := configure(Config{Origin: s.origin, EncryptionKey: strings.Repeat("ab", 32)})
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Clone(encrypted)
	tampered[len(tampered)-1] ^= 1
	for _, tc := range []struct {
		name    string
		s       *settings
		data    []byte
		binding string
	}{
		{"tamper", s, tampered, "login:token"}, {"AAD", s, encrypted, "enroll:token"}, {"key", wrongKey, encrypted, "login:token"}, {"empty", s, nil, "login:token"}, {"short", s, encrypted[:s.aead.NonceSize()-1], "login:token"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tc.s.open(tc.data, tc.binding); err == nil {
				t.Fatal("accepted invalid ciphertext")
			}
		})
	}
}

func TestDatabaseConfigurationRequired(t *testing.T) {
	for _, key := range []string{"PGHOST", "PGUSER", "PGDATABASE"} {
		t.Setenv(key, "")
	}
	if pool, err := Open(context.Background(), ""); err == nil || pool != nil {
		t.Fatal("missing explicit database target accepted")
	}
}

func TestTokens(t *testing.T) {
	seen := map[string]bool{}
	for range 100 {
		raw := token()
		if !validToken(raw) || len(raw) != 43 || seen[raw] {
			t.Fatal("invalid or repeated token")
		}
		seen[raw] = true
		if len(digest(raw)) != 32 || bytes.Equal(digest(raw), []byte(raw)) {
			t.Fatal("invalid token digest")
		}
	}
	for _, raw := range []string{"", "x", token() + "=", base64.RawURLEncoding.EncodeToString(make([]byte, 31)), base64.RawURLEncoding.EncodeToString(make([]byte, 33)), strings.Repeat("!", 43)} {
		if validToken(raw) {
			t.Fatalf("accepted invalid token %q", raw)
		}
	}
}

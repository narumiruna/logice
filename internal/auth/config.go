// Package auth implements invitation-only WebAuthn accounts and opaque sessions.
package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"
)

// Config is supplied by the operator, never inferred from HTTP headers.
type Config struct {
	Origin        string
	EncryptionKey string
}

type settings struct {
	origin string
	secure bool
	aead   cipher.AEAD
	web    *webauthn.WebAuthn
}

func configure(c Config) (*settings, error) {
	u, err := url.Parse(c.Origin)
	if err != nil || u == nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Opaque != "" || (u.Scheme != "https" && !(u.Scheme == "http" && u.Hostname() == "localhost")) || c.Origin != u.Scheme+"://"+u.Host {
		return nil, errors.New("AUTH_ORIGIN must be an exact HTTPS origin (HTTP localhost is allowed for development)")
	}
	key, err := hex.DecodeString(c.EncryptionKey)
	if err != nil || len(c.EncryptionKey) != 64 || len(key) != 32 {
		return nil, errors.New("AUTH_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("cannot initialize authentication encryption")
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errors.New("cannot initialize authentication encryption")
	}
	web, err := webauthn.New(&webauthn.Config{
		RPID: u.Hostname(), RPDisplayName: "Logice", RPOrigins: []string{c.Origin},
		AuthenticatorSelection: protocol.AuthenticatorSelection{ResidentKey: protocol.ResidentKeyRequirementRequired, UserVerification: protocol.VerificationRequired},
		Timeouts: webauthn.TimeoutsConfig{
			Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: 5 * time.Minute},
			Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: 5 * time.Minute},
		},
	})
	if err != nil {
		return nil, errors.New("invalid WebAuthn configuration")
	}
	return &settings{origin: c.Origin, secure: u.Scheme == "https", aead: aead, web: web}, nil
}

func token() string {
	b := make([]byte, 32)
	// crypto/rand.Read cannot return an error on supported Go runtimes.
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
func digest(v string) []byte { h := sha256.Sum256([]byte(v)); return h[:] }
func validToken(v string) bool {
	b, err := base64.RawURLEncoding.DecodeString(v)
	return err == nil && len(b) == 32 && !strings.Contains(v, "=")
}
func (s *settings) seal(data []byte, binding string) []byte {
	nonce := make([]byte, s.aead.NonceSize())
	_, _ = rand.Read(nonce)
	return s.aead.Seal(nonce, nonce, data, []byte("logice-ceremony-v1:"+binding))
}
func (s *settings) open(data []byte, binding string) ([]byte, error) {
	n := s.aead.NonceSize()
	if len(data) < n {
		return nil, errors.New("invalid encrypted state")
	}
	return s.aead.Open(nil, data[:n], data[n:], []byte("logice-ceremony-v1:"+binding))
}

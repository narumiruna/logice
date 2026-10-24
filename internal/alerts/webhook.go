// Package alerts evaluates stored telemetry and sends bounded HTTPS notifications.
package alerts

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

type Crypto struct{ aead cipher.AEAD }

func NewCrypto(key string) (*Crypto, error) {
	raw, err := hex.DecodeString(key)
	if err != nil || len(raw) != 32 {
		return nil, errors.New("invalid encryption key")
	}
	block, err := aes.NewCipher(raw)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	return &Crypto{aead: aead}, err
}
func (c *Crypto) Seal(raw, project, id string) []byte {
	nonce := make([]byte, c.aead.NonceSize())
	_, _ = rand.Read(nonce)
	return c.aead.Seal(nonce, nonce, []byte(raw), []byte("logice-webhook-v1:"+project+":"+id))
}
func (c *Crypto) Open(raw []byte, project, id string) (string, error) {
	n := c.aead.NonceSize()
	if len(raw) < n {
		return "", errors.New("invalid destination")
	}
	plain, err := c.aead.Open(nil, raw[:n], raw[n:], []byte("logice-webhook-v1:"+project+":"+id))
	if err != nil {
		return "", errors.New("invalid destination")
	}
	return string(plain), nil
}

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}

var blockedPrefixes = []string{"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "::/96", "::ffff:0:0/96", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/23", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "ff00::/8"}

func PublicAddress(ip netip.Addr) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if !ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	if ip.Is6() && !netip.MustParsePrefix("2000::/3").Contains(ip) {
		return false
	}
	for _, raw := range blockedPrefixes {
		if netip.MustParsePrefix(raw).Contains(ip) {
			return false
		}
	}
	return true
}
func ParseDestination(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" || (u.Port() != "" && u.Port() != "443") {
		return nil, errors.New("use a public HTTPS destination on port 443")
	}
	for _, r := range u.Hostname() {
		if r > 127 || r <= 32 {
			return nil, errors.New("invalid destination hostname")
		}
	}
	return u, nil
}
func resolvePublic(ctx context.Context, resolver Resolver, host string) ([]netip.Addr, error) {
	ips, err := resolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 || len(ips) > 32 {
		return nil, errors.New("destination DNS unavailable")
	}
	for _, ip := range ips {
		if !PublicAddress(ip) {
			return nil, errors.New("destination address is not public")
		}
	}
	return ips, nil
}
func ValidateDestination(ctx context.Context, raw string) error {
	u, err := ParseDestination(raw)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_, err = resolvePublic(ctx, net.DefaultResolver, u.Hostname())
	return err
}

// Production callers cannot replace DNS or dial behavior. Tests inject them into the unexported constructor.
func newClient(resolver Resolver, dial func(context.Context, string, string) (net.Conn, error)) *http.Client {
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, TLSHandshakeTimeout: 3 * time.Second, ResponseHeaderTimeout: 3 * time.Second, MaxResponseHeaderBytes: 8 << 10, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil || port != "443" {
			return nil, errors.New("invalid destination address")
		}
		ips, err := resolvePublic(ctx, resolver, host)
		if err != nil {
			return nil, err
		}
		for _, ip := range ips {
			conn, err := dial(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
		}
		return nil, errors.New("destination connection failed")
	}}
	return &http.Client{Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func Deliver(ctx context.Context, raw, eventID string, payload []byte) (result string, retry bool) {
	if _, err := ParseDestination(raw); err != nil || len(payload) > 16<<10 {
		return "invalid_destination", false
	}
	client := newClient(net.DefaultResolver, (&net.Dialer{Timeout: 3 * time.Second}).DialContext)
	request, err := http.NewRequestWithContext(ctx, "POST", raw, strings.NewReader(string(payload)))
	if err != nil {
		return "invalid_destination", false
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Logice-Event-ID", eventID)
	response, err := client.Do(request)
	if err != nil {
		return "transport_failure", true
	}
	defer response.Body.Close()
	_, _ = io.CopyN(io.Discard, response.Body, 4096)
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return "delivered", false
	}
	if response.StatusCode == 429 || response.StatusCode >= 500 {
		return "retryable_status", true
	}
	return "rejected_status", false
}

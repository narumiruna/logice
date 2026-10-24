package alerts

import (
	"context"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type fakeResolver struct {
	ips   []netip.Addr
	calls atomic.Int32
}

func (r *fakeResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	r.calls.Add(1)
	return r.ips, nil
}
func TestPublicDestinations(t *testing.T) {
	for _, address := range []string{"127.0.0.1", "10.1.1.1", "169.254.169.254", "100.64.1.1", "198.18.1.1", "192.88.99.1", "::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "2001:db8::1", "2002:7f00:1::1", "64:ff9b::7f00:1"} {
		if PublicAddress(netip.MustParseAddr(address)) {
			t.Fatal("reserved address accepted", address)
		}
	}
	for _, address := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !PublicAddress(netip.MustParseAddr(address)) {
			t.Fatal("public address rejected", address)
		}
	}
	for _, raw := range []string{"http://example.com", "https://user:secret@example.com", "https://example.com:8080", "https://example.com/#secret", "file:///etc/passwd", "https://"} {
		if _, err := ParseDestination(raw); err == nil {
			t.Fatal("unsafe URL", raw)
		}
	}
	r := &fakeResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}}
	if _, err := resolvePublic(context.Background(), r, "example.com"); err == nil {
		t.Fatal("mixed DNS result accepted")
	}
}
func TestDestinationEncryptionBinding(t *testing.T) {
	c, err := NewCrypto(strings.Repeat("11", 32))
	if err != nil {
		t.Fatal(err)
	}
	raw := "https://example.com/private/secret?token=hidden"
	encrypted := c.Seal(raw, "project", "destination")
	if strings.Contains(string(encrypted), "secret") {
		t.Fatal("plaintext destination stored")
	}
	if value, err := c.Open(encrypted, "project", "destination"); err != nil || value != raw {
		t.Fatal("cannot decrypt")
	}
	for _, binding := range [][2]string{{"other", "destination"}, {"project", "other"}} {
		if _, err := c.Open(encrypted, binding[0], binding[1]); err == nil {
			t.Fatal("AAD boundary bypass")
		}
	}
	encrypted[len(encrypted)-1] ^= 1
	if _, err := c.Open(encrypted, "project", "destination"); err == nil {
		t.Fatal("tampered URL accepted")
	}
}
func TestHTTPSClientRechecksDNSAndRejectsRedirects(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "https://127.0.0.1/private")
			w.WriteHeader(302)
			return
		}
		_, _ = io.WriteString(w, "ok")
	}))
	defer server.Close()
	resolver := &fakeResolver{ips: []netip.Addr{netip.MustParseAddr("8.8.8.8")}}
	dialer := net.Dialer{Timeout: time.Second}
	client := newClient(resolver, func(ctx context.Context, network, address string) (net.Conn, error) {
		if address != "8.8.8.8:443" {
			t.Error("dial target not pinned", address)
		}
		return dialer.DialContext(ctx, network, server.Listener.Addr().String())
	})
	transport := client.Transport.(*http.Transport)
	if response, err := client.Post("https://example.com/untrusted", "application/json", strings.NewReader(`{}`)); err == nil {
		response.Body.Close()
		t.Fatal("untrusted TLS certificate accepted")
	}
	if requests.Load() != 0 {
		t.Fatal("untrusted TLS reached the receiver handler")
	}
	resolver.calls.Store(0)
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport.TLSClientConfig.RootCAs = roots
	// httptest's certificate is valid for example.com, with a test-only CA.
	for _, path := range []string{"/ok", "/redirect"} {
		response, err := client.Post("https://example.com"+path, "application/json", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if path == "/redirect" && response.StatusCode != 302 {
			t.Fatal("redirect followed")
		}
	}
	if requests.Load() != 2 || resolver.calls.Load() != 2 {
		t.Fatal("connections reused DNS or followed redirect", requests.Load(), resolver.calls.Load())
	}
	resolver.ips = []netip.Addr{netip.MustParseAddr("127.0.0.1")}
	if response, err := client.Post("https://example.com/rebind", "application/json", strings.NewReader(`{}`)); err == nil {
		response.Body.Close()
		t.Fatal("DNS rebinding connected")
	}
	if requests.Load() != 2 {
		t.Fatal("private destination reached")
	}
}

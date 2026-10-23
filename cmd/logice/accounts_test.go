package main

import (
	"strings"
	"testing"
)

func TestServerRequiresAuthenticationConfiguration(t *testing.T) {
	t.Setenv("AUTH_ORIGIN", "")
	t.Setenv("AUTH_ENCRYPTION_KEY", "")
	if err := run("127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "AUTH_ORIGIN") {
		t.Fatalf("server did not reject missing auth origin before startup: %v", err)
	}
	t.Setenv("AUTH_ORIGIN", "https://logice.example.test")
	t.Setenv("AUTH_ENCRYPTION_KEY", strings.Repeat("g", 64))
	if err := run("127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "AUTH_ENCRYPTION_KEY") {
		t.Fatalf("server did not reject invalid encryption key before startup: %v", err)
	}
}

func TestOperatorCommandsRequireValidConfiguration(t *testing.T) {
	t.Setenv("AUTH_ORIGIN", "https://logice.example.test")
	t.Setenv("AUTH_ENCRYPTION_KEY", "short")
	for _, command := range []string{"migrate", "bootstrap", "recover", "users"} {
		if err := accountCommand(command, nil); err == nil || !strings.Contains(err.Error(), "AUTH_ENCRYPTION_KEY") {
			t.Fatalf("%s did not validate encryption key before database access: %v", command, err)
		}
	}
	if err := accountCommand("bootstrap", []string{"--unknown"}); err == nil || !strings.Contains(err.Error(), "usage:") {
		t.Fatalf("unknown CLI flag accepted: %v", err)
	}
	if err := accountCommand("bootstrap", []string{"unexpected"}); err == nil || !strings.Contains(err.Error(), "usage:") {
		t.Fatalf("positional CLI argument accepted: %v", err)
	}
}

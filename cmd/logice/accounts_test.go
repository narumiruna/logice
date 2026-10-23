package main

import (
	"strings"
	"testing"
)

func TestServerRequiresAuthenticationConfiguration(t *testing.T) {
	t.Setenv("AUTH_ORIGIN", "")
	t.Setenv("ENCRYPTION_KEY", "")
	if err := run("127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "AUTH_ORIGIN") {
		t.Fatalf("server did not reject missing auth origin before startup: %v", err)
	}
	t.Setenv("AUTH_ORIGIN", "https://logice.example.test")
	t.Setenv("ENCRYPTION_KEY", strings.Repeat("g", 64))
	if err := run("127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "ENCRYPTION_KEY") {
		t.Fatalf("server did not reject invalid encryption key before startup: %v", err)
	}
}

func TestEncryptionKeySetting(t *testing.T) {
	t.Setenv("AUTH_ORIGIN", "https://logice.example.test")
	t.Setenv("ENCRYPTION_KEY", strings.Repeat("a", 64))
	t.Setenv("AUTH_ENCRYPTION_KEY", "")
	for _, key := range []string{"DATABASE_URL", "PGHOST", "PGUSER", "PGDATABASE"} {
		t.Setenv(key, "")
	}
	if err := run("127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "set DATABASE_URL") {
		t.Fatalf("server did not read ENCRYPTION_KEY before database setup: %v", err)
	}
	for _, command := range []string{"migrate", "bootstrap", "recover", "users"} {
		if err := accountCommand(command, nil); err == nil || !strings.Contains(err.Error(), "set DATABASE_URL") {
			t.Fatalf("%s did not read ENCRYPTION_KEY before database setup: %v", command, err)
		}
	}
	// The old name must not satisfy the required setting after the rename.
	t.Setenv("ENCRYPTION_KEY", "")
	t.Setenv("AUTH_ENCRYPTION_KEY", strings.Repeat("a", 64))
	if err := run("127.0.0.1:0"); err == nil || !strings.Contains(err.Error(), "ENCRYPTION_KEY") {
		t.Fatalf("server accepted the old encryption setting: %v", err)
	}
	if err := accountCommand("migrate", nil); err == nil || !strings.Contains(err.Error(), "ENCRYPTION_KEY") {
		t.Fatalf("CLI accepted the old encryption setting: %v", err)
	}
}

func TestOperatorCommandsRequireValidConfiguration(t *testing.T) {
	t.Setenv("AUTH_ORIGIN", "https://logice.example.test")
	t.Setenv("ENCRYPTION_KEY", "short")
	for _, command := range []string{"migrate", "bootstrap", "recover", "users"} {
		if err := accountCommand(command, nil); err == nil || !strings.Contains(err.Error(), "ENCRYPTION_KEY") {
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

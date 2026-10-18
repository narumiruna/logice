//go:build integration

package integration

import (
	"context"
	"os/exec"
	"strconv"
	"strings"
	"testing"
	"time"
)

func versionAtLeast(value string, major, minor int) bool {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(value), "v"), ".")
	if len(parts) < 2 {
		return false
	}
	gotMajor, errMajor := strconv.Atoi(parts[0])
	gotMinor, errMinor := strconv.Atoi(parts[1])
	if errMajor != nil || errMinor != nil || gotMajor < 0 || gotMinor < 0 {
		return false
	}
	return gotMajor > major || gotMajor == major && gotMinor >= minor
}

func TestMinimumToolVersions(t *testing.T) {
	for _, test := range []struct {
		value        string
		major, minor int
		want         bool
	}{
		{"27.5.1", 28, 0, false}, {"28.0.0", 28, 0, true}, {"29.7.2", 28, 0, true},
		{"v2.23.0", 2, 24, false}, {"v2.24.0", 2, 24, true}, {"v5.5.1", 2, 24, true},
		{"2.24.1-desktop.1", 2, 24, true}, {"", 28, 0, false}, {"unknown", 28, 0, false},
		{"29.bad.2", 28, 0, false}, {"-1.24.1", 2, 24, false},
	} {
		if got := versionAtLeast(test.value, test.major, test.minor); got != test.want {
			t.Errorf("versionAtLeast(%q, %d, %d) = %t, want %t", test.value, test.major, test.minor, got, test.want)
		}
	}
}

func (s *stack) checkTools() {
	s.t.Helper()
	if !versionAtLeast(s.run("version", "--short"), 2, 24) {
		s.t.Fatal("stack validation requires Docker Compose 2.24 or later")
	}
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "version", "--format", "{{.Server.Version}}")
	cmd.Env, cmd.WaitDelay = s.env, 5*time.Second
	version, err := cmd.Output()
	if err != nil {
		s.t.Fatal("query Docker Engine version:", s.redact(err.Error()))
	}
	if !versionAtLeast(string(version), 28, 0) {
		s.t.Fatal("stack validation requires Docker Engine 28 or later for loopback port isolation")
	}
}

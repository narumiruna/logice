//go:build integration

package integration

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	query "github.com/narumiruna/logice/internal/telemetry"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type stack struct {
	t                  *testing.T
	ctx                context.Context
	root               string
	project            string
	env                []string
	secrets            []string
	ports              map[string]string
	http               *http.Client
	started            bool
	applicationURL     string
	applicationToken   string
	applicationSession string
}

func randomHex(t *testing.T, size int) string {
	t.Helper()
	b := make([]byte, size)
	if _, err := rand.Read(b); err != nil {
		t.Fatal("generate random test identity:", err)
	}
	return hex.EncodeToString(b)
}

// stackWorkDeadline leaves time for failure logs (12s), Compose cleanup (40s),
// and an 18s margin before Go's suite-wide hard timeout. Each stack also keeps
// its existing 6m45s work ceiling. A later test cannot consume cleanup time.
func stackWorkDeadline(now, suiteDeadline time.Time) time.Time {
	deadline := now.Add(6*time.Minute + 45*time.Second)
	if !suiteDeadline.IsZero() && suiteDeadline.Add(-70*time.Second).Before(deadline) {
		deadline = suiteDeadline.Add(-70 * time.Second)
	}
	return deadline
}

func newStack(t *testing.T) *stack {
	t.Helper()
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("locate repository root")
	}
	now := time.Now()
	suiteDeadline, _ := t.Deadline()
	deadline := stackWorkDeadline(now, suiteDeadline)
	if !deadline.After(now) {
		t.Fatal("insufficient suite time for stack work and 70-second cleanup reserve")
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	s := &stack{
		t: t, ctx: query.WithProject(ctx, fixtureProject), root: filepath.Clean(filepath.Join(filepath.Dir(source), "../..")),
		project: "logice-validation-" + randomHex(t, 8),
		secrets: []string{randomHex(t, 24), randomHex(t, 24), randomHex(t, 24), randomHex(t, 32)},
		ports:   make(map[string]string), http: &http.Client{Timeout: 5 * time.Second},
	}
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		// Retain Docker connection settings so the selected daemon is used,
		// but do not inherit Compose files, projects, profiles, or env files.
		if strings.HasPrefix(key, "COMPOSE_") || key == "POSTGRES_PASSWORD" || key == "CLICKHOUSE_PASSWORD" || key == "OTLP_TOKEN" || key == "ENCRYPTION_KEY" || strings.HasPrefix(key, "AUTH_") {
			continue
		}
		s.env = append(s.env, entry)
	}
	s.env = append(s.env, "POSTGRES_PASSWORD="+s.secrets[0], "CLICKHOUSE_PASSWORD="+s.secrets[1], "OTLP_TOKEN="+s.secrets[2], "ENCRYPTION_KEY="+s.secrets[3], "AUTH_ORIGIN=http://localhost:5173", "COMPOSE_DISABLE_ENV_FILE=1")
	// Register before startup: partial startup and assertion failures must also clean up.
	t.Cleanup(func() {
		defer cancel()
		defer s.http.CloseIdleConnections()
		if !s.started {
			return
		}
		if t.Failed() {
			logCtx, stop := context.WithTimeout(context.Background(), 12*time.Second)
			logs, _ := s.compose(logCtx, "logs", "--no-color", "--tail", "60")
			stop()
			t.Log("sanitized Compose logs:\n" + s.redact(logs))
		}
		cleanupCtx, stop := context.WithTimeout(context.Background(), 40*time.Second)
		defer stop()
		if out, err := s.compose(cleanupCtx, "down", "--volumes", "--remove-orphans", "--timeout", "5"); err != nil {
			t.Errorf("clean up project %s: %s: %s", s.project, s.redact(err.Error()), s.redact(out))
		}
	})
	s.checkTools()
	s.checkConfig()
	t.Log("start isolated Compose project", s.project)
	// Collector has no image healthcheck. Do not use --wait as a substitute
	// for the explicit HTTP readiness check below.
	s.started = true
	s.run("up", "--detach", "postgres", "clickhouse", "collector")
	s.checkBindings()
	s.refreshPorts()
	s.eventually("Collector health endpoint", 60*time.Second, func(ctx context.Context) error {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+s.ports["health"]+"/", nil)
		if err != nil {
			return err
		}
		res, err := s.http.Do(req)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			return fmt.Errorf("health HTTP status %d", res.StatusCode)
		}
		return nil
	})
	s.setupProjects()
	return s
}

func (s *stack) refreshPorts() {
	s.t.Helper()
	// Docker can assign new ephemeral host ports when a container restarts.
	for key, target := range map[string]struct {
		service string
		port    string
	}{
		"postgres": {"postgres", "5432"}, "clickhouse": {"clickhouse", "9000"},
		"http": {"collector", "4318"}, "grpc": {"collector", "4317"}, "health": {"collector", "13133"},
	} {
		address := strings.TrimSpace(s.run("port", target.service, target.port))
		host, _, err := net.SplitHostPort(address)
		if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
			s.t.Fatalf("%s is not bound only to a loopback address: %q", key, address)
		}
		s.ports[key] = address
	}
}

func (s *stack) redact(text string) string {
	for _, secret := range s.secrets {
		text = strings.ReplaceAll(text, secret, "[REDACTED]")
	}
	return text
}

func (s *stack) compose(ctx context.Context, args ...string) (string, error) {
	return s.composeEnv(ctx, s.env, args...)
}

func (s *stack) composeEnv(ctx context.Context, env []string, args ...string) (string, error) {
	args = append([]string{"compose", "--project-name", s.project, "--file", filepath.Join(s.root, "compose.yaml"), "--file", filepath.Join(s.root, "tests/integration/collector-ports.yaml")}, args...)
	cmd := exec.CommandContext(ctx, "docker", args...)
	cmd.Dir, cmd.Env, cmd.WaitDelay = s.root, env, 5*time.Second
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	err := cmd.Run()
	return s.redact(output.String()), err
}

func (s *stack) run(args ...string) string {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, 180*time.Second)
	defer cancel()
	out, err := s.compose(ctx, args...)
	if err != nil {
		s.t.Fatalf("docker compose %s: %s\n%s", strings.Join(args, " "), s.redact(err.Error()), out)
	}
	return out
}

func (s *stack) eventually(label string, timeout time.Duration, check func(context.Context) error) {
	s.t.Helper()
	ctx, cancel := context.WithTimeout(s.ctx, timeout)
	defer cancel()
	var last error
	for {
		attempt, stop := context.WithTimeout(ctx, 5*time.Second)
		last = check(attempt)
		stop()
		if last == nil {
			return
		}
		select {
		case <-ctx.Done():
			s.t.Fatalf("%s did not become ready: %s", label, s.redact(last.Error()))
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func (s *stack) checkBindings() {
	s.t.Helper()
	ids := strings.Fields(s.run("ps", "--all", "--quiet"))
	if len(ids) != 3 {
		s.t.Fatalf("expected exactly three project containers, got %d", len(ids))
	}
	ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", append([]string{"inspect"}, ids...)...)
	cmd.WaitDelay = 5 * time.Second
	out, err := cmd.Output()
	if err != nil {
		s.t.Fatal("inspect isolated project containers:", s.redact(err.Error()))
	}
	var containers []struct {
		Config          struct{ Labels map[string]string }
		NetworkSettings struct {
			Ports map[string][]struct{ HostIP, HostPort string }
		}
	}
	if err := json.Unmarshal(out, &containers); err != nil {
		s.t.Fatal("decode container port bindings:", err)
	}
	count := 0
	for _, container := range containers {
		if container.Config.Labels["com.docker.compose.project"] != s.project {
			s.t.Fatal("container does not belong to this test project")
		}
		for _, bindings := range container.NetworkSettings.Ports {
			for _, binding := range bindings {
				ip := net.ParseIP(binding.HostIP)
				if ip == nil || !ip.IsLoopback() || binding.HostPort == "" {
					s.t.Fatal("published container port is not restricted to loopback")
				}
				count++
			}
		}
	}
	if count != 5 {
		s.t.Fatalf("expected five random loopback port bindings, got %d", count)
	}
}

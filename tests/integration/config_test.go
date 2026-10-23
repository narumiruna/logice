//go:build integration

package integration

import (
	"context"
	"encoding/json"
	"net"
	"strings"
	"time"
)

func (s *stack) checkConfig() {
	s.t.Helper()
	s.t.Log("verify required credentials and isolated random loopback bindings")
	for _, key := range []string{"POSTGRES_PASSWORD", "CLICKHOUSE_PASSWORD", "OTLP_TOKEN", "ENCRYPTION_KEY"} {
		var env []string
		for _, entry := range s.env {
			if !strings.HasPrefix(entry, key+"=") {
				env = append(env, entry)
			}
		}
		ctx, cancel := context.WithTimeout(s.ctx, 10*time.Second)
		_, err := s.composeEnv(ctx, env, "config", "--quiet")
		cancel()
		if err == nil {
			s.t.Fatalf("Compose accepted missing required credential %s", key)
		}
	}
	var config struct {
		Services map[string]struct {
			ContainerName string `json:"container_name"`
			NetworkMode   string `json:"network_mode"`
			Ports         []struct {
				HostIP    string `json:"host_ip"`
				Published string `json:"published"`
				Target    int    `json:"target"`
			}
		}
		Volumes map[string]struct {
			Name     string
			External bool
		}
		Networks map[string]struct {
			Name     string
			External bool
		}
	}
	// Parse only selected fields. Never log the rendered configuration,
	// because it contains environment credentials.
	s.must("decode Compose config", json.Unmarshal([]byte(s.run("config", "--format", "json")), &config))
	if len(config.Services) != 6 {
		s.t.Fatal("expected api, migrate, web, postgres, clickhouse, and collector services")
	}
	api, hasAPI := config.Services["api"]
	web, hasWeb := config.Services["web"]
	if !hasAPI || !hasWeb || len(api.Ports) != 0 || len(web.Ports) != 1 {
		s.t.Fatal("only the web service may publish an application port")
	}
	if api.ContainerName != "" || api.NetworkMode != "" || web.ContainerName != "" || web.NetworkMode != "" {
		s.t.Fatal("application services must use project-scoped container names and networks")
	}
	if port := web.Ports[0]; port.HostIP != "127.0.0.1" || port.Published != "5173" || port.Target != 8080 {
		s.t.Fatal("web must publish container port 8080 on 127.0.0.1:5173")
	}
	for service, ports := range map[string][]int{"postgres": {5432}, "clickhouse": {9000}, "collector": {4317, 4318, 13133}} {
		definition, exists := config.Services[service]
		if !exists || definition.ContainerName != "" || definition.NetworkMode != "" {
			s.t.Fatalf("%s must use project-scoped container names and networks", service)
		}
		if len(definition.Ports) != len(ports) {
			s.t.Fatalf("unexpected published ports for %s", service)
		}
		for _, port := range definition.Ports {
			ip := net.ParseIP(port.HostIP)
			if ip == nil || !ip.IsLoopback() || (port.Published != "" && port.Published != "0") {
				s.t.Fatalf("%s ports must use random loopback host bindings", service)
			}
			found := false
			for _, expected := range ports {
				found = found || port.Target == expected
			}
			if !found {
				s.t.Fatalf("unexpected target port for %s", service)
			}
		}
	}
	if len(config.Volumes) != 2 || len(config.Networks) != 1 {
		s.t.Fatal("expected two project volumes and one project network")
	}
	for _, volume := range config.Volumes {
		if volume.External || !strings.HasPrefix(volume.Name, s.project+"_") {
			s.t.Fatal("database volumes must belong only to this test project")
		}
	}
	for _, network := range config.Networks {
		if network.External || !strings.HasPrefix(network.Name, s.project+"_") {
			s.t.Fatal("network must belong only to this test project")
		}
	}
}

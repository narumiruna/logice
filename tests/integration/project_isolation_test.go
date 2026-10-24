//go:build integration

package integration

import (
	"bytes"
	"compress/gzip"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/narumiruna/logice/internal/auth"
	query "github.com/narumiruna/logice/internal/telemetry"
	trace "go.opentelemetry.io/proto/otlp/trace/v1"
	"google.golang.org/protobuf/proto"
)

func TestProjectOTLPIsolation(t *testing.T) {
	s := newStack(t)
	_, db := s.databases()
	request := func(method, path string, body []byte, headers http.Header, session bool) (int, []byte) {
		t.Helper()
		r, err := http.NewRequestWithContext(s.ctx, method, s.applicationURL+path, bytes.NewReader(body))
		s.must("create project request", err)
		r.Header = headers.Clone()
		if session {
			r.AddCookie(&http.Cookie{Name: "logice-dev-session", Value: s.applicationSession})
		}
		res, err := s.http.Do(r)
		s.must("send project request", err)
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		s.must("read project response", err)
		return res.StatusCode, data
	}
	manage := func(path, payload string) []byte {
		t.Helper()
		r, err := http.NewRequestWithContext(s.ctx, "GET", s.applicationURL+"/api/auth/csrf", nil)
		s.must("create csrf request", err)
		res, err := s.http.Do(r)
		s.must("get csrf", err)
		var csrf struct {
			Token string `json:"csrfToken"`
		}
		s.must("read csrf", json.NewDecoder(res.Body).Decode(&csrf))
		_ = res.Body.Close()
		cookie := res.Cookies()[0]
		headers := http.Header{"Content-Type": {"application/json"}, "Origin": {"http://localhost:5173"}, "X-Csrf-Token": {csrf.Token}, "Cookie": {cookie.Name + "=" + cookie.Value}}
		status, body := request("POST", path, []byte(payload), headers, true)
		if status != 201 {
			t.Fatal("management status", status)
		}
		return body
	}
	var second auth.Project
	s.must("decode second project", json.Unmarshal(manage("/api/projects", `{"name":"Second"}`), &second))
	var secondToken auth.ProjectToken
	s.must("decode second token", json.Unmarshal(manage("/api/projects/"+second.ID+"/tokens", `{"name":"Second app"}`), &secondToken))
	s.secrets = append(s.secrets, secondToken.Token)
	fixture := newTelemetry(t)
	traceID := hex.EncodeToString(fixture.traceID)
	for _, spec := range []struct{ id, token, name string }{{fixtureProject, s.applicationToken, "first"}, {second.ID, secondToken.Token, "second"}} {
		tr := traceRequest(fixture.span(spec.name, fixture.parentID, nil), fixture.span(spec.name+" child", fixture.childID, fixture.parentID))
		tr.ResourceSpans[0].Resource.Attributes = append(tr.ResourceSpans[0].Resource.Attributes, textAttr("logice.project.id", second.ID), textAttr("logice.project.id", second.ID))
		for _, span := range tr.ResourceSpans[0].ScopeSpans[0].Spans {
			span.Attributes = append(span.Attributes, textAttr("logice.project.id", second.ID), textAttr("logice.project.id", second.ID))
		}
		logs := fixture.logRequest()
		logs.ResourceLogs[0].ScopeLogs[0].LogRecords[0].Attributes = append(logs.ResourceLogs[0].ScopeLogs[0].LogRecords[0].Attributes, textAttr("logice.project.id", second.ID))
		logs.ResourceLogs[0].Resource.Attributes = append(logs.ResourceLogs[0].Resource.Attributes, textAttr("logice.project.id", second.ID))
		// Multiple resources, gzip, resource spoofing, and duplicate/case-variant headers.
		tr.ResourceSpans = append(tr.ResourceSpans, proto.Clone(tr.ResourceSpans[0]).(*trace.ResourceSpans))
		for _, signal := range []struct {
			path string
			body proto.Message
		}{{"/v1/traces", tr}, {"/v1/logs", logs}} {
			data, err := proto.Marshal(signal.body)
			s.must("encode compressed export", err)
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, err = writer.Write(data)
			s.must("compress export", err)
			s.must("finish compressed export", writer.Close())
			headers := http.Header{"Content-Type": {"application/x-protobuf"}, "Content-Encoding": {"gzip"}, "Authorization": {"Bearer " + spec.token}, "X-Logice-Project-Id": {second.ID, fixtureProject}, "x-logice-project-id": {"forged"}, "Connection": {"X-Logice-Project-Id"}}
			status, _ := request("POST", signal.path, compressed.Bytes(), headers, false)
			if status != 200 {
				t.Fatal("compressed export status", status)
			}
		}
	}
	s.waitCount(db, "otel_traces", traceID, 8)
	s.waitCount(db, "otel_logs", traceID, 2)
	window := "?from=" + fixture.start.Add(-time.Second).Format(time.RFC3339Nano) + "&to=" + fixture.start.Add(time.Second).Format(time.RFC3339Nano)
	for _, spec := range []struct{ id, name string }{{fixtureProject, "first"}, {second.ID, "second"}} {
		base := "/api/projects/" + spec.id
		for _, path := range []string{"/traces", "/logs", "/traces/" + traceID, "/live"} {
			status, body := request("GET", base+path+window, nil, http.Header{}, true)
			if status != 200 {
				t.Fatal("scoped query status", path, status)
			}
			if path == "/traces" || strings.HasPrefix(path, "/traces/") {
				other := "first"
				if spec.name == other {
					other = "second"
				}
				if bytes.Contains(body, []byte(other)) {
					t.Fatal("cross-project span read")
				}
			}
			if strings.HasPrefix(path, "/traces/") {
				var detail query.TraceDetail
				s.must("decode scoped detail", json.Unmarshal(body, &detail))
				for _, span := range detail.Spans {
					if _, exists := span.Attributes["logice.project.id"]; exists {
						t.Fatal("reserved duplicate span attribute survived")
					}
				}
			}
			if path == "/logs" {
				var records query.LogList
				s.must("decode scoped logs", json.Unmarshal(body, &records))
				for _, record := range records.Items {
					if _, exists := record.Attributes["logice.project.id"]; exists {
						t.Fatal("reserved duplicate log attribute survived")
					}
				}
			}
			if path == "/live" {
				var live query.LiveSnapshot
				s.must("decode scoped live", json.Unmarshal(body, &live))
				if len(live.Spans) != 2 || len(live.Logs) != 1 {
					t.Fatal("live row isolation")
				}
				var spans, logs int
				for _, b := range live.Histogram {
					if b.Spans == "4" {
						spans++
					}
					if b.Logs == "1" {
						logs++
					}
				}
				if spans != 1 || logs != 1 {
					t.Fatal("histogram scope")
				}
				for _, span := range live.Spans {
					if !strings.HasPrefix(span.ID, "span:"+spec.id+":") {
						t.Fatal("live identity scope")
					}
				}
			}
		}
		status, body := request("GET", base+"/live"+window+"&search="+spec.name+"%20child", nil, http.Header{}, true)
		if status != 200 {
			t.Fatal("context status", status)
		}
		var live query.LiveSnapshot
		s.must("decode context", json.Unmarshal(body, &live))
		if len(live.Spans) != 1 || len(live.Context) != 1 || live.Context[0].Name != spec.name {
			t.Fatal("context crossed project")
		}
	}
	// Correct infrastructure auth without trusted metadata cannot write resource spoofing.
	missing := newTelemetry(t)
	data, err := proto.Marshal(traceRequest(missing.span("must-drop", missing.parentID, nil)))
	s.must("encode missing metadata", err)
	r, err := http.NewRequestWithContext(s.ctx, "POST", "http://"+s.ports["http"]+"/v1/traces", bytes.NewReader(data))
	s.must("build private export", err)
	r.Header.Set("Authorization", "Bearer "+s.secrets[2])
	r.Header.Set("Content-Type", "application/x-protobuf")
	res, err := s.http.Do(r)
	s.must("send unscoped private export", err)
	_ = res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal("unexpected missing-metadata response", res.StatusCode)
	}
	time.Sleep(1500 * time.Millisecond)
	count, err := s.count(db, "otel_traces", hex.EncodeToString(missing.traceID))
	s.must("count missing-metadata export", err)
	if count != 0 {
		t.Fatal("unscoped telemetry persisted")
	}
	// A compressed request cannot bypass the receiver's decoded body bound.
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, err = writer.Write(make([]byte, 9<<20))
	s.must("compress oversized input", err)
	s.must("finish oversized input", writer.Close())
	status, _ := request("POST", "/v1/traces", compressed.Bytes(), http.Header{"Content-Type": {"application/x-protobuf"}, "Content-Encoding": {"gzip"}, "Authorization": {"Bearer " + s.applicationToken}}, false)
	if status < 400 || status >= 500 {
		t.Fatal("receiver decoded size bound", status)
	}
	// Legacy query URLs have no default project; application tokens cannot query.
	status, _ = request("GET", "/api/traces", nil, http.Header{}, true)
	if status != 404 {
		t.Fatal("legacy fallback", status)
	}
	status, _ = request("GET", "/api/projects/"+fixtureProject+"/traces", nil, http.Header{"Authorization": {"Bearer " + s.applicationToken}}, false)
	if status != 401 {
		t.Fatal("token granted read access", status)
	}
}

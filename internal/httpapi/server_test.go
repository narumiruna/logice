package httpapi

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"
)

const testWait = 3 * time.Second

func TestServerTimeoutProtections(t *testing.T) {
	server := NewServer()
	if server.Handler == nil {
		t.Fatal("server has no handler")
	}
	if server.ReadHeaderTimeout != 5*time.Second || server.ReadTimeout != 10*time.Second ||
		server.WriteTimeout != 15*time.Second || server.IdleTimeout != 60*time.Second ||
		server.MaxHeaderBytes != 16<<10 {
		t.Fatalf("unexpected server protections: %+v", server)
	}
	if shutdownTimeout != 5*time.Second {
		t.Fatalf("shutdown timeout = %s, want 5s", shutdownTimeout)
	}
}

func TestRunGracefulCancellation(t *testing.T) {
	service := startService(t, nil, nil, time.Second)
	result := awaitRequest(t, service.request(context.Background()))
	if result.err != nil || result.status != http.StatusOK || result.body != "{\"status\":\"ok\"}\n" {
		t.Fatalf("health request: %+v", result)
	}
	service.cancel()
	if err := service.wait(t); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := service.listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Accept after cancellation = %v, want net.ErrClosed", err)
	}
}

func TestRunDrainsActiveRequest(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	canceled := make(chan struct{})
	finished := make(chan struct{})
	service := startService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(finished)
		close(started)
		select {
		case <-release:
			_, _ = io.WriteString(w, "drained")
		case <-r.Context().Done():
			close(canceled)
		}
	}), nil, time.Second)
	request := service.request(context.Background())
	await(t, started, "handler start")
	service.cancel()
	await(t, service.listener.closed, "listener close")
	select {
	case <-service.done:
		t.Fatal("Run returned before the active request drained")
	case <-canceled:
		t.Fatal("graceful shutdown canceled the active request")
	default:
	}
	close(release)
	result := awaitRequest(t, request)
	if result.err != nil || result.status != http.StatusOK || result.body != "drained" {
		t.Fatalf("drained request: %+v", result)
	}
	if err := service.wait(t); err != nil {
		t.Fatalf("Run: %v", err)
	}
	await(t, finished, "handler exit")
}

func TestRunForcesCloseOnShutdownDeadline(t *testing.T) {
	started := make(chan struct{})
	canceled := make(chan struct{})
	finished := make(chan struct{})
	service := startService(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		defer close(finished)
		close(started)
		// Forced Close must cancel this context, not only stop accepting.
		<-r.Context().Done()
		close(canceled)
	}), nil, 50*time.Millisecond)
	request := service.request(context.Background())
	await(t, started, "handler start")
	service.cancel()
	if err := service.wait(t); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Run = %v, want shutdown deadline error", err)
	}
	await(t, canceled, "forced request cancellation")
	await(t, finished, "handler exit")
	if result := awaitRequest(t, request); result.err == nil {
		t.Fatalf("forced-close request unexpectedly succeeded: %+v", result)
	}
}

func TestRunRequestCancellation(t *testing.T) {
	started := make(chan struct{})
	finished := make(chan struct{})
	service := startService(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(finished)
	}), nil, time.Second)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request := service.request(ctx)
	await(t, started, "handler start")
	cancel()
	await(t, finished, "request context cancellation")
	if result := awaitRequest(t, request); !errors.Is(result.err, context.Canceled) {
		t.Fatalf("request error = %v, want context.Canceled", result.err)
	}
	// Canceling a client request must not stop the server.
	select {
	case <-service.done:
		t.Fatalf("Run exited after client cancellation: %v", service.err)
	default:
	}
	service.cancel()
	if err := service.wait(t); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

func TestRunClosedListenerError(t *testing.T) {
	listener := loopbackListener(t)
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	service := startService(t, nil, listener, time.Second)
	if err := service.wait(t); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Run = %v, want closed-listener error", err)
	}
	await(t, service.listener.closed, "listener close")
}

func TestRunListenerErrorCancelsActiveRequest(t *testing.T) {
	wantErr := errors.New("injected listener failure")
	listener := &failingListener{
		Listener: loopbackListener(t),
		fail:     make(chan struct{}),
		closed:   make(chan struct{}),
		err:      wantErr,
	}
	started := make(chan struct{})
	finished := make(chan struct{})
	service := startService(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(finished)
	}), listener, time.Second)
	request := service.request(context.Background())
	await(t, started, "handler start")
	close(listener.fail)
	if err := service.wait(t); !errors.Is(err, wantErr) {
		t.Fatalf("Run = %v, want listener failure", err)
	}
	await(t, service.listener.closed, "listener close")
	await(t, finished, "handler exit after listener failure")
	if result := awaitRequest(t, request); result.err == nil {
		t.Fatalf("request unexpectedly succeeded: %+v", result)
	}
}

func TestRunAlreadyCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	listener := loopbackListener(t)
	if err := Run(ctx, NewServer(), listener); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if _, err := listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Accept after cancellation = %v, want net.ErrClosed", err)
	}
}

func TestRunRepeatedCancellationJoinsGoroutines(t *testing.T) {
	// Join every request and Run goroutine explicitly instead of comparing the
	// process-wide goroutine count, which includes unrelated net/http work.
	for range 20 {
		started := make(chan struct{})
		finished := make(chan struct{})
		service := startService(t, http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
			close(started)
			<-r.Context().Done()
			close(finished)
		}), nil, time.Millisecond)
		request := service.request(context.Background())
		await(t, started, "handler start")
		service.cancel()
		if err := service.wait(t); !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Run = %v, want shutdown deadline error", err)
		}
		await(t, finished, "handler exit")
		if result := awaitRequest(t, request); result.err == nil {
			t.Fatal("forced-close request unexpectedly succeeded")
		}
	}
}

type testService struct {
	listener *observedListener
	client   *http.Client
	cancel   context.CancelFunc
	done     chan struct{}
	err      error // Read only after done closes.
}

func startService(t *testing.T, handler http.Handler, listener net.Listener, timeout time.Duration) *testService {
	t.Helper()
	if listener == nil {
		listener = loopbackListener(t)
	}
	server := NewServer()
	if handler != nil {
		server.Handler = handler
	}
	ctx, cancel := context.WithCancel(context.Background())
	service := &testService{
		listener: &observedListener{Listener: listener, closed: make(chan struct{})},
		client:   &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: testWait},
		cancel:   cancel,
		done:     make(chan struct{}),
	}
	go func() {
		service.err = run(ctx, server, service.listener, timeout)
		close(service.done)
	}()
	t.Cleanup(func() {
		cancel()
		service.wait(t)
		service.client.CloseIdleConnections()
	})
	return service
}

func (s *testService) wait(t *testing.T) error {
	t.Helper()
	await(t, s.done, "Run exit")
	return s.err
}

type requestResult struct {
	status int
	body   string
	err    error
}

func (s *testService) request(ctx context.Context) <-chan requestResult {
	result := make(chan requestResult, 1)
	go func() {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+s.listener.Addr().String()+"/api/healthz", nil)
		if err != nil {
			result <- requestResult{err: err}
			return
		}
		response, err := s.client.Do(request)
		if err != nil {
			result <- requestResult{err: err}
			return
		}
		defer response.Body.Close()
		body, err := io.ReadAll(response.Body)
		result <- requestResult{status: response.StatusCode, body: string(body), err: err}
	}()
	return result
}

func loopbackListener(t *testing.T) net.Listener {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener
}

func await(t *testing.T, done <-chan struct{}, operation string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(testWait):
		t.Fatalf("timed out waiting for %s", operation)
	}
}

func awaitRequest(t *testing.T, result <-chan requestResult) requestResult {
	t.Helper()
	select {
	case value := <-result:
		return value
	case <-time.After(testWait):
		t.Fatal("timed out waiting for request exit")
		return requestResult{}
	}
}

type observedListener struct {
	net.Listener
	closed chan struct{}
	once   sync.Once
}

func (l *observedListener) Close() error {
	err := l.Listener.Close()
	l.once.Do(func() { close(l.closed) })
	return err
}

// failingListener accepts one real connection, then returns an injected error.
// Closing it also releases a pending Accept, including on test failure.
type failingListener struct {
	net.Listener
	fail     chan struct{}
	closed   chan struct{}
	once     sync.Once
	accepted bool
	err      error
}

func (l *failingListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return l.Listener.Accept()
	}
	select {
	case <-l.fail:
		return nil, l.err
	case <-l.closed:
		return nil, net.ErrClosed
	}
}

func (l *failingListener) Close() error {
	l.once.Do(func() { close(l.closed) })
	return l.Listener.Close()
}

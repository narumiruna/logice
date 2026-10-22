package httpapi

import (
	"context"
	"errors"
	"net"
	"net/http"
	"time"

	"github.com/narumiruna/logice/internal/telemetry"
)

const shutdownTimeout = 5 * time.Second

// NewServer returns the API server without opening a socket.
func NewServer(reader ...telemetry.Reader) *http.Server {
	return &http.Server{
		Handler:           newHandler(reader...),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    16 << 10,
	}
}

// Run takes ownership of listener and serves until cancellation or a server error.
// Cancellation allows requests to drain for up to five seconds. On timeout,
// connections are closed, which cancels active request contexts. Handlers must
// observe those contexts to stop their work. Run always joins its Serve goroutine.
func Run(ctx context.Context, server *http.Server, listener net.Listener) error {
	return run(ctx, server, listener, shutdownTimeout)
}

func run(ctx context.Context, server *http.Server, listener net.Listener, timeout time.Duration) error {
	served := make(chan error, 1)
	go func() {
		served <- server.Serve(listener)
	}()

	select {
	case err := <-served:
		// A listener failure must also stop any requests already in progress.
		return errors.Join(serveError(err), server.Close())
	case <-ctx.Done():
	}

	// The signal context is already canceled; give draining its own deadline.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	err := server.Shutdown(shutdownCtx)
	if err != nil {
		err = errors.Join(err, server.Close())
	}
	return errors.Join(err, serveError(<-served))
}

func serveError(err error) error {
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

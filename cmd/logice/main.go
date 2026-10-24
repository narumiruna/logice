package main

import (
	"context"
	"errors"
	"flag"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/narumiruna/logice/internal/auth"
	"github.com/narumiruna/logice/internal/httpapi"
	"github.com/narumiruna/logice/internal/telemetry"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "migrate" || os.Args[1] == "bootstrap" || os.Args[1] == "recover" || os.Args[1] == "users") {
		if err := accountCommand(os.Args[1], os.Args[2:]); err != nil {
			log.Print(err)
			os.Exit(1)
		}
		return
	}
	listen := flag.String("listen", "127.0.0.1:8080", "HTTP listen address")
	flag.Parse()
	if err := run(*listen); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func run(address string) error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Validate trusted configuration before opening any listener or using storage.
	authConfig := auth.Config{Origin: os.Getenv("AUTH_ORIGIN"), EncryptionKey: os.Getenv("ENCRYPTION_KEY")}
	if _, err := auth.New(authConfig, nil); err != nil {
		return err
	}
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	pool, err := auth.Open(startup, os.Getenv("DATABASE_URL"))
	if err != nil {
		cancel()
		return err
	}
	defer pool.Close()
	err = auth.Ready(startup, pool)
	cancel()
	if err != nil {
		return err
	}
	accounts, err := auth.New(authConfig, pool)
	if err != nil {
		return err
	}
	if err := accounts.ConfigureIngestion(os.Getenv("COLLECTOR_URL"), os.Getenv("OTLP_TOKEN")); err != nil {
		return err
	}
	// Cleanup is bounded and joined on shutdown; request-time expiry remains authoritative.
	cleanupCtx, cleanupCancel := context.WithCancel(ctx)
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		ticker := time.NewTicker(5 * time.Minute)
		defer ticker.Stop()
		for {
			cleanup, done := context.WithTimeout(cleanupCtx, 5*time.Second)
			if err := auth.Cleanup(cleanup, pool); err != nil && cleanupCtx.Err() == nil {
				log.Print("authentication cleanup failed")
			}
			done()
			select {
			case <-cleanupCtx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	defer func() { cleanupCancel(); <-cleanupDone }()

	var reader telemetry.Reader
	if storageAddress := os.Getenv("CLICKHOUSE_ADDR"); storageAddress != "" {
		store, err := telemetry.Open(storageAddress, os.Getenv("CLICKHOUSE_PASSWORD"))
		if err != nil {
			return errors.New("could not configure telemetry storage")
		}
		defer store.Close()
		reader = store
	}

	listener, err := net.Listen("tcp", address)
	if err != nil {
		return err
	}
	server := httpapi.NewServer(reader)
	server.Handler = accounts.Wrap(server.Handler)
	return httpapi.Run(ctx, server, listener)
}

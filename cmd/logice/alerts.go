package main

import (
	"context"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/narumiruna/logice/internal/alerts"
	"github.com/narumiruna/logice/internal/auth"
	"github.com/narumiruna/logice/internal/telemetry"
)

func alertWorkerCommand(args []string) error {
	if len(args) != 0 {
		return errors.New("alerts-worker takes no arguments")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	crypto, err := alerts.NewCrypto(os.Getenv("ENCRYPTION_KEY"))
	if err != nil {
		return errors.New("alert worker encryption configuration invalid")
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
	if os.Getenv("CLICKHOUSE_ADDR") == "" {
		return errors.New("alert worker requires ClickHouse")
	}
	store, err := telemetry.Open(os.Getenv("CLICKHOUSE_ADDR"), os.Getenv("CLICKHOUSE_PASSWORD"))
	if err != nil {
		return errors.New("alert worker storage configuration invalid")
	}
	defer store.Close()
	worker := alerts.Worker{Pool: pool, Reader: store, Crypto: crypto}
	return worker.Run(ctx)
}

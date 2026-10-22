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

	"github.com/narumiruna/logice/internal/httpapi"
	"github.com/narumiruna/logice/internal/telemetry"
)

func main() {
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
	return httpapi.Run(ctx, httpapi.NewServer(reader), listener)
}

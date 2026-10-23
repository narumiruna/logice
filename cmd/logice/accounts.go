package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"github.com/narumiruna/logice/internal/auth"
)

// accountCommand is local operator access through the database, never an HTTP endpoint.
func accountCommand(command string, args []string) error {
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	name := flags.String("name", "", "account display name")
	user := flags.String("user", "", "account UUID")
	if flags.Parse(args) != nil || flags.NArg() != 0 {
		return errors.New("usage: logice migrate | bootstrap -name NAME | recover -user UUID | users")
	}
	// Validate the same key/origin used by the server before any database mutation.
	if _, err := auth.New(auth.Config{Origin: os.Getenv("AUTH_ORIGIN"), EncryptionKey: os.Getenv("AUTH_ENCRYPTION_KEY")}, nil); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := auth.Open(ctx, os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	defer pool.Close()
	if command == "migrate" {
		if auth.Migrate(ctx, pool) != nil {
			return errors.New("authentication migration failed")
		}
		fmt.Fprintln(os.Stdout, "Authentication migration complete.")
		return nil
	}
	if err = auth.Ready(ctx, pool); err != nil {
		return err
	}
	var invitation auth.Invitation
	switch command {
	case "bootstrap":
		invitation, err = auth.Bootstrap(ctx, pool, *name)
	case "recover":
		invitation, err = auth.Recover(ctx, pool, *user)
	case "users":
		rows, e := pool.Query(ctx, "SELECT id::text,name,admin,active FROM auth_users ORDER BY created_at,id")
		if e != nil {
			return errors.New("cannot list accounts")
		}
		defer rows.Close()
		for rows.Next() {
			var id, name string
			var admin, active bool
			if rows.Scan(&id, &name, &admin, &active) != nil {
				return errors.New("cannot read account")
			}
			if json.NewEncoder(os.Stdout).Encode(map[string]any{"id": id, "name": name, "admin": admin, "active": active}) != nil {
				return errors.New("cannot write account list")
			}
		}
		if rows.Err() != nil {
			return errors.New("cannot list accounts")
		}
		return nil
	default:
		return errors.New("unknown account command")
	}
	if err != nil {
		// Errors can include database fields and statements. Keep operational failures generic.
		return errors.New("account operation failed; check the account name/ID, migration state, and whether bootstrap was already performed")
	}
	// Intentional operator-only secret output. Never emit invitation tokens to application logs.
	return json.NewEncoder(os.Stdout).Encode(invitation)
}

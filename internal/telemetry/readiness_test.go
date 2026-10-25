package telemetry

import (
	"context"
	"database/sql/driver"
	"errors"
	"testing"
)

func TestStorageReadiness(t *testing.T) {
	for _, unavailable := range []bool{false, true} {
		store := testStore(t, func(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
			if query != "SELECT 1" || len(args) != 0 {
				t.Fatal("readiness accessed application data")
			}
			if unavailable {
				return nil, errors.New("storage unavailable")
			}
			return rows([]driver.Value{int64(1)}), nil
		})
		if err := store.Ready(context.Background()); (err != nil) != unavailable {
			t.Fatalf("readiness error=%v unavailable=%v", err, unavailable)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if store.Ready(ctx) == nil {
			t.Fatal("cancelled readiness succeeded")
		}
	}
}

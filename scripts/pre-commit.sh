#!/bin/sh
set -eu

cd "$(dirname "$0")/.."

npm run ci
if [ -f go.mod ]; then
  test -z "$(gofmt -l tests/integration/*.go)"
  go vet ./...
  go vet -tags=integration ./tests/integration/...
  go test ./...
fi

#!/bin/sh
# Go-only checks: no Node.js, frontend output, or running services required.
set -eu
cd "$(dirname "$0")/.."

unformatted=$(find cmd internal tests -type f -name '*.go' -exec gofmt -l {} +)
if [ -n "$unformatted" ]; then
  printf 'Go files require formatting:\n%s\n' "$unformatted" >&2
  exit 1
fi
timeout --kill-after=5s 300 go vet ./...
timeout --kill-after=5s 300 go vet -tags=integration ./tests/integration/...
timeout --kill-after=5s 180 go test -count=1 -timeout=2m ./...
build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
timeout --kill-after=5s 180 go build -o "$build_dir/logice" ./cmd/logice

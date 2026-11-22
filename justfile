test:
    #!/bin/sh
    failed=0
    run() {
        printf '\n> %s\n' "$*"
        if ! "$@"; then
            printf 'Failed: %s\n' "$*" >&2
            failed=1
        fi
    }

    run go test -count=1 -timeout=2m ./...
    run npm --prefix web test
    run uv run --project examples/python --locked python -m unittest discover -s examples/python -v
    run uv run charts/logice/tests/check.py
    run uv run tests/deployment/check.py
    run uv run tests/release/check.py
    run sh scripts/validate-checks.sh
    run sh scripts/validate-web-layout.sh
    run go test -race -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
    run go test -race -tags=integration -count=1 -timeout=8m -v ./internal/auth/...
    run timeout --kill-after=60s 600 sh scripts/validate-compose-web.sh

    exit "$failed"

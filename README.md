# Logice

A self-hosted observability platform under development, with a Go backend, React/TypeScript frontend, PostgreSQL application data, and ClickHouse telemetry.

**Current status:** a loopback-only Go development server, a React application shell, and a real-service ingestion proof. Authentication, telemetry query APIs, the trace explorer, browser workflow tests, and a production deployment image are not implemented.

## Design

- [Stack decisions and operating targets](docs/stack.md)
- [Authentication and Pocket ID design](docs/authentication.md)
- [Dependency-ordered implementation sequence](docs/implementation.md)
- [Validation commands, evidence, and limitations](docs/validation.md)
- [Current tracked plan](docs/plans/2026-10-18_logice-stack-plan.md)

## Verify the stack

Requirements: a local Docker Engine 28 or later with Compose 2.24 or later, Go 1.26 or later, and network access to pull the pinned images/modules. Local verification used Docker 29.7.2, Compose 5.5.1, and Go 1.27.1. Allow at least 4 GiB free RAM for the proof and additional space for image/module caches.

```sh
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
```

The test starts a randomly named isolated Compose project, generates temporary credentials, checks real PostgreSQL/ClickHouse connections and Goose migrations, and sends traces/logs through the Collector. It deletes only its own containers, network, and volumes after success or failure. It does not use a production database or modify an existing tunnel or identity provider. Do not interrupt it with an uncatchable process kill; see the cleanup guidance in the validation document.

## Run the local proof manually

This Compose file is for local validation, not a production deployment. It uses one ingestion token and one fixed project ID. All published ports bind to loopback and use random host ports.

In a new checkout, create a protected `.env` once. This command refuses to overwrite an existing file:

```sh
test ! -e .env && (
  umask 077
  printf 'POSTGRES_PASSWORD=%s\nCLICKHOUSE_PASSWORD=%s\nOTLP_TOKEN=%s\n' \
    "$(openssl rand -hex 32)" \
    "$(openssl rand -hex 32)" \
    "$(openssl rand -hex 32)" > .env
)
docker compose --project-name logice-validation config --quiet
docker compose --project-name logice-validation up --detach --wait --wait-timeout 120
docker compose --project-name logice-validation port collector 4318
```

Use the displayed address as the OTLP/HTTP endpoint and send `Authorization: Bearer <OTLP_TOKEN>`. Use `/v1/traces` and `/v1/logs`. Query port `4317` for the local gRPC endpoint or `13133` for the Collector health endpoint. The test harness waits for Collector HTTP readiness separately; Compose's `--wait` alone does not establish Collector readiness.

Stop without deleting data:

```sh
docker compose --project-name logice-validation down
```

Do not expose this proof through Cloudflare Tunnel. Never commit `.env`, tunnel credentials, database dumps, or authentication secrets. Changing `.env` does not rotate a password already stored in a PostgreSQL volume.

## Local development

Use Go 1.26 or later and Node.js 26.11.1 with npm 11.20.0. Install the private frontend package once:

```sh
npm --prefix web ci
```

In separate terminals, run:

```sh
go run ./cmd/logice
npm --prefix web run dev
```

Go listens on `127.0.0.1:8080`; `GET /api/healthz` reports process liveness, not database or application readiness. Vite listens on `127.0.0.1:5173` and forwards `/api` to Go. A port conflict fails instead of selecting another port. Go does not yet serve frontend assets. Do not expose these development servers publicly.

## Repository checks

```sh
go mod verify
sh scripts/check-go.sh
npm --prefix web ci
npm --prefix web run ci
npm --prefix web audit --audit-level=low
./scripts/validate-web-layout.sh
sh scripts/validate-checks.sh
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
git diff --check
```

Go checks need neither Node.js nor frontend assets. `scripts/validate-checks.sh` clones the committed revision into a temporary checkout, verifies independent Go checks with no Node.js on PATH, installs hooks, and verifies that injected Go/web formatting and test failures are rejected without source/index edits. It does not test uncommitted changes.

The frontend-layout script installs a separate locked compatibility fixture into a temporary directory. It collects Playwright tests but does not run a browser. CI retains this proof separately from the application frontend checks and real-service integration tests. Hooks run read-only checks with web-local tools; they do not rewrite source files. There is no npm publishing or replacement release pipeline.

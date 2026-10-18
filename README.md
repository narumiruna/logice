# Logice

A planned self-hosted observability platform with a Go backend, React/TypeScript frontend, PostgreSQL application data, and ClickHouse telemetry.

**Current status:** stack selection and an executable ingestion proof. There is no application API, authentication UI, trace explorer, or production deployment image yet. The existing TypeScript example is retained until the application migration.

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

## Repository checks

The template currently requires Node.js 26 and npm:

```sh
npm ci
npm run ci
./scripts/validate-web-layout.sh
go vet ./...
go test ./...
git diff --check
```

The frontend-layout script installs a locked compatibility fixture into a temporary directory; it does not create the application or run a browser. CI runs it separately and also runs the tagged Docker integration test. Git hooks run read-only checks; they do not migrate Biome configuration or rewrite source files. The full move of npm tooling into `web/`, application CI, and replacement of template npm publishing are specified in the implementation sequence. No package publication or version tag is part of stack validation.

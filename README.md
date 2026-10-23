# Logice

A self-hosted observability platform under development, with a Go backend, React/TypeScript frontend, PostgreSQL application data, and ClickHouse telemetry.

**Current status:** a real-data Live explorer, local trace/log lists, structured filters, span and log details, ClickHouse query APIs, web/API container images, and real-service validation. Authentication, multi-project access, and production deployment are not implemented.

## Usage

See [local trace and log views](docs/local-telemetry.md) for filters, detail pages, OTLP setup, API routes, and limits. Use the [Python examples](examples/python/README.md) to send sample traces and correlated logs.

### Themes

Use **Theme** in the top-right header to select a style for all pages:

1. **Classic**: blue accents and wider spacing, based on the original Traces and Logs pages.
2. **Studio**: lavender accents and compact spacing, based on the original Live and Preview pages.

The choice persists in this browser across navigation and reloads. Switching does not reset filters, expanded records, the inspector, or paused updates. Classic is the default. If browser storage is unavailable, switching still works until the next page load.

## Live explorer

Open **http://127.0.0.1:5173/live** after building the web/API services. It combines actual exported spans and logs with bounded automatic polling, a server-counted histogram, an expandable hierarchy, and an inspector. Pause freezes the current window. See [Live usage, identity rules, and limits](docs/live-telemetry.md). This remains a local, fixed-project feature; it does not provide authentication or running-span streaming.

### Design preview

Open [the live explorer preview](http://127.0.0.1:5173/preview) after building the web service. It shows an animated event hierarchy, live simulation, and a right-side inspector using sample data only. The existing Traces and Logs pages still show real telemetry. See [the design notes](docs/design/live-explorer.md).

## Design

- [Stack decisions and operating targets](docs/stack.md)
- [Authentication and Pocket ID design](docs/authentication.md)
- [Dependency-ordered implementation sequence](docs/implementation.md)
- [Validation commands, evidence, and limitations](docs/validation.md)
- [Current tracked plan](docs/plans/2026-10-18_logice-stack-plan.md)

## Verify the stack

Requirements: a local Docker Engine 28 or later with Compose 2.24 or later, Go 1.26.10 or a patched later release, and network access to pull the pinned images/modules. Initial verification used Docker 29.7.2, Compose 5.5.1, and Go 1.27.1; the current Go revalidation uses 1.26.10. Allow at least 4 GiB free RAM for the proof and additional space for image/module caches.

```sh
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
```

The test starts a randomly named isolated Compose project, generates temporary credentials, checks real PostgreSQL/ClickHouse connections and Goose migrations, and sends traces/logs through the Collector. It deletes only its own containers, network, and volumes after success or failure. It does not use a production database or modify an existing tunnel or identity provider. Do not interrupt it with an uncatchable process kill; see the cleanup guidance in the validation document.

## Run with Docker Compose

This Compose file starts the web application, Go API, PostgreSQL, ClickHouse, and OpenTelemetry Collector. It is for local validation, not a production deployment. It uses one ingestion token and one fixed project ID. All published ports bind to loopback. The web port is fixed at `5173`; database and Collector host ports are random. Docker builds the application images, so host Go and Node.js installations are not required.

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
docker compose --project-name logice-validation up --build --detach --wait --wait-timeout 120
docker compose --project-name logice-validation port collector 4318
```

Open **http://127.0.0.1:5173**. Select **Live**, **Traces**, or **Logs**, apply filters, and open a record for details. Views are empty until your applications send matching telemetry. Nginx serves the built frontend and forwards `/api` to the Go container. The API has no published host port. Check liveness with `curl http://127.0.0.1:5173/api/healthz`. The API reads the fixed `validation` project from ClickHouse; it does not use PostgreSQL yet. Stop Vite first if it already uses port `5173`.

Use the displayed Collector address as the OTLP/HTTP endpoint and send `Authorization: Bearer <OTLP_TOKEN>`. Use `/v1/traces` and `/v1/logs`. Query port `4317` for the local gRPC endpoint or `13133` for the Collector health endpoint. The test harness waits for Collector HTTP readiness separately; Compose's `--wait` alone does not establish Collector readiness.

Stop without deleting data:

```sh
docker compose --project-name logice-validation down
```

Do not expose this proof through Cloudflare Tunnel. Never commit `.env`, tunnel credentials, database dumps, or authentication secrets. Changing `.env` does not rotate a password already stored in a PostgreSQL volume.

## Private Kubernetes deployment

See the [Helm chart](charts/logice/README.md) and [Argo CD Application example](charts/argocd-application.example.yaml). Supply published API/web images and an existing Secret. Services are internal by default. The application still has no authentication; restrict access separately.

## Local development

Go 1.26.10 and 1.27.3 include the certificate-distrust fix for [GO-2026-6809](https://pkg.go.dev/vuln/GO-2026-6809). CI and the API image use Go 1.26.10. The module's language version remains Go 1.26.

Use Go 1.26.10 or a patched later release and Node.js 26.11.1 with npm 11.20.0. Install the private frontend package once:

```sh
npm --prefix web ci
```

In separate terminals, run:

```sh
go run ./cmd/logice
npm --prefix web run dev
```

Go defaults to `127.0.0.1:8080`; Compose explicitly uses `-listen 0.0.0.0:8080` inside the API container. `GET /api/healthz` reports process liveness, not database or application readiness. Vite listens on `127.0.0.1:5173` and forwards `/api` to Go. A port conflict fails instead of selecting another port. Go does not yet serve frontend assets. Do not expose these development servers publicly.

## Repository checks

```sh
go mod verify
sh scripts/check-go.sh
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...
npm --prefix web ci
npm --prefix web run ci
npm --prefix web audit --audit-level=low
./scripts/validate-web-layout.sh
sh scripts/validate-checks.sh
sh scripts/validate-compose-web.sh
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
git diff --check
```

`scripts/validate-compose-web.sh` needs Docker Compose 2.24.4 or later, `curl`, OpenSSL, GNU `timeout`, and web-local Playwright Chromium (`npm --prefix web exec -- playwright install --with-deps chromium`). It builds the web/API images and starts a disposable web/API/ClickHouse/Collector project with a random loopback web port. It checks static files, API routing, trace/log browser workflows, and proxy recovery after API IP replacement. It removes its own containers, volumes, network, and image tags. It does not read `.env` or change operator data.

Go checks need neither Node.js nor frontend assets. `scripts/validate-checks.sh` clones the committed revision into a temporary checkout, verifies independent Go checks with no Node.js on PATH, installs hooks, and verifies that injected Go/web formatting and test failures are rejected without source/index edits. It does not test uncommitted changes.

The frontend-layout script installs a separate locked compatibility fixture into a temporary directory. It collects Playwright tests but does not run a browser. CI retains this proof separately from the application frontend checks and real-service integration tests. Hooks run read-only checks with web-local tools; they do not rewrite source files. There is no npm publishing or replacement release pipeline.

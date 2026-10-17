# Stack validation

## Scope

Validate the selected storage, Collector, native Go drivers, and migration behavior with disposable data. This is not the application or a production deployment. Authentication design, the browser workflow, load targets, and public Cloudflare routing have separate future acceptance tests.

## Reproduce

Use a local Docker Engine 28 or later with Compose 2.24 or later, Go 1.26 or later, and sufficient image/module download space. Local verification used Docker 29.7.2, Compose 5.5.1, Go 1.27.1, Node 26.11.1, and npm 11.20.0.

From the repository root:

```sh
npm ci
npm run ci
npm audit --audit-level=high
./scripts/validate-web-layout.sh
go mod verify
go vet ./...
go vet -tags=integration ./tests/integration/...
go test ./...
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
git diff --check
```

The non-tagged Go package is only the integration harness's package documentation. It does not contain application unit tests. The tagged command must run the real Docker test, not skip because a service is missing.

The integration harness:

- Generates a unique `logice-validation-<random>` project name and three independent random credentials. It ignores inherited Compose project/file/profile/env-file settings and does not read a repository `.env`.
- Checks required credentials before startup. It uses project-owned named volumes/networks and random loopback host ports. No fixed container names, host networking, external volumes, or existing databases are used.
- Waits for Collector HTTP health and real native database connections with bounded deadlines. Compose `--wait` alone is not Collector readiness.
- Captures only sanitized diagnostics. Never print rendered Compose configuration; it contains credentials.
- Closes database/HTTP/gRPC resources and removes its own project and volumes on success or failure. It rediscovers random host ports after database restarts.

A forced process/host kill can prevent cleanup. If that happens, identify the exact project name from the test output, inspect its Docker Compose project labels, and remove only that project. Do not use Docker-wide prune commands. To invoke Compose cleanup after the harness process has exited, supply non-secret placeholder values for the three required variables so interpolation succeeds, and explicitly name only the confirmed abandoned test project:

```sh
# Replace the value with the exact abandoned project from this test's output.
project=logice-validation-REPLACE_WITH_CONFIRMED_TEST_ID
POSTGRES_PASSWORD=cleanup CLICKHOUSE_PASSWORD=cleanup OTLP_TOKEN=cleanup \
  docker compose --project-name "$project" down --volumes --remove-orphans
```

This destructive command is only for the disposable test project. Never use it for operator data or the manually retained `logice-validation` project.

## Functional assertions

The fixture uses current timestamps so the 24-hour TTL does not remove it during a run. The test performs these checks against the pinned images in `compose.yaml`:

| Area | Required assertion |
| --- | --- |
| Configuration | Each missing secret causes Compose configuration failure; ports, volumes, networks, and running-container labels belong to the isolated project. |
| PostgreSQL | Connect with `pgx`, migrate, insert/read project metadata, and verify only the metadata fixture and migration-history table exist. |
| ClickHouse migrations | Connect with `clickhouse-go`, apply a Goose `NO TRANSACTION` migration, and insert/read its proof row. |
| Migration history | A second `Up` call makes no changes and the recorded version remains 1 in each database. |
| Partial DDL | A deliberately failing nontransactional ClickHouse migration leaves its first table in place without advancing its history. A blind retry still fails. After asserting that no automatic rollback or history advancement occurred, the test explicitly drops only its disposable partial-DDL table. |
| OTLP HTTP | Export a parent and child span plus a correlated log through the real Collector. |
| OTLP gRPC | Export an additional real gRPC span; this is local transport, not a public Tunnel test. |
| Trace/log lookup | Verify trace/span/parent IDs, service, duration, timestamps, log body/severity, correlation, custom resource attributes, and scalar attribute values. |
| Project spoofing | Replace the supplied resource project ID with trusted `validation`; delete reserved project IDs on span/log records. |
| Rejected requests | Missing/wrong HTTP and gRPC credentials and malformed authenticated HTTP protobuf bodies fail; rejected fixtures create no trace/log rows. |
| Short outage | Stop ClickHouse, submit a span, wait beyond the batch timeout, restart the database, and verify retry recovery. The fixture expects exactly one recovered row, not a general exactly-once guarantee. |
| Persistence | Restart both databases and verify the application fixture, migration proof, and telemetry survive in their named volumes. |

The tested default exporter schema stores attributes in `Map(LowCardinality(String), String)`. String, integer, boolean, and floating-point scalar values are checked after string conversion. This is **not preservation of original OTLP attribute types**. Nested attributes, events, links, numeric extremes, and application-specific schema choices still need representative fixtures before production DDL is selected.

## Frontend layout feasibility

`./scripts/validate-web-layout.sh` copies the locked [web fixture](../tests/fixtures/web-layout/README.md) into a new temporary project. It installs only under that project's `web/`, runs an audit, TypeScript checks, one Vitest unit test, a Vite production build, and Playwright collection using `web/playwright.config.ts` and `web/e2e/`. It asserts that no root manifest, root `node_modules`, or browser download exists, then removes its temporary project.

The final main-agent rerun passed: 140 packages installed, zero audit vulnerabilities, typecheck success without `skipLibCheck`, one unit test passed, 403 Vite modules transformed, and one Playwright test collected. A separate deliberate `npm ci` failure returned exit status 42 and the cleanup trap removed its temporary project. A first run required Vite's CSS-import types; the fixture includes `vite/client`. Vite emits unsuppressed dependency `use client` directive warnings. No browser was launched, and this client-only fixture does not establish accessibility or application behavior.

The root Vitest configuration excludes these isolated fixtures. CI runs the fixture through its own script so missing fixture dependencies cannot be hidden by the repository's existing root `node_modules`.

## Migration feasibility and deployment design

Selected module versions: `pgx/v5` 5.11.0, `clickhouse-go/v2` 2.49.0, and Goose 3.29.0. The root module pins their actual dependencies. SQL under `tests/integration/testdata/` is deliberately small feasibility data, not production application migrations.

Source/build research also built the Goose 3.29.0 CLI with PostgreSQL and ClickHouse support using Go 1.27.2. For example, in a separate tools directory:

```sh
# TOOLS must be a new operator-selected temporary directory.
GOTOOLCHAIN=go1.27.2 GOBIN="$TOOLS/bin" go install \
  -tags='no_mysql no_sqlite3 no_ydb no_libsql no_mssql no_vertica no_azuresql' \
  github.com/pressly/goose/v3/cmd/goose@v3.29.0
"$TOOLS/bin/goose" -version
```

The application build design will include this pinned runner as `/app/goose` and separate SQL directories under `/app/migrations/`. [implementation.md](implementation.md) specifies its per-database `status` and `up` commands. Those future production-image commands have not run; this PR has no application image or production schemas.

The [pinned ClickHouse dialect documentation](https://github.com/pressly/goose/blob/v3.29.0/doc/dialect-clickhouse.md) requires retry-safe DDL for interrupted nontransactional migrations. DDL and the version row are not atomic. Initial support is a standalone server; this result does not validate replicated/clustered migration behavior. Serialize runners externally and test recovery rather than assuming Goose provides a portable cross-database lock.

## Evidence record

- `npm run ci` initially failed on three template formatting differences and a Biome schema-version mismatch. This PR fixes only those formatting differences and the schema URL.
- Initial `npm audit` reported critical `shell-quote` advisory [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv). The lockfile now resolves 1.12.0; the rerun reported zero vulnerabilities. This statement is limited to the audit database and lockfile at validation time.
- Compose configuration and the Collector's own `validate` command passed with non-secret placeholder credentials. No test identity provider or tunnel was attached to the proof.
- An initial integration run found that the project resource attribute was correctly replaced but a reserved record attribute remained. The configuration now deletes reserved record attributes.
- The same run exposed ephemeral host-port changes after Docker restarts. The harness now rediscovers ports before opening new native connections.
- Subsequent complete real-service runs passed. A main-agent rerun with Go 1.26.9 passed in 35.60 seconds, including gRPC credential rejection, nanosecond timestamps, default column/TTL assertions, short-outage retry, restart persistence, and partial-DDL detection. The Docker/Compose minimum-version unit test also passed.
- A fresh root `npm ci` and `sh scripts/pre-commit.sh` passed. Before/after comparisons confirmed that the hook changed neither the staged diff nor the worktree diff. The first actual commit attempt then exposed the template script's missing executable bit; it is now executable so Husky can invoke it directly.
- `go mod verify`, ordinary Go checks, and tagged `go vet` passed. `GOTOOLCHAIN=go1.27.2 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...` reported no vulnerabilities for the harness and its test dependencies at validation time.
- A fresh local clone of commit `f9188b9` passed `npm ci`, direct hook checks, expected Husky hook-path setup, the isolated frontend fixture, and the real-service integration suite on Go 1.26.9 in 34.84 seconds. Its tracked/untracked worktree remained clean, and the temporary clone was removed. The actual commit hook also passed after the executable-bit fix.
- A separate new Pocket ID 2.18.0 instance returned discovery/JWKS supporting Code, S256, Basic client authentication, and RS256. It was removed with its temporary key. No OIDC login was tested; see [authentication.md](authentication.md).

## Unverified paths and acceptance gates

- The Go application, production frontend, browser behavior tests, static-serving image, OpenAPI generation, and production migrations are future work. A small isolated frontend compatibility build passed; it is not an application build.
- Password, TOTP, passkey, session, account recovery, and a complete Pocket ID login require application implementation. No compatibility claim is based only on discovery.
- Dynamic per-project token lookup/revocation, private Collector metadata enrichment, query isolation, least-privilege production roles, and public Tunnel access are not proved by a single static-token fixture.
- Queue saturation, restart loss, retry exhaustion, duplicate delivery under ambiguous insert failures, request/decompression limits, load/latency targets, retention expiry, and backup/restore remain release tests.
- The operator's hostname, tunnel, credentials, and recovery key are not selected or changed here. The public deployment cannot be claimed ready without them.
- Final user acceptance of the recommended library choices and validation targets remains open. Preserve the tracked plan and do not claim end-to-end plan completion until that gate is accepted.

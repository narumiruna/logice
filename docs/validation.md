# Foundation and stack validation

## Scope

Validate the Go development server, private frontend tooling, selected storage, Collector, native Go drivers, and migration behavior with disposable data. This foundation is not a usable observability application or a production deployment. Authentication, browser workflows, load targets, and public Cloudflare routing have separate future acceptance tests.

## Reproduce

Use a local Docker Engine 28 or later with Compose 2.24 or later, Go 1.26 or later, and sufficient image/module download space. Local verification used Docker 29.7.2, Compose 5.5.1, Go 1.27.1, Node 26.11.1, and npm 11.20.0.

From the repository root:

```sh
npm --prefix web ci
npm --prefix web run ci
npm --prefix web audit --audit-level=low
./scripts/validate-web-layout.sh
sh scripts/validate-checks.sh
go mod verify
sh scripts/check-go.sh
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
git diff --check
```

Ordinary Go tests cover HTTP handlers, lifecycle behavior, and deterministic telemetry fixture generation without databases or Node.js. The tagged command must run real Docker tests, not skip because a service is missing. Commands have finite deadlines in the check scripts or CI jobs; the integration suite retains an 8-minute ceiling.

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

The tested default exporter schema stores attributes in `Map(LowCardinality(String), String)`. String, integer, boolean, and floating-point scalar values are checked after string conversion. This is **not preservation of original OTLP attribute types**. Extended assertions and version-specific source references are specified in the [telemetry compatibility matrix](telemetry-compatibility.md). Application-specific production DDL remains unselected.

## Frontend layout feasibility

`./scripts/validate-web-layout.sh` copies the locked [web fixture](../tests/fixtures/web-layout/README.md) into a new temporary project. It installs only under that project's `web/`, runs an audit, TypeScript checks, one Vitest unit test, a Vite production build, and Playwright collection using `web/playwright.config.ts` and `web/e2e/`. It asserts that no root manifest, root `node_modules`, or browser download exists, then removes its temporary project.

The final main-agent rerun passed: 140 packages installed, zero audit vulnerabilities, typecheck success without `skipLibCheck`, one unit test passed, 403 Vite modules transformed, and one Playwright test collected. A separate deliberate `npm ci` failure returned exit status 42 and the cleanup trap removed its temporary project. A first run required Vite's CSS-import types; the fixture includes `vite/client`. Vite emits unsuppressed dependency `use client` directive warnings. No browser was launched, and this client-only fixture does not establish accessibility or application behavior.

The application Vitest configuration selects only `web/src/**/*.test.ts` and `web/src/**/*.test.tsx`; it excludes Playwright files and does not load this isolated fixture. CI runs the fixture through its own script so missing fixture dependencies cannot be hidden by another package's `node_modules`.

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

## Initial stack-proof evidence

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

## Automated foundation evidence

Execution base: `ebdfe31`; branch: `narumi/feat/automated-foundation`.

| Component | Version used |
| --- | --- |
| Go | 1.27.1 locally; minimum-version checks use 1.26.9 |
| Node.js / npm | 26.11.1 / 11.20.0 |
| Docker / Compose | 29.7.2 / 5.5.1 |
| PostgreSQL image | 18.6-alpine3.23, digest pinned in `compose.yaml` |
| ClickHouse image | 26.8.30.8, digest pinned in `compose.yaml` |
| Collector distribution | 0.163.1, digest pinned in `compose.yaml` |
| Application React / React DOM | 19.3.1 / 19.3.1 |
| TypeScript / Vite / Vitest | 7.0.2 / 8.3.4 / 5.0.5 |
| Biome / Husky | 2.5.15 / 9.1.7 |

The private application package pins only React and React DOM at runtime. Development dependencies and resolved versions are locked in `web/package-lock.json`; the larger isolated layout fixture remains separate. No production library, retention, hardware, authentication, or public-hostname decision is inferred from these pins.

- Baseline: the original root `npm ci`, `npm run ci`, `npm audit --audit-level=high`, layout validation, `go mod verify`, ordinary/tagged Go vet, ordinary Go tests, and the full real-service suite passed before migration. The suite took 42.30 seconds on `ebdfe31`.
- Foundation: `npm --prefix web ci`, `npm --prefix web run ci`, and `npm --prefix web audit --audit-level=low` passed. Audit reported zero vulnerabilities in 49 packages. The shell renders in a Node.js SSR test; unit tests also check loopback/strict-port proxy configuration and Playwright exclusion. This is not a browser test.
- Lifecycle: focused vet, unit tests, and `go test -race -count=10 -timeout=2m ./cmd/logice/... ./internal/httpapi/...` passed. HTTP package coverage was 100%. Tests cover liveness, JSON errors, cancellation, active-request drain, forced-close request cancellation, pre-canceled startup, listener failure, and twenty explicitly joined shutdown cycles.
- Independent build: an isolated tree containing only `go.mod`, `go.sum`, `cmd/logice/`, and `internal/httpapi/` passed tests and build with no Node.js, npm, `web/`, or frontend output. `scripts/validate-checks.sh` also enforces a Go-only PATH in a clean committed checkout before installing web dependencies.
- Failure propagation: `scripts/validate-checks.sh` passed on foundation `6b541a6`. The real hook and CI commands rejected Go formatting, Go unit-test, web formatting, and web unit-test sentinels. Every invocation preserved source hashes, worktree/index diffs, and status. Installation set `.husky/_`; a clean hook run from outside the checkout passed; the temporary clone was removed.
- Development transport: a built Go binary and Vite ran together on `127.0.0.1:8080` and `127.0.0.1:5173`. HTTP requests verified the shell, proxied JSON liveness, and proxied JSON 404 without SPA fallback. A second Go process exited 1 on the occupied API port; a second Vite listener rejected its occupied port. Vite closed and Go exited 0 after SIGTERM. No browser was launched; Go does not serve frontend assets in this scope.
- Security/tool checks: `GOTOOLCHAIN=go1.27.2 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...` reported no vulnerabilities at validation time. `GOTOOLCHAIN=go1.26.9 sh scripts/check-go.sh`, `actionlint .github/workflows/ci.yml`, shell syntax checks, and `go mod verify` passed. No dependency manifest change was needed for the Go foundation or fixtures.
- Telemetry: ordinary fixture tests passed twice, tagged vet passed, and the full real-service suite passed in 93.405 seconds (`TestTelemetryCompatibility` 58.21 seconds; `TestStackFeasibility` 35.19 seconds). Eight cases run through both HTTP and gRPC with exact final counts of 56 spans and 34 logs. Actual Nested event/link columns, string conversions, scope differences, later-parent intermediate state, empty exports, and expanded rejection/spoofing are asserted. See [the pinned source matrix](telemetry-compatibility.md) for field-level claims and limitations.
- Initial telemetry correction: a datetime-typed query parameter rounded a nanosecond boundary and hid valid stored logs. The query now compares integer `toUnixTimestamp64Nano(Timestamp)` bounds; scanned timestamps still require exact equality. The full suite rerun passed. Initial contrib v0.163.1 source URLs returned 404; image revision metadata identifies exporter v0.163.0 and pdata v1.69.0, whose exact sources were used before assertions were written.
- Review correction: the outer integration deadline must be at least 9 minutes, not 300 seconds. Each stack now uses the earlier of its existing 6m45s work limit and the suite deadline minus 70 seconds. This reserves 12 seconds for failure logs, 40 seconds for cleanup, and 18 seconds of margin. `TestStackWorkDeadline` covers five budget cases; the full suite passed again in 92.953 seconds after this change. A later test cannot consume the suite's cleanup reserve.
- Initial lifecycle-test correction: TCP redial after listener closure was unreliable on this host. The assertion now checks `Accept` for `net.ErrClosed` and explicitly joins service/request work; ten repeated race runs passed. Production behavior was not changed to hide the test failure.

### Clean-checkout verification

A new local clone of implementation `9598246` passed the full check set on Go 1.26.9, Node 26.11.1/npm 11.20.0, and the service versions above. It began without root npm dependencies, frontend output, or `.env`.

Commands: `go mod verify`; `sh scripts/check-go.sh`; `go test -count=2 -timeout=2m ./tests/fixtures/telemetry`; `npm --prefix web ci`; `npm --prefix web run ci`; `npm --prefix web audit --audit-level=low`; `sh scripts/pre-commit.sh`; `./scripts/validate-web-layout.sh`; `sh scripts/validate-checks.sh`; tagged vet; and `go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...`. Ordinary commands had 300-second outer deadlines; integration had a separate 9-minute outer deadline, within a 15-minute validation deadline.

All commands passed. The application ran three Vitest tests; all eight injected failures were rejected without source/index changes; the isolated layout fixture passed installation, audit, typecheck, unit test, build, and Playwright collection. Its existing dependency `use client` warnings remain visible. No browser was launched.

The real-service suite passed in 93.021 seconds: telemetry compatibility 57.84 seconds, original stack proof 35.17 seconds, and deadline/tool-version tests passed. Non-secret inherited `COMPOSE_PROJECT_NAME`, an invalid `COMPOSE_FILE`, and inherited credential placeholders did not change the test targets. Exact-project Docker queries found no remaining containers, networks, or volumes for `logice-validation-8d10190bc23567cb` and `logice-validation-beb889e358b04f04`. `git status --porcelain` was empty and the temporary clone was removed.

The complete diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope. The integration deadline/cleanup issue found in independent review is resolved as described above. No production resources, secrets, package publication, version tags, or release workflows were used.

## Unverified paths and acceptance gates

- The Go server currently provides development liveness only; the React package provides a shell, not the observability workflow. Browser behavior, feature APIs, static-serving images, OpenAPI generation, and production migrations remain future work.
- Password, TOTP, passkey, session, account recovery, and a complete Pocket ID login require application implementation. No compatibility claim is based only on discovery.
- Dynamic per-project token lookup/revocation, private Collector metadata enrichment, query isolation, least-privilege production roles, and public Tunnel access are not proved by a single static-token fixture.
- Queue saturation, restart loss, retry exhaustion, duplicate delivery under ambiguous insert failures, request/decompression limits, load/latency targets, retention expiry, and backup/restore remain release tests.
- The operator's hostname, tunnel, credentials, and recovery key are not selected or changed here. The public deployment cannot be claimed ready without them.
- Final user acceptance of the recommended library choices and validation targets remains open. Preserve the tracked plan and do not claim end-to-end plan completion until that gate is accepted.

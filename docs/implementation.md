# Logice application implementation sequence

## Status and scope

This document defines the full application sequence. Each acceptance item requires recorded evidence before its stage can close. A skipped check remains pending; a mock does not prove external compatibility. The automated foundation introduced a development server, frontend shell, repository tooling, and disposable telemetry compatibility tests. Later authorized local work added bounded query APIs, trace/log views, web/API containers, browser checks, and Python examples. These results do not complete stages 0–8 or authorize production deployment. Actual commands and evidence are in [validation.md](validation.md).

Sources: [initial stack design](plans/2026-10-18_logice-stack-plan.md), [stack decisions](stack.md), and [authentication design](authentication.md). The root Go module and private `web/` npm package now replace the TypeScript template. npm publishing is removed. The local feature APIs and static-serving images are covered in `validation.md`. Authentication, production schemas, the proposed Go-served production image, and the full authenticated browser workflow remain future work.

The target is a small self-hosted deployment with one organization. The first workflow is: authenticate, select an authorized project and time range, find a trace or log, expand its trace hierarchy, and inspect a correlated trace waterfall and logs. Metrics, alerts, dashboards, billing, and LLM views are deferred. Do not add Kafka, Redis, Kubernetes, a custom SDK, or a custom query language without a verified requirement. Node.js is build tooling, not the backend runtime.

Use Go and React with TypeScript. Keep application metadata and all authentication records in PostgreSQL; keep telemetry in ClickHouse. Use OpenTelemetry traces and logs over OTLP through the Collector. Do not promise lossless ingestion without a durable queue.

## Dependencies and evidence rules

Run full application stages 0–8 in order. Each stage depends on the preceding stage's acceptance evidence. Resolve an external decision before work that depends on it, not by silently choosing a default. Do not create empty directories to match a diagram.

The user authorized an automation-only foundation before the full stage 0 contract. Its prerequisites are the existing Go module, `net/http`, the locked React/TypeScript/Vite toolchain, and the existing disposable Collector/PostgreSQL/ClickHouse proof. The foundation does not require production defaults. Deferred decisions retain these blocking dependencies:

| Open decision | Dependent stage |
| --- | --- |
| Remaining proposed libraries, REST/OpenAPI contract, production schemas, roles, and migration safety | 2; authentication libraries also block 3; TanStack/UI choices block 6 |
| Administrator bootstrap, enrollment, recovery, permissions, and per-login-method TOTP policy | 3 |
| Ingestion authentication, dynamic trusted project resolution, payload/loss/retry limits | 4 |
| Query/result limits and deadlines | 5 |
| Polling and rendering limits, final first-release workflow | 6 |
| Hostname, WebAuthn RP ID, OIDC registration, and operator secrets | Public authentication in 3 and public deployment in 7 |
| Tunnel placement, retention/deletion policy, backup and key management | 7 |
| Hardware/disk budget and approved steady/burst/latency targets | Capacity validation in 8 |

The fixed single-project identity, 24-hour fixture TTL, and queue settings remain proof settings, not approved production policies. No authentication, public transport, performance, or production migration gate closes with this foundation.

For each stage, record the revision, pinned tool/service versions, exact commands, fixture identifiers, expected and actual results, and relevant sanitized logs or reports. For failures, record the cause and rerun evidence. Keep credentials and production telemetry out of reports. Record a bounded timeout for every service wait and test; never use an unbounded retry loop.

### Stage 0 — Approve the validation contract

Define these decisions before feature implementation:

- Confirm or replace the proposed libraries: `net/http`, `clickhouse-go/v2`, `pgx`, Vite, TanStack Router, TanStack Query, TanStack Virtual, Collector Contrib, REST/OpenAPI, and Goose. Pin reviewed versions and record maintenance/security checks. Keep TanStack Table optional.
- Set retention, deployment hardware and disk budget, maximum request/result sizes, query deadlines, polling interval, and permitted ingestion loss/retry behavior.
- Define the organization administrator bootstrap, user enrollment, project membership and management permissions, recovery, and second-factor policy. Decide whether local TOTP applies to passkey and OIDC logins as well as password login.
- Have the operator supply the stable external URL, WebAuthn RP ID, OIDC client registration, and secrets. Do not select a public hostname or commit user secrets. Decide whether `cloudflared` runs inside Compose or outside it.
- Select ingestion authentication and trusted project resolution. A browser session must not be an ingestion credential. Verify how the chosen Collector authentication component obtains and refreshes project credentials.
- Review the selected Goose 3.29.0 runner and the real-service feasibility evidence. Stage 2 defines the production migration commands and required safety review; fixture success does not validate production schemas.

Proposed initial validation budget, not a measured capacity claim:

| Check | Finite proposed target, subject to approval |
| --- | --- |
| Data | Deterministic trace and log fixture, split evenly by event count, two projects in one organization; nested, wide, orphaned, late, and out-of-order spans and correlated/uncorrelated logs |
| Steady ingestion | 100 combined trace/log events per second for 10 minutes after a 1-minute warm-up |
| Bursts | One 30-second burst at 1,000 combined events per second, followed by 60 seconds at the steady rate |
| Visibility | Healthy-run p95 visibility at most 5 seconds; all fixture IDs accounted for within 30 seconds after export completes; report duplicates separately |
| Query | At least 1 million stored fixture events; 100 fixed project/time-bounded searches and trace lookups; proposed p95 response time at most 2 seconds on the recorded 4-core, 8-GiB reference host |
| Browser | 10,000 visible-tree candidates; bounded DOM rows, stable expansion/scrolling, and correct time alignment, with the browser and viewport recorded |

These are proposed test inputs and gates, not throughput, latency, or durability guarantees. Adjust them only by an explicit review before the run. Specify fixture payload sizes and attribute cardinality, retention, hardware, and disk limits so an event count is meaningful. Select numeric memory, disk, rendering, and polling bounds before testing. Fault runs must report accepted, exported, stored, duplicate, rejected, and lost event counts separately.

Acceptance evidence: one approved decision record with each item above resolved or explicitly blocking its dependent stage; one fixture specification and test matrix with numeric limits. No performance claim is accepted at this stage.

### Stage 1 — Replace template tooling and establish repository boundaries

Use one root Go module and one private npm package in `web/`, with no monorepo framework.

| Proposed path | Responsibility and test ownership |
| --- | --- |
| `cmd/logice/main.go` | Create clients, connect components, start and stop the application; no feature logic |
| `internal/httpapi/` | REST routes, middleware, errors, OpenAPI contract checks, static file serving; handler tests beside code |
| `internal/auth/` | Passwords, sessions, WebAuthn, TOTP, OIDC, recovery; security unit tests beside code |
| `internal/projects/` | Project permissions and ingestion credential lifecycle; unit tests beside code |
| `internal/postgres/` | Application-data SQL and persistence only; no telemetry tables |
| `internal/clickhouse/` | Telemetry SQL, query limits, and result mapping only; no authentication records |
| `web/src/app/` | Router, providers, application shell |
| `web/src/features/{auth,explorer,settings}/` | Feature UI and colocated Vitest tests; tree/timeline code belongs in explorer |
| `web/src/components/`, `web/src/lib/` | Shared UI, API client, small utilities; generated API types in `web/src/lib/generated/` |
| `web/e2e/`, `web/playwright.config.ts` | Playwright tests, fixtures, browser setup, reports, and configuration, using only `web/` dependencies |
| `api/openapi.yaml` | Browser REST contract, not the OTLP protocol |
| `migrations/{postgres,clickhouse}/` | Separate ordered migration streams and histories |
| `tests/integration/` | Go cross-component database, ingestion, isolation, migration, and lifecycle tests |
| `deploy/`, `compose.yaml`, `Dockerfile` | Collector configuration, service deployment, image build; tunnel configuration only if managed here |

Keep Go unit tests beside code as `*_test.go`. Put service-dependent Go tests under an `integration` build tag so unit tests do not need databases. A requested integration run must fail, not silently skip, when required services are absent. Use explicit disposable test projects/databases and bounded cleanup.

Database packages must not import `httpapi` or concrete feature services. Define small persistence interfaces in the consuming feature only when needed. Do not add generic service/repository frameworks. Verify the import graph with Go checks. Go builds and unit tests must work without `web/dist/` or Node.js.

Move the frontend manifest, lockfile, TypeScript configuration, and Biome configuration into `web/`; change the template configuration for React/Vite and correct relative paths. Replace template `src/` and `tests/index.test.ts` only when implementation is approved. Remove the root npm manifest/lockfile unless a demonstrated need is approved. Mark the web package private and remove template repository identity.

Define these future npm scripts in `web/package.json`:

| Script | Required behavior |
| --- | --- |
| `prepare` | `cd .. && husky`, installing the root `.husky/` hooks from the web package |
| `check` | `biome ci .`, with VCS and ignore paths checked from `web/` |
| `typecheck` | `tsc --noEmit` with React/Vite configuration |
| `test` | `vitest run`, excluding Playwright files |
| `build` | `vite build`, producing `web/dist/` |
| `dev` | `vite`, with a same-origin API proxy to Go |
| `test:e2e` | `playwright test`, using `web/playwright.config.ts` and `web/e2e/` |
| `generate:api` | Pinned OpenAPI type generator: `openapi-typescript ../api/openapi.yaml -o src/lib/generated/api.d.ts` |
| `ci` | Run `check`, `typecheck`, `test`, and `build`; installation alone is not a check |

Introduce the OpenAPI generation script and pin its dependency before committing generated types. Keep handwritten client logic outside the generated directory. CI regenerates types and requires no diff. Add contract tests for handlers; generated TypeScript types alone do not prove runtime conformance.

Keep `.husky/pre-commit` and `scripts/pre-commit.sh` at the root. Have the script change to the repository root and run read-only Go checks plus `npm --prefix web` checks. Use the web-local npm executables, not global Biome. Remove `biome migrate --write`, automatic formatting, and unrelated rewrites. Test hook setup and failure propagation; hooks do not replace CI.

Remove `.github/workflows/publish.yml`, `.changeset/`, `@changesets/cli`, and the `changeset`/`release` scripts. Do not publish the template npm package. Select image/Go binary release targets later; do not add a replacement release pipeline without that decision. Update README, ignore rules, and Dependabot for root Go and `/web` npm dependencies, while retaining required GitHub Actions/Docker updates.

#### Clean-checkout foundation commands

Prerequisites are Git, the pinned Go and Node.js/npm versions, and Docker Compose for integration/image checks. Run from the repository root after stage 1 has introduced the baseline Go code, frontend, files, and scripts. The foundation commands have run against the migrated repository; see `validation.md` for revision-specific evidence. They do not exercise the later production contract or schema:

```sh
go mod download
go mod verify
npm --prefix web ci
git config --get core.hooksPath
# Expected hook path: .husky/_
test -z "$(git ls-files '*.go' | xargs -r gofmt -l)"
go vet ./...
go test ./...
go build -o /tmp/logice ./cmd/logice
npm --prefix web run check
npm --prefix web run typecheck
npm --prefix web test
npm --prefix web run build
sh scripts/pre-commit.sh
git diff --exit-code
```

After stage 2 adds the contract and tracked generated output, also run:

```sh
npm --prefix web run generate:api
git diff --exit-code -- web/src/lib/generated/
test -z "$(git status --porcelain -- web/src/lib/generated/)"
```

For local development, use separate terminals with `go run ./cmd/logice` and `npm --prefix web run dev` after operator configuration and migrations are available. Development commands start servers and are not CI checks.

Replace the install-only CI job with explicit Go formatting, vet, unit tests, and build, plus frontend install, Biome, TypeScript, unit tests, generated-client drift, and build checks. Set npm cache dependency path to `web/package-lock.json`. CI uses `HUSKY=0 npm --prefix web ci` and does not depend on hooks. Add service-backed integration, Playwright, and runtime-image checks as their stages become available. Pin tool versions; do not substitute unchecked latest versions.

Acceptance evidence: a clean-checkout command transcript, separate Go-only build without frontend assets, a deliberate lint/test failure rejected by the hook and CI, no hook-induced diff, and confirmation that root npm publishing/configuration is removed. Later-stage commands are pending, not stage 1 successes.

### Stage 2 — Define contracts, storage, and migration safety

Define the browser API before its client: authentication/enrollment, session state, projects/credentials, bounded search/histogram, trace detail, and structured errors. Specify pagination/cursors, time precision, inclusive/exclusive range boundaries, request/result limits, cancellation, authorization, and error status codes. Never expose password hashes or ingestion credential hashes. Set browser session tokens only through protected session cookies, not response bodies. Expose pending TOTP enrollment material only through the recent-authenticated enrollment flow; do not return stored secrets from normal APIs or diagnostic logs.

Define PostgreSQL schema for the single organization, users, memberships, projects, hashed ingestion credentials, settings, opaque sessions, pending enrollment/challenges, recovery-code hashes, and OIDC issuer/subject identities. Define ClickHouse schemas from verified Collector trace/log exporter behavior, including project identity, trace/span/parent IDs, timestamps, duration, service/resource attributes, log severity/body, and retention. Test attribute types and high-resolution timestamps rather than assuming exporter preservation.

Resolve schema ownership before running the Collector: migrations own production DDL; disable exporter auto-create where supported, or explicitly reconcile its supported schema behavior. Give Collector ingestion and API query connections separate least-privilege database roles. The query role cannot modify data. PostgreSQL and ClickHouse migrations use separate credentials and histories.

#### Migration runner and safety review

Select Goose 3.29.0 for the initial standalone databases. Research built its CLI with PostgreSQL and ClickHouse drivers; the Go proof applies separate real-database fixtures through the same version's provider API. See [validation.md](validation.md) for actual results and limits. Do not claim that both databases share a transaction model or that the production schemas are validated.

Build a pinned Goose CLI in the Go build stage and copy it to `/app/goose` in the runtime image. Include PostgreSQL and ClickHouse drivers; verify the binary and driver set during image checks. The local API image exists, but it does not include the production runner, migrations, or Go-served frontend packaging. These remain production-stage work.

Proposed deployment commands, after database bootstrap and after an operator injects separate migration DSNs into the runner environment:

```sh
GOOSE_DRIVER=postgres GOOSE_DBSTRING="$POSTGRES_MIGRATION_DSN" \
  /app/goose -env=none -dir /app/migrations/postgres status
GOOSE_DRIVER=postgres GOOSE_DBSTRING="$POSTGRES_MIGRATION_DSN" \
  /app/goose -env=none -dir /app/migrations/postgres up
GOOSE_DRIVER=clickhouse GOOSE_DBSTRING="$CLICKHOUSE_MIGRATION_DSN" \
  /app/goose -env=none -dir /app/migrations/clickhouse status
GOOSE_DRIVER=clickhouse GOOSE_DBSTRING="$CLICKHOUSE_MIGRATION_DSN" \
  /app/goose -env=none -dir /app/migrations/clickhouse up
```

Do not put DSNs in positional command arguments, logs, or shell history. Run the commands only through one serialized deployment job. `-env=none` prevents accidental reading of an unrelated `.env` file. `clickhouse` is the driver name; native TCP uses port 9000 in this deployment. Provision the database before connecting to it.

Review every migration before deployment:

- PostgreSQL: use transactions where supported; identify lock duration and destructive/data-rewrite changes.
- ClickHouse: explicitly review nontransactional execution and the supported Goose directive, such as `-- +goose NO TRANSACTION`, against the chosen runner. A multi-statement failure can leave partial DDL even when migration history says it did not complete.
  - Define preconditions, postconditions, partial-failure detection, safe retry/repair, and backup/forward-recovery steps for each migration. Never assume transactional rollback or automatic down migration is safe.
  - Review engine/partition/order keys, TTL changes, asynchronous mutations, cluster assumptions, exporter compatibility, and query compatibility. Keep the initial deployment single-node unless another requirement is approved.
- Serialize migration execution before application/Collector readiness. A second migrator must fail or wait safely under the verified lock mechanism; do not assume a portable lock.
- Test fresh install, upgrade from the preceding schema, rerun/status, concurrent invocation, incompatible versions, and an injected failure after the first DDL statement. Recovery must not silently destroy telemetry or mark partial work complete.

Store SQL under `migrations/postgres/` and `migrations/clickhouse/`; copy it into `/app/migrations/postgres/` and `/app/migrations/clickhouse/`. Do not embed SQL initially. Application startup must detect missing/incompatible schema rather than create tables implicitly.

Acceptance evidence: reviewed API/schema definitions, generated-client drift check, real PostgreSQL and ClickHouse fixture tests showing data separation, and migration transcripts covering all scenarios above. Execute the specified runner commands from the built application image against fresh and preceding-version schemas before this stage closes. CLI source/build and disposable provider tests are not evidence that these future production-image commands have run.

### Stage 3 — Implement identity, sessions, and project authorization

Keep authentication in Go without an extra identity service for local login. Review/pin Argon2id (`golang.org/x/crypto/argon2`), `go-webauthn/webauthn`, `coreos/go-oidc/v3/oidc`, `golang.org/x/oauth2`, and a maintained TOTP library (`pquerna/otp` is only a candidate). Apply approved limits, login throttling, audit redaction, and generic login errors.

Implement the approved bootstrap and recovery flows before exposing enrollment. Store authentication state in PostgreSQL only. Use opaque PostgreSQL-backed sessions with expiry, rotation after authentication/privilege change, logout revocation, HttpOnly cookies, Secure cookies for HTTPS, an explicit SameSite policy, and CSRF protection for state changes. Fail closed when session/permission storage is unavailable.

Use trusted external URL configuration for WebAuthn origins/RP ID and OIDC redirects. Require HTTPS except supported localhost development. Passkey challenges must expire and be single-use. Define recent-authentication requirements for enrolling/removing credentials and recovery actions.

TOTP is authenticator-app second-factor authentication, not email codes. Generate a pending secret after recent authentication; enable it only after code verification. Encrypt shared secrets with a key outside PostgreSQL, reject reuse within a time step, and store only hashes of single-use recovery codes. Implement factor reset/removal according to the approved recovery policy; do not create a bypass through another login method.

Use OIDC discovery and Authorization Code flow with PKCE, state, nonce, and verified issuer/audience. Identify external users by issuer and subject, never by email alone. Require an explicit authenticated linking flow; matching email must not link accounts automatically.

Implement project membership enforcement and ingestion credential creation, display-once issuance, hashing, revocation, and rotation. Limit credential administration to approved roles. One organization does not imply access to every project.

Acceptance evidence, with unit, real PostgreSQL integration, and browser tests assigned to their owners:

- Password success/failure, throttling, bootstrap disabled after completion, logout, session rotation/expiry/revocation, cookie flags, CSRF, and unauthorized state changes.
- Passkey registration/login, wrong origin/RP ID, expired and reused challenges, and unauthorized credential removal. Use a browser virtual authenticator where applicable.
- Password-plus-TOTP, pending enrollment verification, invalid/out-of-window codes, reuse rejection, throttling, recovery code single use under concurrent requests, and factor removal/reset. Verify the approved passkey/OIDC second-factor policy.
- Actual Pocket ID login and logout/session behavior, plus negative state, nonce, issuer, audience, PKCE, and expired-token tests. Use controlled protocol fixtures where a provider cannot produce a malformed response, but keep a real Pocket ID happy-path run. Test issuer/subject identity and rejected email-based linking/account takeover. Do not claim Pocket ID compatibility before these checks pass.
- Anonymous, wrong-project, and revoked-user requests denied across the authentication/project routes implemented at this stage; test ingestion credential hashing, rotation, and revocation in the project service. Stage 4 adds ingestion-route checks; stage 5 adds query-route checks. PostgreSQL outage must not grant access. No authentication data appears in ClickHouse or logs.

### Stage 4 — Validate authenticated OpenTelemetry trace/log ingestion

Keep OTLP reception, batching, and export in Collector Contrib. Select and pin an exporter only after validating both trace and log schemas against stage 2. Do not duplicate OTLP reception in Go without evidence of need.

Authenticate public OTLP/HTTP credentials in the Go reverse proxy through a PostgreSQL token-hash lookup. Remove client-supplied reserved project headers, set a trusted project header from the authenticated record, and forward with an internal Collector credential. Fail closed on lookup failure or absent project identity; preserve OTLP response bodies/status, including partial success. The Collector remains the OTLP parser and receiver.

Enable receiver metadata and replace client project resource attributes from that trusted context before exporter queue batching. Delete the reserved project attribute on spans/logs as well. Keep the Collector private; verify two-project routing, missing-context rejection, direct-access denial, and spoof resistance with the pinned components before adopting the path. See [stack.md](stack.md) for trust boundaries. A static bearer credential bound to one trusted project validates transport only; it does not prove dynamic authorization or revocation. Browser cookies and client attributes are not authorization.

Prefer OTLP/HTTP for ordinary public Cloudflare Tunnel access. Test the selected route through the actual tunnel before claiming public compatibility. OTLP/gRPC compatibility remains unclaimed until separately verified. Disable unused signal receivers; metrics are deferred.

Set finite batch, memory, payload, timeout, retry, and queue bounds. Document backpressure, duplicate behavior, rejection responses, and drops on exhaustion/restart. Do not turn finite retries into a durability claim. Configure redaction and retention for application diagnostics; avoid self-observation export loops. Instrument Go operations with OpenTelemetry traces and structured correlated logs without recording secrets.

Acceptance evidence: deterministic fixtures preserve span hierarchy, trace lookup, trace/log correlation, attributes, timestamp precision, and project identity. Reject missing/invalid/revoked credentials, spoofed project attributes, malformed/oversized payloads, and cross-project access. Test Collector/ClickHouse unavailability, timeout, retry exhaustion, duplicate delivery, process restart, memory/backpressure limits, and bounded shutdown. Reconcile counts and document losses. Confirm PostgreSQL contains metadata, not ingested telemetry. Metrics remain unimplemented.

### Stage 5 — Implement bounded trace/log queries

Implement authorized project/time-bounded search, histogram, trace detail, and correlated logs using ClickHouse. Verify membership from trusted application state on every route; never trust only a project filter sent by the browser. Parameterize queries, enforce deadlines/row limits, cancel abandoned work, and use stable pagination under late arrivals. Avoid unbounded scans and unrestricted SQL.

The reference's SQL field is not a requirement for arbitrary SQL execution. Select structured filters first unless SQL is explicitly approved. If SQL is selected, require read-only scoped credentials, mandatory server-enforced project/time restrictions, statement restrictions, deadlines, and result caps; add CodeMirror 6 only then.

Define orphan/missing-parent, late-span, and partial-trace responses explicitly, without inventing complete traces. Specify overview histogram time mapping separately from per-trace waterfall mapping. Use one mapping for every bar within a displayed trace, with consistent units, range clipping, and zero-duration handling.

Acceptance evidence: handler/contract and real ClickHouse tests for trace/log lookup, exact time boundaries, histogram counts, pagination, late/duplicate events, empty and partial results, malformed filters, cancellation, unavailable databases, and timeout/limit errors. Test every query route for anonymous and cross-project denial, including trace IDs that exist in another project. Run the approved fixed query set and record its results; do not infer performance from unit tests.

### Stage 6 — Build the first browser workflow

Use the supplied [UI reference](https://sharex.narumi.dev/2026/10/18/snqDm641jrlzck6R.png) as a design reference, not approval for every control. Use Radix Themes for standard components/style tokens, Primitives for custom interactions, Icons for interface icons, and Colors directly only where needed. Do not use shadcn/ui; Tailwind CSS is not selected.

Implement login/enrollment, authorized project selection, time range and bounded histogram, trace/log search, expandable parent/child rows, timestamps, service labels, duration bars, and correlated detail. Use React for the telemetry tree and timeline; SVG/CSS is sufficient for bounded buckets and visible bars. Define loading, empty, partial, expired-session, forbidden, and failure states.

Use hierarchy-aware virtualization: flatten only currently visible expanded rows for TanStack Virtual; keep stable trace/span/log IDs, parent relationships, expansion, selection, and focus independent of row indices. Preserve scroll position when expanding/collapsing, fetching, polling, and receiving late events. Define handling for missing parents, cycles/malformed trees, extreme depth/width, and row measurement changes. Keep nested trace state separate from pagination state.

Use TanStack Query for server state. Start Live with bounded polling and cancellation on pause, navigation, logout, and unmount; use backoff on errors. Do not add SSE/WebSockets without measured need. Ensure keyboard tree navigation and accessible names/focus for Radix menus, dialogs, toggles, and tooltips.

Acceptance evidence: colocated Vitest tests cover tree flattening, stable identity, expansion, time mapping, late/orphan rows, and poll cleanup. Playwright covers login to search to trace/log detail, filters/time selection, live pause/resume, session expiry, forbidden projects, network/server errors, keyboard navigation, and focus restoration. Use representative nested traces and the approved 10,000-row fixture to verify bounded DOM size, stable scrolling, aligned bars across zoom/range changes, and no duplicate polling after navigation. Record browser traces/screenshots as test artifacts, not new repository binary files.

### Stage 7 — Package deployment, lifecycle, and recovery

Build frontend assets in a Node.js stage from `web/package.json` and `web/package-lock.json`; build Go separately. Copy the executable and filesystem assets into the runtime image. Run from `/app`; serve `/app/web/dist/index.html` and referenced assets from `/app/web/dist/`. Copy versioned SQL to `/app/migrations/postgres/` and `/app/migrations/clickhouse/`, and include the verified runner or its migration-image deployment step. Do not require a frontend build for Go unit tests. Do not use `go:embed` initially.

Serve static files and the application API from one Go origin. Restrict SPA fallback to approved frontend navigation GET/HEAD requests. Missing API routes, authentication callbacks, OTLP routes, and missing assets must return their correct errors, never `index.html`. Reject traversal. Test content types, asset paths, browser deep links, cache behavior, and API error content types in the built image, not only Vite. Development uses Vite's API proxy.

Use Compose for the application, Collector, PostgreSQL, and ClickHouse. Add `cloudflared` only after its placement decision. Cloudflare provides public HTTPS; do not add Caddy or application-managed certificates. Restrict direct origin/database/Collector access; trust forwarded headers only from the configured tunnel proxy. Configure the external URL explicitly. Test forged forwarding headers, direct-origin denial, secure cookies, WebAuthn origin, and OIDC redirects through the selected deployment path.

Define liveness/readiness separately, bounded startup retries, schema readiness, connection/request deadlines, graceful HTTP shutdown, Collector drain bounds, and database client cleanup. Stop polling on logout/unmount and close test resources even after failures. Keep secrets in operator-managed inputs; `.env.example` contains names and non-secret examples only.

Specify retention/TTL and project/credential deletion behavior, including residual telemetry access during asynchronous deletion and backup retention. Back up and restore PostgreSQL, ClickHouse, and the separate TOTP encryption key; document that losing the key affects factor recovery. Test restore into an isolated deployment, migration compatibility, session/credential revocation behavior, and retained trace/log queries. Define non-destructive upgrade/forward-recovery procedures before deployment.

Acceptance evidence: clean image build and filesystem inspection; real image static/API smoke tests including no API-to-SPA fallback; verified migration commands executed against fresh and upgrade databases; tunnel checks if public deployment is claimed; readiness/outage/restart and graceful-stop tests; retention/deletion checks; and a timed backup/restore rehearsal. A local HTTP test does not prove public HTTPS, WebAuthn, OIDC, or Tunnel transport compatibility.

### Stage 8 — Run the finite release validation and stop

Complete CI with separate Go/frontend, integration, Playwright, and image checks. Playwright dependencies/configuration stay in `web/`; provision browser binaries with the pinned local executable. Require live services rather than allowing integration tests to skip. Keep reports sanitized and use disposable data.

Future service-backed test commands, after their test harness and deployment configuration exist:

```sh
# Supply operator-managed disposable test configuration first.
docker compose up -d --wait --wait-timeout 120 postgres clickhouse
# Run the exact PostgreSQL and ClickHouse migration commands verified in stage 2.
go test -tags=integration -count=1 -timeout=10m ./tests/integration/...
docker compose up -d --build --wait --wait-timeout 120 logice collector
(cd web && npm exec -- playwright install --with-deps chromium)
npm --prefix web run test:e2e
docker compose down --remove-orphans
```

The integration harness must explicitly own any additional Collector instances, fixtures, injected failures, and schema resets. `web/playwright.config.ts` must select `web/e2e/`, set a finite timeout and base URL, use isolated browser contexts, and reject accidental production targets. Name the future Compose services as above or update the commands together with the configuration. Run load generation and image smoke tests through the documented stage-specific harness; their exact commands remain required implementation evidence, not commands claimed to exist today.

Install a teardown trap in CI so failures also stop containers and remove temporary credentials/test resources. Delete disposable volumes only in a uniquely named test Compose project; never run destructive volume cleanup against operator data. Ensure the final application exits cleanly and no test process, polling timer, browser, or temporary credential remains active.

Run the stage 0 steady/burst benchmark with the approved fixture and hardware, then the fault cases from stages 2–7. Record actual query/ingestion latency, CPU, memory, disk, rejected/dropped/duplicate events, and visible-row behavior against the approved limits. Fix failures and rerun the affected checks. If a required external service or policy is unavailable, leave the release gate blocked.

Acceptance evidence: all stage records complete, a fresh-checkout install/check transcript, passing real-service and browser/image reports, measured benchmark results, migration review and recovery proof, operational README/runbook, and an explicit list of any unsupported paths. Release only the first trace/log workflow. Defer new features rather than extending this sequence indefinitely.

## Remaining external dependencies

- Approval of proposed libraries, validation thresholds, hardware/retention budget, and exact first-release permissions/workflow.
- Administrator bootstrap/recovery and per-login-method TOTP policy decisions.
- Operator-owned hostname, tunnel placement/credentials, Pocket ID configuration, and secret/key management.
- Production Collector schema/roles and verification of the proposed dynamic ingestion-proxy project-resolution path; the static one-project proof does not satisfy this gate.
- Explicit nontransactional ClickHouse migration review and execution of the specified runner commands from the production image. Pinned Goose source/build and provider feasibility do not close production migration acceptance.
- Evidence for every remaining full-application acceptance gate. Separately authorized local query/UI/container/example work does not imply approval of production authentication, public deployment, or the proposed validation budget.

# Foundation and stack validation

## Scope

Validate the local trace/log workflow, Go API, frontend tooling, selected storage, Collector, native Go drivers, and migration behavior with disposable data. This is not a production deployment. Authentication, multi-project authorization, load targets, and public Cloudflare routing remain separate acceptance gates. Historical foundation evidence below applies to its recorded revision.

## Theme switching: 2026-10-23

All pages now share navigation and a **Theme** selector. Classic retains the blue style and wider spacing. Studio retains the lavender style and compact spacing. The browser stores the selection as `logice.theme`; invalid or unavailable storage defaults to Classic. Storage write failures do not prevent switching on the current page. No telemetry API, dependency, schema, or polling logic changed.

### Verification

| Check | Actual result |
| --- | --- |
| `npm --prefix web run ci` | Biome, TypeScript, 233 unit tests, and the production build passed. The 31 theme tests cover preference validation, initialization, server rendering, and 20 text-color pairs at 4.5:1 or higher. |
| `sh scripts/validate-compose-web.sh` | All 52 Chromium tests passed in 42.9 seconds, including 11 theme tests and all existing Live, Preview, list, and detail workflows. Static/API checks, API-IP replacement recovery, and disposable-project cleanup passed. |
| Theme browser checks | Both themes passed at 1440px and 390px on Traces, Logs, trace detail, Live, and Preview. Checks cover keyboard selection, reload/navigation persistence, denied storage, failed storage writes, invalid routes, API errors, and retained filters, expanded records, pause state, selection, and inspector tabs. |
| Review and `git diff --check` | No whitespace errors. Review found low-contrast Studio success and info text. Added contrast tests also found the worker label. All three text colors were corrected before the final checks. |
| `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh` | Go formatting, ordinary/tagged vet, unit tests, and build passed with the CI toolchain. |

The initial commit hook used host Go 1.27.1 and failed the unchanged `TestLivePreflightExactSizeAndAllocation` test. The focused test and complete Go checks passed with the repository's Go 1.26.10 toolchain. No Go source or checks were changed or bypassed.

Screenshots are local, ignored artifacts under `web/test-results/themes-*-chromium/`. Each theme has desktop and narrow captures for all five views and both inspectors. Initial Traces and Preview captures are under `web/test-results/theme-before/`. Browser tests replace these artifacts on the next run; no images are committed. The existing service on port 5173 and its data were not changed.

### External review

Product owner: after the frontend is rebuilt or the captures are available, compare Classic and Studio on the desktop and narrow views. Confirm that both retained styles meet the preferred visual design. Automated checks do not establish subjective visual acceptance or physical-device behavior. This UI work does not authorize public deployment; the existing authentication, authorization, capacity, and recovery release restrictions remain unchanged.

The completed agent plan was `docs/plans/2026-10-23_theme-switching-plan.md`. Theme usage remains in `README.md`; this section retains the verification evidence and visual-review handoff.

## Real-data Live page: 2026-10-23

Execution base: `origin/main` at `a6e4b98`; branch: `narumi/feat/live-page`. The supplied Live plan was the only untracked input. No repository or ancestor `AGENTS.md` was present. Scope is the [local real-data Live page](live-telemetry.md), not authentication, public deployment, or the full application sequence.

### Implementation and limits

`/live` reads the additive `/api/live` endpoint. The API uses canonical full stored payloads for identity, groups before row caps, returns matching and bounded ancestor records, and counts 60 histogram buckets over matching stored rows. Logs with identical stored content have occurrence counts; those counts cannot distinguish independent emissions from retries. Conflicting span exports use a deterministic matching representative and explicit parent ambiguity. Trace completeness remains unknown. Separate ClickHouse reads are not a transaction.

Polling replaces bounded responses, waits two seconds after completion, and stops or suspends safely on pause, navigation, hidden/offline state, and unmount. Generation guards reject ignored-abort completions. The UI preserves drafts, logical focus, scroll anchors, and selected records across late parents and eviction. It never substitutes sample data or infers Running spans. Virtualization uses the reviewed React-compatible `@tanstack/react-virtual` 3.14.21 pin; no Router/Query migration or schema/Collector change was made.

The API retains fixed project/time predicates, readonly settings, 128 MiB query memory, 8 MiB native results, a shared five-second cancellation budget, two admission slots, and a 4 MiB encoded response cap. The browser validates the response while enforcing an eight-second request timeout and 4 MiB streaming byte cap. Malformed content-identified spans are non-linkable and do not consume context trace-group slots; logs with valid trace IDs do.

### Verification

Initial implementation revision: `44c8443`; the later mount-owned focus correction is described below. Tools: Go 1.26.10, Node.js 26.11.1, npm 11.20.0, Docker 29.7.2, Compose 5.5.1, and pinned ClickHouse 26.8.30.8. The existing PostgreSQL/Collector image pins are unchanged.

| Check | Actual result |
| --- | --- |
| `GOTOOLCHAIN=go1.26.10 go mod verify`, `sh scripts/check-go.sh`, and `go test -race -count=1 -timeout=2m ./internal/...` | Module verification, formatting, ordinary/tagged vet, unit tests, independent build, and race checks passed. |
| Focused `go test -tags=integration -run '^TestLive' -count=1 -timeout=5m -v ./tests/integration/...` | Passed in 68.511 seconds, including native identity, grouping, schema, caps, exact boundaries, effective settings, cancellation, memory failure, and outage/recovery cases. |
| Full `go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...` | Passed in 180.080 seconds with the nine-minute outer deadline. Existing migration, HTTP/gRPC ingestion, query, spoof rejection, retry, and persistence tests remain enabled. |
| `npm --prefix web ci`, `npm --prefix web run ci`, and `npm --prefix web audit --audit-level=low` | Installation, Biome, TypeScript, 192 unit tests, build, and zero audit vulnerabilities. |
| `sh scripts/validate-compose-web.sh` after the mount-owned focus correction | 38 Chromium tests passed in 32.2 seconds: 30 new Live tests plus all eight existing preview/list/detail workflows. Static/API checks, API-IP replacement recovery, and cleanup also passed. |
| 15-minute virtual-time controller test | 450 rotating 1,500-record responses; one physical request, one at-rest poll timer, and zero timers after stop. This is bounded-state evidence, not a heap-leak or production capacity claim. |
| Browser bounds and interaction checks | At most 120 mounted event rows at desktop/mobile sizes; less than 3 CSS pixels of surviving-anchor drift; focused orphan reparenting, offscreen navigation, retained/evicted selection, modal focus containment, URL/history, filters, minimum-width histogram selection, and reduced motion passed. |
| Real browser ingestion | Records sent after page open appeared automatically within the bounded storage/UI waits. Pause/resume, late healthy ancestor context, conflicting exports, identical logs, error filtering, a four-stored-row histogram, and escaped script-like log text passed. |
| `./scripts/validate-web-layout.sh` | Locked isolated dependency fixture passed. Existing dependency `use client` warnings remain visible. |
| `GOTOOLCHAIN=go1.26.10 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...` | No vulnerabilities found with the final Go source and pinned scanner. |
| `GOTOOLCHAIN=go1.26.10 sh scripts/validate-checks.sh` | A clean clone of `44c8443` passed independent Go checks without Node, hook installation, and all eight injected formatting/test failures without source/index changes. |
| Python example tests, Actionlint, shell syntax, local Markdown links, and diff checks | Four example tests and repository configuration/documentation checks passed. |

The full-suite local performance fixture contained exactly 5,000 spans and 5,000 logs, including deep/wide traces, 200 trace groups, and uncorrelated logs. After two warm-up requests, 30 sequential HTTP snapshots measured p50 **152.516 ms**, p95 **162.629 ms**, and maximum **165.246 ms**, with 785,014–785,015 response bytes. The host was Linux amd64, AMD Ryzen 9 7950X3D, 32 logical CPUs, and approximately 31.34 GiB RAM. This meets the plan's local two-second p95 target on this recorded host; it is not a production throughput/latency promise.

Desktop, real-Collector, and mobile screenshots were inspected under ignored `web/test-results/`. Browser traces and source/native logs remain ignored artifacts, not committed telemetry or binary files. The user can use those captures and local `/live` for subjective visual review. Public authentication, deployment, capacity/loss budgets, and recovery remain external release restrictions in `live-telemetry.md`.

The complete diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope. Independent review findings below were fixed and verified; targeted follow-up review confirmed the final eligibility predicate matches the backend. Exact-project Docker queries confirmed removal of all 33 local disposable projects used during this execution, including replacement containers and project image tags. The five existing `logice` containers remain running; operator credentials, data, identity provider, and tunnel were not changed. No packages, version tags, or release workflows were published or dispatched.

The local acceptance evidence for `docs/plans/2026-10-23_live-page-plan.md` is retained here. Hosted follow-up for the focus correction is recorded on [PR #8](https://github.com/narumiruna/logice/pull/8), not inferred from local success. The execution plan is removed only after its required verification is complete; usage, recovery, visual-review handoff, and release restrictions remain in `live-telemetry.md`. The separate initial stack plan and its existing acceptance condition are unchanged. This work is not production acceptance.

### PR #8 review corrections

Review comments [4351999106](https://github.com/narumiruna/logice/pull/8#discussion_r4351999106) and [4351999119](https://github.com/narumiruna/logice/pull/8#discussion_r4351999119) identify two valid Live-page defects.

- Interrupted fixed-window loads and paused Refresh requests now resume once after visibility/connectivity recovery. The controller retains only unfinished work for the current query. It still rejects stale responses, waits for an ignored-abort request to settle, and keeps completed paused views free of polling. Initially unavailable fixed URLs and explicit offline Refresh also recover; query changes and cleanup clear old intent.
- Histogram buttons now use the fixed 60 slot identities instead of rolling start times. Keyboard focus stays at the same position. Arrow navigation and Enter selection use the new response's bounds.

Before the fixes, three focused controller cases failed because only one request ran instead of two. A browser run with the old timestamp keys also lost the focused histogram position. After the fixes, Biome, TypeScript, all 202 unit tests, and the production build pass. The complete built-image suite passes all 41 browser tests in 35.0 seconds. Its three new cases cover hidden/offline interruption and keyboard histogram focus across an exact nanosecond rolling-window change. No timing tolerance or existing check was weakened.

The Go implementation, Collector, schemas, dependencies, and existing query APIs are unchanged. Their prior evidence remains applicable. Current publication, CI results, and thread outcomes are recorded on PR #8.

### Failures found and corrected

- The initial browser run passed 29/32 tests. It exposed desktop focus restoration timing, mobile native-dialog focus leaving the document at the tab boundary, and an ambiguous empty-state test selector. Explicit focus restoration/modal Tab wrapping and scoped assertions fixed those cases.
- The next run passed 35/36. Its focused orphan test exposed a virtualized row moving out of the old virtual range during late-parent reparenting. Synchronous expansion, logical focus ownership, and bounded focus-frame restoration fixed it without relaxing the less-than-3-pixel anchor requirement. Fixed UTC draft overwrite, pending-filter pause mismatch, and empty-feed focus fallback were also covered by regression tests.
- Review found that `json.Encoder` allocates the complete encoded value before writing. An exact encoded-size preflight now scans escaping, raw JSON, and context cancellation before encoding. The 8 MiB escaped-content regression uses six allocations/504 bytes rather than allocating an oversized encoded copy; the final output writer independently enforces the cap.
- Epoch zero was incorrectly used as an unset ranking value. The sentinel fallback was removed and native/unit epoch-boundary tests now preserve the newest trace. Real uppercase/lowercase ID and parent comparisons are also tested.
- The pinned ClickHouse driver increases `max_execution_time` when it sees a Go Deadline. SQL-level overrides were rejected under readonly mode. Live alone now hides that advertised deadline from the driver while preserving the shared context's Done, Err, and Value. Native query-log checks verify all five actual reads use readonly 1, execution limit 5, memory 134,217,728, result bytes 8,388,608, and throwing overflow behavior. Actual Live cancellation and a 500,000-row Live grouping memory failure are tested, not inferred from unrelated queries.
- Hosted [run 39826233703](https://github.com/narumiruna/logice/actions/runs/39826233703) first reached its job deadline during external Ubuntu APT downloads, before application tests. Its retry installed dependencies successfully but passed only 35/36 browser tests: a slower renderer still exposed focus loss when a late parent moved the focused row out of its previous virtual range. The criterion was reopened rather than waived. Focus now follows the exact row mount, not a fixed number of animation frames. Document capture listeners cancel stale restoration when focus moves outside an already-unmounted row, while explicit Home navigation can transfer focus from a still-mounted previous row. Two new browser regressions cover those cases. The late-parent case now uses sixfold CPU throttling; ten repeated isolated runs passed in 23.9 seconds, and the complete 38-case built-image suite passed in 32.2 seconds without relaxing focus or scroll tolerances. Targeted independent review found no remaining focus/lifecycle issue. Hosted verification of this correction belongs to PR #8.
- Final review found a client/server disagreement over malformed-span trace-group eligibility. The validator now uses the same eligibility rule and accepts 101 distinct malformed content records while still rejecting 101 eligible trace groups. Polling does not stop on this backend-valid input.

## Stack plan handoff: 2026-10-23

Base: `origin/main` at `ca036fb`; branch: `narumi/docs/stack-plan-handoff`. The working tree was clean. No repository or ancestor `AGENTS.md` was present. PRs #4–#6 are now merged, including the live preview and Docker-compatible API replacement check. This execution changes documentation only; the initial plan does not authorize the full application sequence.

### Current verification

Local versions: Go 1.26.10 selected with `GOTOOLCHAIN`, Node.js 26.11.1, npm 11.20.0, Docker 29.7.2, and Compose 5.5.1. The host default Go 1.27.1 was not used for verification. Service and image pins are unchanged from the base.

| Command | Actual result |
| --- | --- |
| `GOTOOLCHAIN=go1.26.10 go mod verify` | All modules verified. |
| `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh` | Formatting, ordinary/tagged vet, unit tests, and independent build passed. |
| `GOTOOLCHAIN=go1.26.10 go test -race -count=1 -timeout=2m ./internal/...` | HTTP and storage race checks passed. |
| `GOTOOLCHAIN=go1.26.10 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...` | No vulnerabilities found; 240-second outer deadline. |
| `npm --prefix web ci`, `npm --prefix web run ci`, `npm --prefix web audit --audit-level=low` | Install, Biome, TypeScript, 64 unit tests, and build passed; zero audit vulnerabilities. |
| `./scripts/validate-web-layout.sh` | Isolated install, audit, typecheck, unit test, build, and Playwright collection passed. Existing dependency `use client` warnings remain visible. |
| `GOTOOLCHAIN=go1.26.10 sh scripts/validate-checks.sh` | Clean clone of `ca036fb` passed Go-only checks and hook setup. All eight injected failures were rejected without source/index changes. |
| `sh scripts/validate-compose-web.sh` | Eight Chromium workflows passed, including four real-telemetry flows. Static/API checks, changed-IP proxy recovery, and cleanup passed; 420-second outer deadline with a 60-second termination allowance. |
| `GOTOOLCHAIN=go1.26.10 go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...` | All real-service tests passed in 110.190 seconds; 540-second outer deadline preserves the suite's cleanup reserve. |
| `uv run --project examples/python --locked python -m unittest discover -s examples/python -v` | Four tests passed without operator credentials. |
| `actionlint .github/workflows/ci.yml`, shell syntax, local Markdown link checks, and `git diff --check` | Passed. |

Exact-project checks found no remaining containers, networks, volumes, replacement containers, or project image tags for:

- `logice-validation-e2f9e262e04de4e2`
- `logice-validation-f42198ba0db1c963`
- `logice-validation-5e44f0a4a0c72361`
- `logice-web-check-015a6c4173cafa83`

The five pre-existing `logice` service containers remain running. No operator credentials, databases, identity provider, or tunnel were changed. No package, version tag, or release workflow was published or dispatched.

[PR #6's hosted run 39811819512](https://github.com/narumiruna/logice/actions/runs/39811819512) passed all six CI jobs on `4be2d8b`. That result verifies the Docker compatibility repair; it is not inferred from local success or represented as CI for this documentation branch.

### Completion limit

Read-only review found no missing initial-plan implementation task. Authentication, dynamic project authorization, production packaging/migrations, complete Pocket ID login, public Tunnel transport, load/loss budgets, and restore remain downstream release gates. The complete documentation diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope.

PRs [#1](https://github.com/narumiruna/logice/pull/1) and [#5](https://github.com/narumiruna/logice/pull/5) have no user reviews and only automated comments. PR #6's additional CI-success comment does not accept the stack recommendations. The remaining action is the user's explicit acceptance or replacement of the [supporting libraries, authentication policies, and operating targets](stack.md#pending-acceptance). Previously confirmed choices do not need approval again. Preserve the initial plan and its unchecked acceptance item. This handoff does not claim end-to-end plan completion or production readiness.

## Stack plan revalidation: 2026-10-22

Base: `origin/main` at `b665784`; branch: `narumi/fix/revalidate-stack`. The working tree was clean and no repository or ancestor `AGENTS.md` was present. Open preview PR #4 was not used as the base or included in this work.

This execution covers the initial plan's stack-selection, feasibility, design, and tooling requirements. It does not execute the full application sequence. The source already implements local query/UI/container/example work; the old statements that the template remained and no application images existed have been corrected without changing production requirements.

### Security failure and repair

The first `govulncheck` 1.9.0 source scan on Go 1.27.2 failed for [GO-2026-6809 / CVE-2026-111943](https://pkg.go.dev/vuln/GO-2026-6809): `crypto/x509.Certificate.Verify` did not reject certain compromised intermediate certificates. The reviewed advisory fixes the existing Go 1.26 line in **1.26.10** and the Go 1.27 line in **1.27.3**.

All Go CI jobs and the digest-pinned API builder now use Go 1.26.10. CI runs the pinned source scanner with a finite deadline. The module's Go language version, dependency versions, public API, and database schemas are unchanged. A new API image was built, its executable was extracted without starting the container, and `go version` confirmed `go1.26.10`. Source and binary vulnerability scans on that toolchain both reported no vulnerabilities at validation time. This does not update already built operator binaries/images; rebuild them with a patched toolchain before deployment. No operator service was restarted here.

### Revalidation results

| Check | Actual result |
| --- | --- |
| `GOTOOLCHAIN=go1.26.10 go mod verify` and `sh scripts/check-go.sh` with that toolchain | Module verification, formatting, ordinary/tagged vet, unit tests, and independent build passed. |
| `GOTOOLCHAIN=go1.26.10 go test -race -count=1 -timeout=2m ./internal/...` | HTTP lifecycle/query and storage race checks passed. |
| `GOTOOLCHAIN=go1.26.10 go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...` | No vulnerabilities found after the toolchain repair. The initial failing scan above is not hidden. |
| API Docker build; `go version` and `govulncheck -mode=binary` on its extracted executable | Builder pin resolved; executable reports Go 1.26.10; no binary vulnerabilities found. Temporary container and image tag were removed. |
| Pinned Goose CLI build with Go 1.26.10 | `-env=none -version` reports v3.29.0; executable metadata reports Go 1.26.10; its binary vulnerability scan passed. No deployment migration or operator environment was used. |
| `npm --prefix web ci`, `npm --prefix web run ci`, and low-level npm audit | Install, Biome, TypeScript, 42 unit tests, and build passed; audit reported zero vulnerabilities. |
| `./scripts/validate-web-layout.sh` | Locked React/Radix/TanStack fixture passed install, audit, typecheck, unit test, build, and Playwright collection using web-local dependencies. Existing dependency directive warnings remain visible. |
| `GOTOOLCHAIN=go1.26.10 sh scripts/validate-checks.sh` | A clean clone of the committed base passed the Go-only PATH check and hook setup; eight injected formatting/test failures were rejected without source/index changes. Go source and hook scripts are unchanged by this repair. |
| `sh scripts/validate-compose-web.sh` after the builder update | Four real-data Chromium workflows, static/API errors, loopback isolation, and proxy recovery after API IP replacement passed. |
| Tagged real-service suite with Go 1.26.10 | All tests passed in 119.315 seconds, including migrations, partial-DDL recovery checks, HTTP/gRPC rejection, schema/attribute compatibility, queries, retry recovery, and persistence. |
| Python example tests with the locked project | Four in-process OTLP receiver and HTTP/context tests passed without reading operator credentials. |
| Actionlint, shell syntax, and `git diff --check` | Passed. |

The initial functional integration run on Go 1.26.9 also passed in 120.535 seconds, but it is not a security acceptance result for that vulnerable toolchain. The patched run retained the suite's eight-minute deadline and a separate nine-minute outer allowance. Tests used disposable projects and generated credentials rather than operator data. Exact-project checks confirmed cleanup of all eight projects used by the initial and patched runs. No package, version tag, or release workflow was published or dispatched.

The complete diff was reviewed for correctness, security, lifecycle safety, compatibility, regressions, and scope. Independent read-only review found one outdated runnable Goose example still selecting Go 1.27.2. It was corrected to Go 1.26.10 and verified with the CLI build, version, and binary scan above. Documentation-local link targets exist. Historical versioned evidence remains labeled as historical.

### Hosted CI network compatibility repair

[Run 39808072755](https://github.com/narumiruna/logice/actions/runs/39808072755) passed all four browser workflows but failed the later API-IP replacement check. The CI Docker daemon rejected `--ip` on a network with an automatically allocated subnet: user-specified addresses require a user-configured subnet. Local success on a different daemon did not prove this path portable.

The smoke script now starts a replacement API with the `api` network alias while the original still owns its address. It asserts both addresses are nonempty and different, then removes the original API and requires successful proxied liveness through Nginx. Allocation remains dynamic: no static IP, fixed subnet, daemon setting, skipped assertion, or operator network change is needed. The replacement is removed by the existing bounded cleanup trap before its project network and images are deleted.

After replaying the repair onto merged `main` at `d2ccb18`, all 64 unit tests and all eight Chromium workflows passed, including the four real-data browser tests. The complete script also passed the changed-IP assertion, proxied recovery, and project cleanup. The retry window is unchanged. Hosted verification is reported on the follow-up PR rather than inferred from the local run.

### Remaining acceptance condition

[PR #1](https://github.com/narumiruna/logice/pull/1) explicitly retained final acceptance of the recommended libraries, policies, and operating targets. Its merged state and automated review do not supply an explicit user acceptance record. The current request authorizes execution, not a fabricated policy decision. The [remaining recommendations](stack.md#pending-acceptance) are handed to the user for PR review; the tracked plan remains present with its final acceptance checkbox open. No end-to-end plan-completion or production-readiness claim is made.

## Local web/API containers

The root Compose file now includes local web/API images. Nginx serves the built React application on `127.0.0.1:5173` and proxies `/api` to an unpublished Go container. Go retains its loopback default outside Compose; the API container explicitly uses `-listen 0.0.0.0:8080`. Docker DNS resolution follows API address changes. The API reads ClickHouse for the fixed `validation` project. These images do not implement authentication, multi-project access, PostgreSQL application data, production migrations, or production deployment hardening.

Run `sh scripts/validate-compose-web.sh` with Docker Compose 2.24.4 or later, curl, OpenSSL, GNU timeout, and the web-local Playwright Chromium installation. This check does not read operator credentials. It starts web/API/ClickHouse/Collector services with generated credentials and a random project and web port. CI runs it in a separate job with a seven-minute work limit and a one-minute termination allowance so cleanup does not consume the ingestion suite's execution budget.

Local verification passed:

- Pinned Go 1.26.9, Node.js 26.11.1, Alpine 3.24, and Nginx 1.30.6 container builds.
- HTML, compiled JavaScript, proxied JSON liveness, JSON 404 responses for `/api` and an unknown API route, SPA fallback, and a real 404 for missing assets.
- No API host port, a loopback-only web port, and a non-root API process.
- API replacement with its previous IP occupied by a temporary container; the web proxy recovered through Docker DNS without a web restart.
- One complete five-service startup with an isolated project and generated credentials served liveness through `http://127.0.0.1:5173/api/healthz`. All test containers, networks, volumes, and project image tags were removed.
- `go mod verify`, `sh scripts/check-go.sh`, `npm --prefix web ci`, and `npm --prefix web run ci`.
- The full real-service suite passed in 111.839 seconds, including `TestTelemetryQueries` (15.95 seconds). It selects only PostgreSQL, ClickHouse, and the Collector while validating all five service definitions. It does not build application images or bind port 5173.
- The query proof checks actual Collector data through the HTTP API: root selection, error filtering, attributes, exact nanosecond boundaries, literal search, limits, missing traces, and storage failure with independent liveness. Duplicate trace/span IDs inserted under a different project do not appear. A 501-span/201-log trace is capped at 500 spans and 200 logs with both truncation flags.
- All 42 frontend unit tests, ordinary Go checks, and Go race tests passed. The web audit reported zero vulnerabilities at validation time. Actionlint, shell syntax checks, and `git diff --check` passed.
- Four Chromium Playwright workflows passed against the built images and real OTLP input: trace filters and span/log details; log severity/body filters and trace links; empty/error/truncation states; and a narrow viewport plus unknown-trace error. Deep-link reloads retain their time bounds. Log text containing a script tag remains text. A screenshot was inspected under ignored `web/test-results/`.

The first browser attempts exposed test-selector mismatches and fixture re-seeding after worker restarts. The suite now scopes attribute assertions to the selected span and runs its shared fixture as one serial workflow. Subsequent complete runs passed. These checks do not establish authentication, public transport, full accessibility conformance, or production load limits. See [local telemetry usage and limits](local-telemetry.md).

## Reproduce

Use a local Docker Engine 28 or later with Compose 2.24 or later, Go 1.26.10 or a patched later release, and sufficient image/module download space. Initial verification used Docker 29.7.2, Compose 5.5.1, Go 1.27.1, Node 26.11.1, and npm 11.20.0. Current revalidation uses patched Go 1.26.10.

From the repository root:

```sh
npm --prefix web ci
npm --prefix web run ci
npm --prefix web audit --audit-level=low
./scripts/validate-web-layout.sh
sh scripts/validate-checks.sh
go mod verify
sh scripts/check-go.sh
go run golang.org/x/vuln/cmd/govulncheck@v1.9.0 -test -tags=integration ./...
npm --prefix web exec -- playwright install --with-deps chromium
sh scripts/validate-compose-web.sh
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
GOTOOLCHAIN=go1.26.10 GOBIN="$TOOLS/bin" go install \
  -tags='no_mysql no_sqlite3 no_ydb no_libsql no_mssql no_vertica no_azuresql' \
  github.com/pressly/goose/v3/cmd/goose@v3.29.0
"$TOOLS/bin/goose" -env=none -version
```

The application build design will include this pinned runner as `/app/goose` and separate SQL directories under `/app/migrations/`. [implementation.md](implementation.md) specifies its per-database `status` and `up` commands. Those future production-image commands have not run. The local API image does not include Goose or production schemas.

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

### Hosted CI and handoff

[PR #3](https://github.com/narumiruna/logice/pull/3) delivers this scope. [Hosted run 39094171550](https://github.com/narumiruna/logice/actions/runs/39094171550) passed on implementation revision `598b7a6`: `go-checks`, `web-checks`, `check-failure-validation`, `web-layout-validation`, and `stack-validation`. The integration job completed in 2m31s; no job was skipped. Local and hosted evidence close only the automated foundation scope. The completed execution plan is removed; the implementation sequence and this evidence remain.

## Unverified paths and acceptance gates

- The current API and React application provide local trace/log queries and detail views. Authentication, multi-project authorization, production image hardening, OpenAPI generation, and production migrations remain future work. The local browser checks do not close the full authenticated workflow gate.
- Password, TOTP, passkey, session, account recovery, and a complete Pocket ID login require application implementation. No compatibility claim is based only on discovery.
- Dynamic per-project token lookup/revocation, private Collector metadata enrichment, query isolation, least-privilege production roles, and public Tunnel access are not proved by a single static-token fixture.
- Queue saturation, restart loss, retry exhaustion, duplicate delivery under ambiguous insert failures, request/decompression limits, load/latency targets, retention expiry, and backup/restore remain release tests.
- The operator's hostname, tunnel, credentials, and recovery key are not selected or changed here. The public deployment cannot be claimed ready without them.
- Final user acceptance of the recommended library choices and validation targets remains open. Preserve the tracked plan and do not claim end-to-end plan completion until that gate is accepted.

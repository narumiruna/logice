# Automated application foundation

## Goal

Establish the Go/React application foundation and extend the telemetry proof with checks that return an automatic pass or failure. Do not require a person to operate a browser, configure an identity provider, select a public hostname, or inspect a screenshot.

Execution is authorized on `narumi/feat/automated-foundation`. Checked tasks below identify passing evidence; unchecked tasks remain pending. Scope: the first three proposed work items—repository migration, deterministic telemetry fixtures, and ingestion compatibility tests.

## Context

Baseline: `ebdfe31`, with a clean working tree before this plan was added.

- `docs/implementation.md` defines the application sequence. Its stage 0 decisions remain unresolved where they require operator input. This plan does not approve those decisions or complete later application stages.
- The root npm package still contains template source, configuration, and Changesets publishing. `scripts/pre-commit.sh` and `.github/workflows/ci.yml` use root npm commands.
- `tests/fixtures/web-layout/web/` has locked React/Vite dependencies. `scripts/validate-web-layout.sh` proves isolated installation and build compatibility; it collects Playwright tests but does not launch a browser.
- `tests/integration/telemetry_test.go` generates random IDs and current timestamps. Existing real-service tests cover scalar attributes, HTTP/gRPC, correlation, project-attribute replacement, rejection, retry, and persistence.
- `tests/integration/schema_test.go` verifies string-valued attribute maps and a 24-hour TTL. Nested values, span events, and links still need compatibility evidence.

## Non-Goals

Authentication, authorization policy, dynamic project credentials, application query APIs, production schemas, production migrations, public deployment, browser workflow acceptance, visual design, performance claims, and lossless ingestion guarantees are excluded. Migration-recovery extensions, trace-tree algorithms, and full Playwright execution are separate follow-up work.

Do not add unneeded feature packages, TanStack integrations, API generation, release pipelines, or runtime configuration options to fill the future repository layout.

## Plan

### 1. Resolve executable prerequisites

- [x] Record the scope boundary in `docs/implementation.md`: identify the stage 0 decisions needed for this foundation and defer unrelated authentication, deployment, retention, and capacity decisions to their dependent stages. Preserve those decisions as open; do not mark stages 0–8 complete. Evidence: each unresolved decision has a named dependent stage, and no task below uses an unapproved production default. If a required decision cannot be resolved from repository evidence, leave its dependent task blocked.
- [x] Check the existing locked fixture dependencies and select exact versions for the minimal application dependencies and development tools. Reuse validated versions where suitable; do not copy unused UI dependencies. Record Go, Node.js/npm, Docker/Compose, and service versions in `docs/validation.md`. Evidence: module verification, locked installation, dependency audit results, and successful version checks. An unexplained security finding remains open.
- [x] Run and record the current baseline checks from `docs/validation.md`, including the real Docker integration suite. Evidence: exact commands, revision, tool versions, exit status, and sanitized output. Missing Docker or network access is a blocker, not a skipped success.

Prerequisite evidence: baseline `ebdfe31` passed the complete original `docs/validation.md` command set on Go 1.27.1, Node 26.11.1/npm 11.20.0, Docker 29.7.2/Compose 5.5.1; the real-service suite passed in 42.30 seconds. `docs/implementation.md` maps deferred decisions to dependent stages. The minimal web lockfile uses the validated exact React/Vite/tool versions; locked install, CI checks, and low-threshold audit passed with zero vulnerabilities. `go mod verify` passed.

### 2. Establish the application foundation

- [x] Add `cmd/logice/main.go` and a minimal `internal/httpapi/` package with a loopback development listener, a liveness route, and bounded shutdown. Keep feature logic out of `main.go`; do not connect databases or claim application readiness. Evidence: handler tests verify success, unknown-route errors, and request cancellation; lifecycle tests verify bounded shutdown. `go build ./cmd/logice` works with no Node.js or frontend assets present.
- [x] Replace the root TypeScript template with one private package in `web/`, using React, TypeScript, and Vite. Move and adapt npm, TypeScript, Biome, and Vitest configuration; add `check`, `typecheck`, `test`, `build`, `dev`, `ci`, and root-hook `prepare` scripts. Add only a minimal application shell and a same-origin development proxy to Go. Evidence: isolated `npm --prefix web ci` and `npm --prefix web run ci` pass, unit tests run without Playwright files, and output exists only under `web/dist/`. These checks do not claim browser behavior.
- [x] Remove the root npm manifest/lockfile, template `src/`, template Vitest files, `.changeset/`, and `.github/workflows/publish.yml`; remove Changesets dependencies and scripts. Update README, ignore rules, and Dependabot paths. Evidence: tracked-file and manifest checks reject the old template identity, root npm ownership, and npm publishing configuration. Preserve the Go proof and its fixtures.
- [x] Update the root hook and CI to use web-local tools, all-source Go formatting, Go vet/unit tests/build, frontend checks/build, and the existing tagged integration suite. Use `HUSKY=0` for CI installation and `web/package-lock.json` for npm caching. Keep the isolated web-layout proof as a separate compatibility check for this scope. Evidence: clean installation sets `.husky/_`; hook execution from another directory succeeds without rewriting files; Go-only CI succeeds without Node.js. Every job has a finite timeout.
- [x] Add an automated failure-propagation check in a disposable checkout: inject a formatting error and then a failing unit test, run the real hook and CI check commands, and require nonzero exit status for each. Evidence: expected failures are detected, the temporary checkout is removed, and before/after index and worktree comparisons show no hook-induced edits. If hosted CI cannot be observed, record only local CI-command evidence and leave hosted results pending.

Foundation evidence: Go handler/lifecycle tests and ten race-test repetitions passed; HTTP package coverage is 100%. An isolated Go tree built and tested without Node.js or frontend files. The locked web install, checks, build, and audit passed. `scripts/validate-checks.sh` passed against committed foundation `6b541a6`: restricted-PATH Go checks, clean hook setup, hook invocation outside the repository, and eight injected Go/web formatting/unit-test failures all behaved as required without source/index changes. Hosted CI is not yet claimed.

### 3. Add deterministic telemetry fixtures

- [x] Add a test-only fixture package under `tests/fixtures/telemetry/`, without the integration build tag. Generate OTLP messages from an explicit seed and base time, and return a manifest of expected trace/span IDs, parent links, log associations, and counts. Evidence: ordinary Go tests prove identical semantic output for identical inputs, valid nonzero IDs, expected relationships, and no mutation of previously generated fixtures. Keep test resource names and credentials cryptographically random.
- [x] Define a finite fixture matrix with at most 128 spans and 128 logs per case: deep and wide trees, missing parents, child-before-parent delivery, a later parent batch, correlated logs, and logs without trace/span IDs. Record exact case sizes and batch order. Evidence: table-driven tests compare each case with explicit expected identities, relationships, and counts, rather than deriving all expectations from the generator itself.
- [x] Connect the fixtures to the disposable integration harness. Use a current UTC base time once per run so the existing TTL cannot expire fixed historical data; keep ID and relative-time generation deterministic. For the later-parent case, observe child storage before sending its parent. Evidence: real ClickHouse queries verify the final identity set, parent links, timestamps, correlation, missing-parent state, and counts without relying on SQL row order. No wall-clock delay is the only proof of delivery order.

### 4. Extend ingestion compatibility evidence

- [x] Inspect the pinned Collector exporter source/schema and record a compatibility matrix for arrays, nested key/value attributes, span events, links, instrumentation scope, and empty exports. Specify whether each field is preserved, converted, absent, or rejected, including its expected stored representation and protocol response. Evidence: version-specific source references and explicit expected results recorded before integration assertions; unsupported behavior is documented, not hidden by removing the case.
- [x] Add representative OTLP fixtures for that matrix and test them through both HTTP and gRPC for traces and logs where applicable. Include a bounded multi-record batch, an empty request, numeric boundary values, and nanosecond timestamps. Evidence: protocol status and partial-success assertions plus native ClickHouse queries compare actual values with the recorded matrix. An empty request creates no telemetry rows. Events and links are checked in their actual exporter columns rather than assumed to be ordinary attributes.
- [x] Re-run existing rejection and project-spoofing checks with the expanded fixtures. Evidence: missing/invalid credentials create no rows, nested input cannot replace the trusted project resource attribute, and reserved record attributes remain removed. This remains a single-project proof, not evidence of dynamic project authorization.
- [x] Update `docs/validation.md` and the integration-test README with reproducible commands, fixture identifiers, supported conversions, unsupported fields, and sanitized failure diagnostics. Evidence: every compatibility claim maps to a named passing test. Keep the existing loss/retry, TTL, and production-readiness limitations explicit.

Telemetry evidence: `go test -count=2 -timeout=2m ./tests/fixtures/telemetry` and tagged vet passed. The full tagged suite passed in 93.405 seconds: `TestTelemetryCompatibility` 58.21 seconds, `TestStackFeasibility` 35.19 seconds, and tool-version tests. Every protocol stored exactly 28 spans and 17 logs; both protocols stored 56/34. `docs/telemetry-compatibility.md` records the distribution revision, exporter v0.163.0/pdata v1.69.0 sources, field representations, and unsupported fields. An initial rounded datetime query bound was corrected to integer nanosecond bounds without weakening exact timestamp checks. Final clean-checkout and hosted evidence remain pending.

### 5. Validate from a clean checkout

- [x] Run the complete check set from a disposable checkout with no root `node_modules`, no frontend build output, and no inherited Compose project or repository credentials. Evidence: installation, hooks, independent Go build, web build, compatibility fixture, and real-service tests all pass; `git status --porcelain` is empty afterward, and the test-owned containers, networks, and volumes are gone. Repeat the deterministic fixture tests with the same inputs to confirm reproducibility.

Clean-checkout evidence: clone `9598246` passed all required checks on Go 1.26.9, including two fixture-test repetitions, three web tests, eight negative checks, the isolated layout fixture, and the full real-service suite (93.021 seconds). Exact-project checks found no containers/networks/volumes for either generated stack, git status was empty, and the clone was removed. `docs/validation.md` records commands and fixture IDs. The complete diff review and vulnerability scan passed; the discovered deadline/cleanup issue was fixed and tested.

Required check commands after the migration exists:

```sh
set -eu
build_dir=$(mktemp -d)
trap 'rm -rf -- "$build_dir"' EXIT HUP INT TERM
go mod verify
go vet ./...
go test -count=1 -timeout=2m ./...
go build -o "$build_dir/logice" ./cmd/logice
npm --prefix web ci
npm --prefix web run ci
sh scripts/pre-commit.sh
./scripts/validate-web-layout.sh
go vet -tags=integration ./tests/integration/...
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
git diff --check
```

Run every command with an outer finite deadline. Keep the existing 8-minute integration ceiling and bounded per-request/readiness waits; split independent tests if needed rather than remove deadlines. Record failures and rerun evidence. Missing services must fail a requested integration run.

## Rollback / Recovery

- This work uses disposable local test data only. Do not modify operator databases, an existing identity provider, tunnel settings, or production credentials.
- Keep the foundation migration separate from fixture and compatibility changes so failures can be isolated. Restore tracked tooling through a targeted revert; regenerate dependencies from the restored lockfile. Do not delete unrelated local files.
- Reuse the harness cleanup in `tests/integration/compose_test.go`. Remove only resources with the exact generated test-project label. Follow `docs/validation.md` after an interrupted run; never run Docker-wide prune commands.
- A newly found exporter limitation must result in a documented compatibility limit or a blocked dependent feature, not an unplanned production schema/configuration change.

## Completion Checklist

- [x] All plan tasks have passing evidence; required unknowns are resolved, and deferred decisions still block their dependent application stages.
- [x] The Go application builds without Node.js or frontend assets, and the private web package installs and passes checks without root npm dependencies.
- [x] Template npm publishing is absent, hooks remain read-only, and automated negative checks prove failure propagation.
- [x] Deterministic fixture unit tests and the full real-service suite pass; compatibility claims identify the pinned exporter and named assertions.
- [x] Clean-checkout evidence and cleanup results are recorded in `docs/validation.md`; no credentials, production telemetry, or binary test artifacts are committed.
- [ ] All configured CI jobs pass on the implementation revision. If hosted execution is unavailable, this item remains open even when local checks pass.
- [x] Documentation states that browser behavior, production authentication, dynamic isolation, capacity, and deployment remain unverified. No release or deployment is required for this scope.

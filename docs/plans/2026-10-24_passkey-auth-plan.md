# Invitation-only Passkey authentication

## Goal

Add invitation-only Passkey accounts to Logice. Protect the web application and query API with server-side sessions. Keep OTLP bearer-token ingestion separate.

## Approved requirements

- Use invitation-only enrollment. Create the first administrator through a local CLI command, not a public signup endpoint.
- Use a 64-character hexadecimal encryption key: decode exactly 32 bytes for AES-256-GCM. Reject malformed or incorrectly sized keys at startup. Supply the key through a Kubernetes Secret, never Git or Helm values.

## Context

- `docs/authentication.md` describes authentication but no application authentication is implemented.
- The application uses Go HTTP handlers and React. PostgreSQL exists in Compose but is absent from the Helm chart.
- The deployed external URL is `https://logice.narumi.dev`. Use an explicitly configured origin and RP ID, not request headers.
- The current deployment serves one shared telemetry project. This work does not add multi-project authorization.
- WebAuthn private keys stay with authenticators. Store public credentials and their authentication updates. Hash opaque session and invitation tokens; do not encrypt tokens instead of hashing them.

## Plan

- [x] Inspect HTTP routing, frontend state, database fixtures, and deployment wiring; document the exact authentication boundary and select a maintained WebAuthn library. Selected `go-webauthn/webauthn` 0.18.2; the production entry point wraps all API routes except health and defined auth endpoints.
- [x] Add PostgreSQL authentication migrations and storage for users, credentials, hashed invitations, hashed sessions, and expiring single-use ceremony state. Test transactions, concurrent consumption, expiry, and database failure handling. Use authenticated encryption for persisted ceremony state with the approved key format; never log plaintext or key material.
- [x] Add a local administrator bootstrap and recovery CLI. Refuse repeated bootstrap atomically; issue short-lived single-use enrollment credentials through an explicit operator action. Test unauthorized enrollment and repeated bootstrap.
- [x] Add invitation enrollment, user-verified discoverable Passkey login, authenticated invitation creation, logout, and session middleware. Require exact configured origins, browser-bound CSRF protection, expiring single-use challenges, bounded requests, and throttling. Preserve a usable account recovery path.
- [x] Add enrollment and login views and session-aware navigation. Guard query APIs on the server, not only in React. Keep health probes and authenticated OTLP ingestion independent.
- [x] Add PostgreSQL persistence, connection settings, external origin, and encryption-key Secret references to Compose and Helm. Keep PostgreSQL private. Document migration, bootstrap, enrollment, key backup, and recovery commands.
- [x] Test successful enrollment/login/logout and rejection of missing user verification, wrong origin/RP, replay, expired invitations/challenges/sessions, CSRF failures, and unauthenticated query access. Test browser flows with a virtual authenticator and dummy accounts.

## Rollback / Recovery

- Back up PostgreSQL and the encryption key separately before migration or key changes. Changing the hostname requires a Passkey enrollment migration plan.
- Use additive migrations. Do not remove authentication tables or disable authentication as an automatic rollback.
- Keep Cloudflare Access in place until application authentication is validated. Do not test against existing operator accounts or modify production Secrets without explicit authorization.
- Define an operator-only account recovery command before enabling authentication. Recovery revokes affected sessions and does not create a public bypass.

## Completion Checklist

- [ ] Unit, integration, browser, dependency, workflow, and Helm checks pass; record exact commands and remaining gaps. Local checks passed: 81/81 browser tests, anonymous query rejection, persisted authenticated queries after API IP replacement, and all eight injected-failure checks from a committed clone. GitHub CI follow-up is pending after the fixes recorded below.
- [x] Unauthenticated queries fail closed; enrollment requires an operator-issued invitation; OTLP still requires its separate token. Disposable Compose browser and telemetry integration tests passed.
- [ ] BLOCKED: the operator must verify a real Passkey login on `https://logice.narumi.dev` after an explicitly approved deployment. Virtual-authenticator tests do not complete this check. No live account, Secret, or deployment was changed.
- [x] Deployment instructions specify key generation with `openssl rand -hex 32`, a namespace-local Secret, database persistence, bootstrap, and recovery. See `docs/passkey-operations.md` and `charts/logice/README.md`.
- [x] Report changed files, test evidence, and any deployment actions still required. Draft PR: https://github.com/narumiruna/logice/pull/14, branch `narumi/feat/passkey-accounts`. Main changes are `internal/auth/`, `cmd/logice/`, `web/src/auth*`, `web/e2e/`, Compose, Helm, CI, and the operator runbook. The real-device HTTPS check above remains blocked; this plan is retained and the PR must not be treated as deployment approval. No production deployment, Secret update, image publication, or release workflow dispatch was performed.

## Verification evidence

- Validation source: implementation commit `f27cb44`, hook-validation fix `51d6712`, and CI follow-up fixes described below. Selected Go toolchain: 1.26.10, matching CI and the API image. `scripts/check-go.sh` passed with `GOTOOLCHAIN=go1.26.10`.
- `GOTOOLCHAIN=go1.26.10 go test -race -tags=integration -count=1 -timeout=8m ./tests/integration/...` passed in 202 seconds. This includes actual OTLP authentication, ClickHouse queries, persistence, and bounded outage checks.
- PostgreSQL auth unit/race/integration checks passed, including bootstrap races, recovery, expiry, CSRF, database failures, and deterministic database-lock observation for logout/session ordering.
- `npm --prefix web run ci` passed: Biome, TypeScript, 262 unit tests, production build.
- `scripts/validate-compose-web.sh` passed with 81 browser checks against disposable containers, including virtual user-verified Passkey enrollment/login and backend rejection of signed assertions without UV or with wrong challenges, RP hashes, and origins. API replacement at a different container IP passed. Test identities, sessions, and virtual credentials were confined to a protected temporary directory and removed.
- `scripts/validate-web-layout.sh`, `uv run charts/logice/tests/check.py`, `actionlint`, and `git diff --check` passed. `scripts/validate-checks.sh` passed from a committed clone, including no-Node Go checks, hook setup, read-only worktree/index snapshots, and eight injected failures. A POSIX-shell PATH leak found by that check was fixed with subshell isolation. Host tooling used a temporary extracted GNU timeout binary and a `sha256sum` adapter to macOS `shasum -a 256`; the bottle's checksum binary had a local dynamic-link error. No system utility was installed or repository checksum check weakened.
- `go mod verify` and `npm --prefix web audit --audit-level=low` passed. `govulncheck` found zero reachable or imported-package vulnerabilities. It reports module-only GO-2026-5932 for unused `golang.org/x/crypto/openpgp` (no fixed version; that package is not imported).
- Initial host Go 1.27.2 run failed the unchanged Live preflight exact-size test (8793 vs 8775 bytes). The selected 1.26.10 checks pass; no unrelated Live serialization change was made. An initial telemetry run with a four-minute suite deadline exhausted its cleanup reserve; the documented eight-minute command passed.
- GitHub run `39999924230` passed Go, web, compatibility-layout, and injected-failure jobs, but failed two jobs because the `setup-uv@v10` alias does not exist. Both new setup actions now use verified release commit SHAs. The auth integration cold-start also exposed a fixture bug: Docker image-pull stderr was mixed into the returned container ID. The helper now reads only stdout for successful IDs and keeps stderr for failure diagnostics. The telemetry integration portion passed on Ubuntu. A new full CI result is required before closing the automated-check item.
- Two source-only diff reviews identified and drove fixes for logout races, shared-proxy throttling, lookup outage responses, and migration retry safety. Runtime, replica/storage, backup/restore, and real-device HTTPS checks remain operator deployment gates.

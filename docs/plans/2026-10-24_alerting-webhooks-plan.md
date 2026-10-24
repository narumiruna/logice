# Alerting and Webhook Notifications

## Goal

Evaluate project-scoped telemetry conditions and send bounded, recoverable Webhook notifications for sustained errors, high latency, and missing telemetry.

## Context and Dependencies

The application currently serves interactive Go queries; it has no alert scheduler, delivery queue, or Webhook destination model. PostgreSQL stores project authorization and ClickHouse stores telemetry. Implement the metric definitions in [Dashboard aggregates](2026-10-24_dashboard-aggregates-plan.md) first. Follow the existing project role and deletion rules in [project access](../project-access.md).

## Architecture

- First release uses a dedicated worker command from the existing Go binary, not a timer in every API replica. PostgreSQL leases coordinate workers. Add deployment wiring only after restart/lease behavior passes disposable tests; do not enable a live worker automatically.
- Proposed permissions: all members read rule state; Owners/Developers manage rules; Owners manage approved Webhook destinations. Confirm this matrix and finite rule/destination quotas before coding.
- Store rules, durable evaluation state, incident history, encrypted destinations, and a delivery outbox in PostgreSQL through additive migrations. Reuse validated project-scoped aggregate queries, not a user-supplied URL, SQL expression, or Saved View as executable policy.
- Initial conditions are error-trace proportion with a minimum population, root-span p95 latency with a minimum population, and absence of stored telemetry after a rule's grace period. Define completed windows, export delay, consecutive breaches, recovery, cooldown, and stale data explicitly. Storage failure is unknown, never healthy or equivalent to no telemetry.
- Use pending/firing/resolved/unknown states. Commit state transitions and outbox records together. Claim evaluations and deliveries with expiring leases; enforce uniqueness by rule revision/window/transition. Delivery is at least once: include a stable event ID and document possible duplicates after a crash.
- Use HTTPS POST with a small versioned JSON payload containing identifiers, bounds, and statistics, not raw telemetry. Encrypt full destination URLs and credentials at rest; redact them from API lists, logs, errors, and audit targets. Review encryption key/AAD compatibility before reuse of `ENCRYPTION_KEY`.
- Prevent SSRF on destination validation and every connection: deny private, loopback, link-local, metadata, multicast, and reserved IPv4/IPv6 addresses; bind dialing to validated addresses while preserving TLS hostname checks. Reject redirects, URL userinfo, and unsupported schemes. Test DNS rebinding and mixed DNS results. Egress policy is defense in depth, not a substitute for these checks.
- Bound query concurrency, queue size, payload/response bytes, HTTP deadlines, retries, and retention. Retry transient failures with backoff and capped attempts; surface terminal delivery failure. Never claim exactly-once delivery. Stop new work for disabled/deleted projects and define treatment of already-authorized in-flight work.

## Plan

- [ ] Resolve rule semantics, role defaults, quotas, delivery contract, history retention, and encryption/egress requirements; acceptance: reviewed fixtures define no-data versus outage and duplicate-delivery behavior before schema/API work.
- [ ] Add transactional schema, role-aware CRUD, destination validation, and identifier-only mutation audit; acceptance: PostgreSQL tests prove scope, CSRF, quotas, revision conflicts, encryption/redaction, deletion, and migration retry behavior.
- [ ] Build the leased evaluator with an injectable clock; acceptance: multiple workers, expired leases, slow queries, restart, rule revisions, late data, and duplicate windows cannot create duplicate incidents or treat failures as recovery.
- [ ] Build outbox delivery and a protected explicit test-notification action; acceptance: controlled HTTPS servers prove SSRF denial, TLS validation, bounded retries, timeouts, stable IDs, retry exhaustion, and crash recovery without secret output.
- [ ] Add rule/destination/history UI and worker deployment examples; acceptance: both themes/mobile layouts expose pending/firing/unknown/resolved and failed delivery accurately, while unauthorized actions fail server-side.
- [ ] Add end-to-end trigger, notification, recovery, removal, and outage tests with disposable storage and receivers; acceptance: real two-project data cannot trigger or deliver another project's rule.

## Completion Checklist

- [ ] The aggregate prerequisite is complete. `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh`, `GOTOOLCHAIN=go1.26.10 go test -race -tags=integration -count=1 -timeout=8m ./internal/... ./tests/integration/...`, `npm --prefix web run ci`, and `sh scripts/validate-compose-web.sh` pass.
- [ ] Security review and adversarial DNS/URL tests pass; queue, concurrency, retries, and shutdown are demonstrably bounded.
- [ ] Multi-worker/restart tests prove durable state and documented at-least-once delivery; operator docs specify key backup and incident recovery.
- [ ] Deliver a verified implementation PR without live delivery or deployment; delete this plan only after checks and handoff complete.

## Rollback / Recovery

Stop workers first and prevent new delivery claims. Retain encrypted destinations, incidents, and outbox rows; do not blindly replay pending notifications after restore. A stale restore can resend old events: reconcile event IDs and rule state before resuming. Never log decrypted destinations during recovery. Retain additive tables on application rollback; approved production rollout requires separate database/key backups and an egress review.

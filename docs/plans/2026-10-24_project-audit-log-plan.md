# Project Audit Log

## Goal

Give project Owners a searchable, paginated history of access and configuration changes without exposing credentials or presenting incomplete historical records as complete attribution.

## Context

`internal/auth/schema.sql` already defines `project_events` with a bigint ID, project UUID, actor UUID, action, target, and timestamp. `projectAudit` in `internal/auth/projects.go` writes events in mutation transactions. Account/profile events live separately in `auth_events`; they must not be exposed through a project history endpoint. Project Settings has no audit view. See [project access](../project-access.md).

## Architecture

- Proposed first-release permission: only the current Owner reads project audit history. Developers, Viewers, nonmembers, and platform administrators without ownership cannot read it. Confirm this product default before implementation; do not add configurable per-action permissions.
- Add `GET /api/projects/{id}/events` with validated UTC/action filters and keyset pagination, at most 100 rows. Use a high-water event ID on the first page so newly inserted events do not move later pages. Never round bigint IDs through JavaScript numbers; serialize IDs/cursors without precision loss.
- Reauthorize every page request. Bind the validated cursor to the project, filters, and high-water mark; it is a position, not an authorization token. Reject malformed/mismatched cursors and prohibit arbitrary SQL, sort columns, or unbounded time ranges.
- Return event ID, action, UTC timestamp, actor UUID, and a safe typed target. Display current names only as current names, not immutable historical identity. Preserve the meaning and exact payload limits of legacy targets after inventorying existing writes.
- Inventory project creation/rename, membership/role changes, token creation/revocation, ownership transfer, deletion, and operator recovery. Add any missing events in the same transaction as the successful change. Do not fabricate historical events or record credential secrets, raw searches, token hashes, Webhook URLs, or telemetry bodies.
- Application behavior is append-only; the current database operator can alter stored events, so this is not tamper-proof compliance storage. No WORM export, hash chain, denied-request feed, or account audit UI in this release.
- Add only indexes or safe typed metadata needed by measured queries through a new versioned migration. Do not assign system activity to a human creator. If future workers need system actors, specify that schema evolution separately rather than rewriting history.

## Plan

- [ ] Inventory existing event writes and decide the Owner-only policy, action vocabulary, safe targets, query bounds, and retention policy; acceptance: a coverage table identifies historical gaps and sensitive fields before exposing an API. No event deletion is enabled implicitly.
- [ ] Implement bounded cursor queries, any necessary index migration, and scoped HTTP responses; acceptance: PostgreSQL tests prove deterministic ordering, high-water pagination, bigint precision, invalid filters/cursors, deleted-project denial, and role checks after ownership transfer/removal.
- [ ] Correct missing successful-mutation events atomically; acceptance: rollback, repeated revocation, concurrent changes, ownership transfer, and operator recovery tests prove accurate event counts without secrets or fabricated history.
- [ ] Add an Audit section to Project Settings with UTC/action filters, loading/empty/error/retry states, and paginated results; acceptance: both themes at 390px/1440px render escaped long names/targets and remain keyboard accessible.
- [ ] Add two-project and permission browser regressions; acceptance: guessed IDs/cursors cannot expose another project's records, and ownership transfer immediately changes who can request subsequent pages.
- [ ] Document interpretation, retention, and operator limits; acceptance: current actor names, historical gaps, already-authorized in-flight requests, and non-tamper-proof storage are stated accurately.

## Completion Checklist

- [ ] `GOTOOLCHAIN=go1.26.10 sh scripts/check-go.sh`, `GOTOOLCHAIN=go1.26.10 go test -race -tags=integration -count=1 -timeout=8m ./internal/auth/...`, `npm --prefix web run ci`, and `sh scripts/validate-compose-web.sh` pass.
- [ ] Query-plan evidence confirms indexed bounded pagination; tests cover same-timestamp events, IDs above JavaScript's safe integer limit, and concurrent inserts.
- [ ] Diff/security review confirms no auth-event crossover, secret data, invented historical attribution, or platform-admin bypass.
- [ ] Deliver a verified implementation PR with retention and recovery notes; delete this plan only after checks and handoff complete.

## Rollback / Recovery

Remove the audit reader/UI on rollback but continue existing transactional event writes. Retain event rows and additive indexes; do not truncate history or apply an unapproved retention cleanup. A stale PostgreSQL restore can lose later audit events and resurrect old project/token state: reconcile restored authorization and history before reopening access. No production changes are authorized by this plan.

# Project Workflows

## Setup

Open **Connect application** at `/projects/{id}/setup` from the sidebar, project Dashboard, or Project Settings. Owners and Developers can issue an ingestion token; Viewers request one from them. Token secrets appear once, remain in component memory, and clear on navigation or page hiding. Closing setup does not revoke a token.

Exporter instructions contain `${LOGICE_PROJECT_TOKEN}`, not a copied secret. Load the variable from protected storage. The application origin accepts OTLP HTTP protobuf; do not use the internal Collector token. The existing Python example is runnable from the repository root.

Start receipt observation before sending telemetry. It checks a fixed two-minute UTC window at most once every five seconds, without overlapping requests. Success means that a trace or log was observed in this project and window. It cannot identify the sending application or token. A timeout is not proof of rejection; storage errors are separate from empty data.

## Shared Saved Views

All project members can read/apply shared views. Owners and Developers can create, update, or delete them. A project has at most 100 saved views; a definition is limited to 16 KiB. There are no private views or per-view roles.

Use **Save current view** in Traces, Logs, or Live. The saved state is the committed query, not unsubmitted drafts. Relative windows move when applied; fixed windows preserve timestamp precision. A paused Live view does not resume automatically. Live column headers, Follow latest, and Auto-expand are included.

Open `/projects/{id}/views` to apply, share, rename, edit the typed JSON definition, or delete a view. Shared links contain project/view UUIDs only and still require current membership. Unknown definition versions do not execute telemetry queries. Concurrent changes return 409; reload before editing instead of overwriting another member's update.

The API exposes project-scoped `/views` collection and `/{viewId}` resources. Definitions accept version 1, Traces/Logs/Live, supported filters, relative/fixed time, and Live display booleans. They do not accept SQL, arbitrary URLs, credential values, or a project override. Revisions are decimal strings, not JavaScript numbers. Mutations use existing Origin, CSRF, rate, and JSON limits.

## Full-window Dashboard Statistics

`GET /api/projects/{id}/overview` accepts `from`, `to`, and optional `service`. Windows are half-open UTC intervals and at most 24 hours. Dashboard presets are 15 minutes, one hour, and 24 hours. The response contains up to 60 equal-width nanosecond buckets and full-window totals; recent explorer lists remain separate bounded samples.

Statistics describe stored matching telemetry, not all application traffic or complete traces:

1. Valid span identities use project/trace/span IDs; malformed spans use canonical content identity. Repeated identical exports do not inflate logical span counts.
2. Logs group by complete stored content, as in Live. Independent identical emissions cannot be distinguished from retransmission and count once.
3. Conflicting span variants use the lexicographically smallest canonical matching payload. A trace is eligible only with a valid span identity. Error traces have at least one canonical Error span in the matching population. The proportion is error traces divided by eligible traces; an empty denominator is null.
4. Root latency uses exact p50/p95 over unambiguous exported root-span durations within signed nanosecond bounds, including zero-duration roots. Multiple valid roots in one trace each contribute. Conflicts and ambiguous parents do not contribute. These are not end-to-end request-latency percentiles. No roots means null, not zero latency.
5. Each canonical record belongs to its representative timestamp bucket. A trace can appear in multiple buckets, so bucket trace counts are not additive. Time filters bound the input rows. Service filters choose matching representatives; conflict and parent-ambiguity flags consider all variants of a retained identity in that window.

Span and log reads are not a transactional storage snapshot. Late exports can change results. Limit/timeout/storage failures produce unavailable statistics, never sample-derived totals. Aggregate work has two admission slots per process and retains the existing readonly, five-second execution, 128 MiB query-memory, and 8 MiB result bounds. Data availability remains subject to table retention; changing Collector TTL does not change existing tables automatically.

## Alerts and Webhooks

Open `/projects/{id}/alerts`. All members read rules, approved destination metadata, incidents, and delivery status. Owners/Developers manage rules; only Owners manage destinations or explicitly queue a test notification. Destination URLs are encrypted and never returned by management reads. Destination credentials belong in the protected URL supplied by the Owner; no arbitrary request headers or raw telemetry templates are supported.

The first release has fixed operating limits:

1. At most 20 retained rule slots and five retained destination slots per project. Disable/edit slots to reuse them. Updates require the current decimal-string revision.
2. Conditions are error-trace proportion, root-span p95 in nanoseconds, or no logical stored spans/logs. Ratios use thresholds from 0 through 1 and a minimum population from 1 through 1,000,000. Latency requires a positive signed-nanosecond threshold and a minimum root-span population. No-data rules use threshold `0`; their minimum-population setting is ignored.
3. A dedicated worker evaluates closed five-minute windows after a 30-second export delay. New rules have five minutes of grace. Three consecutive breaches fire; two healthy evaluations recover. Notification transitions have a five-minute cooldown. Unavailable storage and insufficient populations are unknown and cannot resolve an incident. Management reads show unknown when the last evaluated window is more than 150 seconds old; this does not resolve an active incident.
4. State changes and notification outbox records commit together. Leases expire after 30 seconds. Rule revision, lease ownership, window, and project state are rechecked before commit. Disabled/deleted projects cannot authorize new work. Already-authorized in-flight work can finish.
5. The pending outbox is limited to 100 notifications per project and 1,000 globally. Backpressure defers a transition rather than claiming delivery. Deliveries have at most eight attempts with bounded exponential backoff up to five minutes; pending work expires after 24 hours as a terminal failure. Completed delivery and incident history are retained for up to 30 days, with cleanup in bounded batches.
6. Delivery is at least once. A crash after receiver acceptance but before acknowledgement can resend the same event. Receivers must deduplicate the stable event UUID in `X-Logice-Event-ID` and the versioned JSON payload. HTTP 2xx is acceptance, not a receiver durability guarantee. The payload contains identifiers, UTC bounds, transition, and aggregate statistics, not raw telemetry or destination secrets.
7. Destinations use public HTTPS on port 443. URL userinfo, redirects, private/reserved addresses, mixed private/public DNS answers, and untrusted TLS fail. Every physical connection resolves and validates DNS again, pins the approved IP, and verifies the original TLS hostname. The sender ignores proxy environment variables, limits headers to 8 KiB, reads at most 4 KiB of response body, and has a five-second deadline.

Editing a destination cancels pending notifications. Disabling it also disables associated rules. Replacing its URL can re-enable the destination; rules require an explicit edit to re-enable them. Disabling a rule cancels its pending notifications without inventing a healthy recovery event. **Queue test notification** means queued, not delivered; inspect delivery status.

### Worker Operation

`logice alerts-worker` uses PostgreSQL, ClickHouse, and the same `ENCRYPTION_KEY`. It does not need the Collector token or a public listener. It processes evaluations and delivery sequentially per worker; PostgreSQL leases coordinate additional workers. Size additional replicas against query capacity before scaling. Storage-cycle failures exit with a redacted message; the process supervisor must restart it. Shutdown cancels I/O and leaves leases recoverable.

For an approved local deployment, enable the Compose `alerts` profile and start `alerts-worker` after migration. Helm uses `alertsWorker.enabled: false` by default. Enabling it creates a separate worker and restrictive ingress/egress NetworkPolicy. The target CNI must enforce that policy; verify DNS and public HTTPS egress before release. No worker is enabled or deployed by implementation tests.

Back up PostgreSQL and the encryption key before migration. A stale restore can resend notifications, restore revoked access, or lose later incident history. Stop workers first, reconcile rule state and event IDs, then resume deliberately. Never blindly replay an old outbox or log decrypted destination URLs.

## Passkey Management

Account Settings lists opaque credential-management UUIDs, names, and trustworthy creation/last-used dates. Legacy dates remain unknown. A synced Passkey is not a unique physical-device record. Management metadata does not return WebAuthn credential IDs or public keys; required WebAuthn challenge options still use protocol credential descriptors.

Accounts can retain at most eight Passkeys. Adding/removing requires a fresh user-verified assertion bound to the account, current session, browser generation, operation, and target. Registration uses existing-credential exclusions and a separate, single-use registration ceremony. A user-row lock serializes changes and recovery. Last-Passkey removal is rejected server-side, including concurrent requests.

Removal revokes other account sessions and rotates the current session only after commit. Naming does not grant access or change credential material. Cancellation can race an already-submitted server operation: reload metadata to check the committed result. Lost access still uses operator recovery for the same account UUID. Account recovery does not revoke project tokens.

Virtual-authenticator tests do not replace verification with a real user-verifying authenticator on the intended HTTPS origin before production release. No live enrollment, recovery, or credential rotation is authorized by this implementation.

## Project Audit History

Only the current project Owner can read `/api/projects/{id}/events` or **Project settings → Audit history**. Platform administration alone grants no access. Account authentication/profile events are not project history.

The reader accepts UTC/action filters for at most 30 days, returns at most 100 rows, and uses descending bigint event IDs with a first-page high-water mark. IDs and cursors retain decimal-string precision. Every page rechecks ownership; cursors do not confer access. Actor display names are current names, not immutable historical identities. Operator-recovery events have actor kind `operator` and no account actor UUID; their target identifies the recovered subject. The command did not record an operator identity, and the reader does not invent one. Legacy non-UUID targets are redacted rather than exposed as arbitrary data.

Events record successful mutations in the same transaction. Targets contain identifiers only, not tokens, searches, Webhook URLs, or payloads. Existing historical gaps are not backfilled. Project events have no new automatic deletion policy. Application writes are append-only, but a database operator can change rows; this is not tamper-proof compliance storage. Deleted projects are not readable through the ordinary project API.

## Migration and Rollback

`logice migrate` applies additive workspace migrations under the existing transaction advisory lock. Workspace versions track saved-view/index changes, Passkey metadata/ceremonies, and alert tables separately from the unchanged authentication-v2 contract. New binaries fail startup until the required workspace schema is available. Previous authentication-v2 readers keep their existing tables and contract.

Roll back feature routes/UI or stop the worker without dropping additive tables, deleting credentials, truncating audit history, or restoring unscoped telemetry readers. Keep issued project tokens valid unless an Owner explicitly revokes them. Preserve the encryption key with the database backup. Production migration, release, physical-authenticator validation, and NetworkPolicy enforcement need separate operator validation.

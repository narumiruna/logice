# Invitation-only Passkey authentication

## Scope and release gate

Logice uses invitation-only Passkey accounts and server-side sessions. Projects have separate membership and Owner, Developer, and Viewer roles; see [project access](project-access.md). Password login, TOTP, OIDC, and Pocket ID are not part of this authentication release. The [earlier multi-method design](design/authentication-methods.md) remains a deferred reference, not the release scope.

Deployment wiring alone does not prove that authentication is available. Do not deploy until matching API and web images contain the authentication implementation and its tests pass. Keep Cloudflare Access enabled. An operator must verify a real Passkey login on `https://logice.narumi.dev` before release approval. Do not use existing operator accounts for automated tests.

See [Passkey operations](passkey-operations.md) for configuration, migration, bootstrap, backup, and recovery.

## Authentication boundary

- The Go API must require a valid session for actual telemetry query routes, including Live, trace, and log queries. A frontend redirect or proxy policy is not an authorization check.
- Static frontend assets can be public. Health probes do not require a session. Authentication entry points permit only their defined login or invitation ceremony operations, not query access.
- Enrollment requires an unexpired invitation. There is no public signup or unauthenticated server mode.
- Only an authenticated administrator can create invitations through the application. The first administrator is created through the operator-only bootstrap CLI.
- OTLP ingestion uses project tokens through Go. The private Collector uses a separate internal `OTLP_TOKEN`; never give that credential to SDKs. Browser sessions do not authorize ingestion, and ingestion tokens do not authorize queries.
- Signed-in users can access only projects they own or have joined. Platform administrators have no implicit project access.

## Configuration and storage

- `AUTH_ORIGIN` is always required. Production uses exactly `https://logice.narumi.dev`, with no path or trailing slash. HTTP is allowed only for localhost development; Compose uses `http://localhost:5173`.
  - The RP ID comes from the configured hostname, not Host or forwarded headers. The browser must use the exact configured origin.
  - Changing the hostname requires an explicit credential enrollment migration. Do not change it during a routine deployment.
- `ENCRYPTION_KEY` is always required: exactly 64 hexadecimal characters, decoded to 32 bytes for AES-256-GCM. Missing, malformed, or incorrectly sized keys must stop startup.
  - Keep it outside Git and Helm values. Back it up separately from PostgreSQL.
- PostgreSQL is required. Supply `DATABASE_URL`, or libpq settings `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, and `PGPASSWORD`. Compose and Helm use the latter to avoid URL escaping of passwords.
- Store credential public keys, identifiers, user handles, counters, transports, and backup flags in PostgreSQL. Private keys remain with authenticators.
- Encrypt persisted ceremony state with authenticated encryption. Store only hashes of opaque session and invitation tokens. Do not log raw tokens, challenges, cookies, or encryption keys.

## Enrollment and sessions

- Bootstrap must atomically refuse a second initial administrator. Record bootstrap and operator recovery actions in `auth_events` without tokens or credentials. Recovery is an explicit local operator action, not an HTTP bypass.
- Invitations expire after one hour and are single-use. Ceremonies expire after five minutes and are single-use, with atomic consumption and browser binding.
- Require user verification and discoverable Passkeys for registration and login. Verify the exact origin, RP ID, challenge, and ceremony type. Persist successful credential updates and use the library's synced-Passkey counter semantics. A counter warning on a device-bound credential denies login and requires operator recovery; a synced credential warning emits a generic log event without rejecting valid zero-counter behavior.
- Sessions expire after 24 hours idle or seven days absolute, whichever comes first. Activity cannot extend absolute expiry. Expiry checks must not depend on background cleanup.
- Self-service Passkey addition/removal requires a fresh user-verified, operation-bound assertion. Bind proofs to account, session, browser generation, and target; consume them once. Serialize changes against recovery and reject last-credential removal. Revoke other sessions and rotate the current session after successful removal. See [project workflows](project-workflows.md).
- Rotate sessions after authentication. Logout revokes this browser's sessions and pending ceremonies. A database-backed browser generation serializes logout with concurrent challenge creation and session issuance. Operator recovery revokes the user's sessions and old credentials before issuing a new enrollment invitation.
- HTTPS session cookies use Secure, HttpOnly, Path=/, no Domain, and SameSite=Lax, with the `__Host-` prefix. The HTTP localhost exception is development-only.
- Protect state-changing operations with browser-bound CSRF checks and exact origin checks. Do not mutate state on GET or enable wildcard credentialed CORS. Limit authentication JSON bodies to 64 KiB. Apply 30 authentication POSTs per browser per minute and 300 per process per minute; logout is exempt. Do not use untrusted forwarded IP headers. Browser limits do not provide network-level abuse prevention: clients can clear cookies, and the process budget is shared. Keep edge access controls and edge rate limits in place.
- Database failure must fail closed. Neither migration failure nor authentication failure can enable unauthenticated queries.

## Network controls

Keep Cloudflare Access in front of the application while authentication is validated. The chart's default web NodePort `30173` can bypass Cloudflare Access if a client can reach a node directly. Restrict node firewall rules or use `web.service.type: ClusterIP` with private tunnel routing. ClusterIP alone does not restrict other cluster workloads; apply cluster network policy where required.

Nginx forwards `/api` and `/v1/` to the Go API; it need not require authentication for static files. TLS terminates at the trusted edge. Do not use proxy headers to override the configured WebAuthn origin or weaken cookie policy.

## Required release evidence

1. Test concurrent bootstrap, repeated bootstrap, invitation expiry/replay, and administrator-only invitation creation.
2. Test user-verified registration/login and rejection of wrong origins, RP IDs, missing verification, expired ceremonies, and replay.
3. Test unauthenticated query rejection, session expiry/revocation, logout, CSRF rejection, and database outages.
4. Test operator recovery with disposable accounts, database/key restore, migration concurrency, and restart persistence.
5. Run browser tests with virtual authenticators, then have the operator verify a real Passkey on the configured HTTPS origin. Virtual tests do not replace this check.

# Passkey operations

## Deployment gate

This is an operator runbook, not authorization to deploy. No live cluster changes are part of the deployment-wiring work.

1. Wait for API and web images from the same authentication-capable commit and for authentication tests to pass. The chart still defaults to `latest`; older images do not implement these commands or enforce authentication. Pin both tags to the same full commit SHA before deployment.
2. Back up PostgreSQL and ClickHouse before schema upgrades. Back up the encryption key separately. Test restoration with disposable data.
3. Pre-create the new `ENCRYPTION_KEY` and `POSTGRES_PASSWORD` keys in the namespace-local `logice-secrets` Secret. Preserve its existing `CLICKHOUSE_PASSWORD` and `OTLP_TOKEN` values. Do not replace the Secret with an object that omits those keys.
4. Keep Cloudflare Access and private routing enabled. During the initial transition, stop or isolate the old unauthenticated API before permitting traffic to the new release. Do not rely on a rolling update to remove that exposure.
5. Obtain separate operator approval before syncing or restarting live workloads. Validate with disposable accounts before real enrollment.

## Project access cutover

Schema version 2 adds projects, membership, and project token hashes. Follow [project access, cutover, and rollback](project-access.md) before a multi-project release. Old `validation` data is not assigned to any account. Stop direct Collector ingestion, rotate `OTLP_TOKEN` into an internal-only credential, and move applications to project tokens through Go. Never roll back to an unscoped reader while multi-project data is exposed.

Owner account recovery uses the same account UUID and retains its project ownership. The local recovery command records `operator_account_recovery` in affected projects. It does not automatically revoke project application tokens; after recovery, verify ownership and explicitly revoke suspected tokens.

## Configuration

| Setting | Requirement |
| --- | --- |
| `AUTH_ORIGIN` | Always required; exactly `https://logice.narumi.dev` in deployment. Compose defaults to `http://localhost:5173`. No path or trailing slash. |
| `ENCRYPTION_KEY` | Exactly 64 hex characters; decoded as 32-byte AES-256-GCM key. Secret-backed in Helm. |
| `COLLECTOR_URL` | Server-only private Collector base URL; Compose and Helm provide it. |
| `OTLP_TOKEN` | Server and Collector internal credential; never an SDK project token. |
| PostgreSQL | `DATABASE_URL`, or `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`. Do not set conflicting sources. |

The required key setting is now `ENCRYPTION_KEY`, not `AUTH_ENCRYPTION_KEY`. For an existing installation, copy the same value to the new Secret key and update the image and chart together. Do not generate a replacement key during the rename. The old environment variable no longer satisfies startup validation. Remove the old Secret key only after all workloads use the new setting.

Helm sets `PGHOST=<release>-logice-postgres`, `PGPORT=5432`, `PGUSER=logice`, and `PGDATABASE=logice`; `PGPASSWORD` references the Secret's `POSTGRES_PASSWORD`. Compose uses host `postgres` and the same port/user/database. The CLI and API use the same configuration and database. Do not run bootstrap against a different environment by mistake.

Generate the encryption key with:

```sh
openssl rand -hex 32
```

Send the result directly to your secret manager or a protected file. Do not paste it into Git, Helm values, shell history, tickets, or telemetry. For a protected file without a trailing newline:

```sh
(umask 077; openssl rand -hex 32 | tr -d '\n' > /secure/path/auth-encryption-key)
```

Generate a separate PostgreSQL password. Do not reuse the encryption key. See the [chart instructions](../charts/logice/README.md) for initial Secret provisioning. For an existing Secret, use the secret manager's merge/update procedure and preserve all existing keys. Changing the Secret or `.env` does not change a database password already stored on disk; coordinate database role changes with all clients.

Missing required configuration, invalid key format, or an unavailable database must prevent authenticated service startup or deny access. A migration error must block the API. Check container exit status and migration logs without printing Secret values. `/api/healthz` is a process probe, not proof of schema correctness, authentication, or query readiness.

## Migrations and startup

The API image entry point is `/app/logice`. Its commands are:

```text
logice migrate
logice bootstrap -name NAME
logice recover -user UUID
logice users
logice -listen 0.0.0.0:8080
```

Helm runs `logice migrate` in an API initContainer using the same image and environment as the server. Compose runs an explicit one-shot `migrate` service after PostgreSQL is healthy; the API waits for successful completion. Failed initialization must never fall back to serving without authentication. Retrying migration startup after PostgreSQL becomes ready is safe only with transactional, repeatable migrations.

The backend migration runner must serialize upgrades with a PostgreSQL advisory **transaction** lock held on the migration transaction/connection. Helm cannot supply this lock. Concurrent CLI commands and initContainers must use the same lock and migration history. Verify this backend behavior before deployment.

Use additive, backward-compatible schema changes. Do not remove authentication tables or disable authentication during rollback. A Git rollback does not undo database changes. Roll back only to an authentication-capable image compatible with the upgraded schema, or restore a compatible backup during a controlled outage. Never roll back to the unauthenticated release.

## Local enrollment

Create `.env` as described in the [README](../README.md#run-with-docker-compose), then start the stack. Use `localhost`, not `127.0.0.1`, in the browser because the configured WebAuthn origin must match exactly.

```sh
docker compose --project-name logice-validation up --build --detach --wait --wait-timeout 120
docker compose --project-name logice-validation run --rm --no-deps api bootstrap -name 'Initial administrator'
```

Bootstrap prints only the enrollment invitation. Treat stdout as a credential: do not record the terminal, enable shell tracing, or copy output to logs. Transfer it through a secure channel. Open `http://localhost:5173`, select invitation enrollment, and supply the invitation in the enrollment form. Complete Passkey enrollment with user verification within one hour. Each ceremony expires after five minutes; an expired ceremony needs a fresh attempt. A consumed invitation cannot be reused.

Bootstrap refuses a second initial administrator. After enrollment, only a signed-in administrator can create application invitations. There is no public signup. New users enroll on the same configured origin.

## Kubernetes enrollment and recovery

These commands are examples for an approved deployment named `logice` in namespace `logice`; they have not been executed against a live cluster. Use restricted Kubernetes RBAC for operator exec access. Do not automate invitation output into CI logs.

```sh
kubectl -n logice exec deployment/logice-logice-api -c api -- /app/logice bootstrap -name 'Initial administrator'
```

Enroll at `https://logice.narumi.dev`, not a NodePort URL or port-forward origin. Keep Cloudflare Access enabled. An operator must verify real Passkey login, unauthenticated query rejection, and continued authenticated OTLP ingestion before release approval.

For a lost or compromised Passkey, verify the user's identity through an independent operator procedure. Obtain the UUID from trusted account records, not an unverified requester. List accounts with the operator-only CLI:

```sh
kubectl -n logice exec deployment/logice-logice-api -c api -- /app/logice users
# Local equivalent:
docker compose --project-name logice-validation run --rm --no-deps api users
```

`users` prints one JSON object per line with `id`, `name`, `admin`, and `active`. Protect this account list as operational data. Select the verified account's `id`, then run:

```sh
kubectl -n logice exec deployment/logice-logice-api -c api -- /app/logice recover -user USER_UUID
# Local equivalent:
docker compose --project-name logice-validation run --rm --no-deps api recover -user USER_UUID
```

Recovery revokes that user's sessions and old credentials, records an `operator_recovery` event in PostgreSQL, and prints a new enrollment invitation. Transfer it securely and complete enrollment within one hour. Existing Passkeys for that account no longer work. This is an operator-only recovery path, not a public bypass. Record the operator action and affected UUID, but never record the invitation. If the only administrator loses access, use recovery rather than deleting authentication tables or repeating bootstrap.

Sessions expire after 24 hours idle or seven days absolute. Logout revokes this browser's sessions and pending ceremonies, including concurrent login attempts. Other browsers retain their sessions until logout, expiry, or operator recovery. Invitations expire after one hour; ceremonies expire after five minutes. Authentication and query requests must fail closed when PostgreSQL is unavailable.

## Backup and restore

The private PostgreSQL instance stores users, public credentials, hashed sessions/invitations, and encrypted ceremony state. Authenticator private keys are not stored by Logice. The PostgreSQL PVC is retained on Helm uninstall and Argo CD deletion/prune. Retention is not a backup; node or disk loss can still destroy it.

1. Schedule encrypted, access-controlled PostgreSQL backups and verify restore tests. Set retention and off-cluster storage through the operator's existing backup system.
2. Back up `ENCRYPTION_KEY` separately from database dumps. Preserve the version that matches the database backup. Protect Secret exports as credentials.
3. For a manual logical backup, use the pinned PostgreSQL tools. For example, after approval:

   ```sh
   (umask 077; kubectl -n logice exec deployment/logice-logice-postgres -c postgres -- \
     pg_dump -U logice -d logice -Fc > /secure/path/logice-auth.dump)
   ```

   Check the command exit status before accepting the backup. The local Unix socket uses the container's local database access; do not expose that socket or loosen network authentication.
4. Restore into an isolated compatible PostgreSQL instance first. Use `pg_restore --exit-on-error` for the custom-format dump and the matching encryption key. Keep the API stopped while replacing data; do not restore over an active application database.
5. Run the matching migration CLI, verify schema and login with disposable accounts, then restore controlled access. A restored database can reintroduce sessions, invitations, or credentials revoked after the backup. Treat a stale restore as a security event and revoke affected accounts' sessions/credentials through recovery before reopening access.

A new random encryption key is not a transparent rotation. It cannot decrypt old ceremony state. Do not rotate it during a routine restart or use recovery as a substitute for a tested database/key restore. If the key is lost or compromised, isolate access and plan an explicit ceremony invalidation/key transition with the backend owner. Never add an unauthenticated fallback.

PostgreSQL runs as UID/GID 70 for the pinned Alpine image, with a read-only root filesystem and writable data, socket, and temporary mounts. The storage driver must support the configured `fsGroup` permissions. Verify PVC binding, initialization, restart persistence, backups, and restore on the target storage class before use. One replica is not high availability. PostgreSQL major-version upgrades require a separate database migration procedure.

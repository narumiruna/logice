# Projects, roles, and ingestion tokens

## Use a project

Sign in with a registered Passkey account. Open `/projects`, enter a project name, and select **Create project**. You become its Owner. Select a project to open its Traces, Logs, or Live page. Project UUIDs remain in navigation, copied links, and API URLs; browser tabs do not share a selected-project session setting.

Account registration remains invitation-only. A platform administrator can issue registration invitations but cannot read or manage a project without membership. Your account UUID appears in the Account panel. Give this UUID to a project Owner through a trusted channel; display names are not unique account identifiers.

In **Project settings**, the Owner can add an existing active account by UUID, change its role, remove it, rename the project, transfer ownership, or delete the project. There is no account directory or invitation for an unregistered project member.

| Operation | Owner | Developer | Viewer |
| --- | --- | --- | --- |
| Read traces, logs, details, and Live | Yes | Yes | Yes |
| List, create, and revoke project tokens | Yes | Yes | No |
| Manage members and roles; rename project | Yes | No | No |
| Transfer ownership; delete project | Yes | No | No |

Each project has exactly one Owner. Transfer requires an active existing member and makes the previous Owner a Developer. Ordinary member operations cannot remove or demote the Owner.

## Create an application credential

Owners and Developers can create ingestion tokens in **Project settings**. Set a name and, optionally, an expiry in UTC. Copy the complete token when it appears: it is shown only once. Store it in the application's secret store. The database contains its SHA-256 hash, not the secret. List responses expose only metadata and status.

Tokens belong to projects, not people. The creator UUID is audit metadata. Removing or demoting the creator does **not** revoke a token. An Owner or Developer can revoke any project token. Revocation is permanent through the API. Rotate a credential by creating a replacement, switching applications, and revoking the old token.

Use the web application's origin as the OTLP HTTP endpoint:

```sh
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:5173
# Load LOGICE_PROJECT_TOKEN from the application's protected secret store.
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${LOGICE_PROJECT_TOKEN}"
export OTEL_SERVICE_NAME=my-application
```

Send protobuf to `/v1/traces` and `/v1/logs`. Gzip is supported. Tokens authorize only these writes: they do not authorize browser login, telemetry reads, or management APIs. SDK resource attributes and headers cannot select a different project.

The infrastructure `OTLP_TOKEN` is a separate private Collector credential. Do not give it to SDKs or use it as a project token. Public project-token gRPC and metrics are not supported. Direct Collector gRPC in disposable tests proves only private receiver transport.

## API contract

All `/api/projects` routes require an active browser session. Mutations require the exact trusted Origin, a CSRF cookie and matching `X-CSRF-Token`, and `Content-Type: application/json`. DELETE requests also carry `{}`. Bodies are limited to 64 KiB. Mutations share the existing browser/process rate budget.

| Route | Methods | Purpose |
| --- | --- | --- |
| `/api/projects` | GET, POST | List accessible projects; create with `{name}` |
| `/api/projects/{id}` | GET, PATCH, DELETE | Read, rename with `{name}`, logically delete |
| `/api/projects/{id}/members` | GET, POST | List; add with `{userId, role}` |
| `/api/projects/{id}/members/{userId}` | PATCH, DELETE | Set `{role}`; remove |
| `/api/projects/{id}/owner` | POST | Transfer with `{userId}` |
| `/api/projects/{id}/tokens` | GET, POST | List metadata; create with `{name, expiresAt?}` |
| `/api/projects/{id}/tokens/{tokenId}/revoke` | POST | Revoke; repeated revocation is safe |
| `/api/projects/{id}/traces` | GET | Trace summaries |
| `/api/projects/{id}/logs` | GET | Log records |
| `/api/projects/{id}/traces/{traceId}` | GET | Spans and correlated logs |
| `/api/projects/{id}/live` | GET | Matching spans/logs, context, and histogram |

Names contain 1–80 characters with no control characters or surrounding whitespace. Project and account IDs are canonical UUID strings. Roles in member requests are exactly `Developer` or `Viewer`. Token expiry is null or a future RFC3339 timestamp.

Management lists return `{items, hasMore}`, at most 100 items, and accept `offset` from 0 through 100000. Token lists include revoked and expired records. Each account can own at most 100 non-deleted projects. Each project can have at most 100 non-revoked tokens, including expired tokens; revoke unused tokens to release capacity. Quota failures return 409.

Inaccessible, deleted, or unknown projects and out-of-project token IDs return 404. A member without the required role receives 403. Missing sessions and invalid ingestion credentials receive 401. Authorization-store failures fail closed with 503. These checks do not depend on a UI control being hidden.

Legacy `/api/traces`, `/api/logs`, and `/api/live` return 404 to signed-in clients. There is no default project or `validation` fallback. Existing telemetry query time, row, and memory bounds still apply. Trace and span IDs can repeat across projects without merging results or Live identities.

## Ingestion boundary and limits

The Go proxy checks the token hash, expiry, revocation, and project deletion on every request without a successful-lookup cache. It builds a new upstream header map, replaces the bearer credential, and sets the trusted project UUID. Collector uses `delete_matching_keys` to remove every duplicate reserved key in resource, span, and log attributes, then inserts the trusted resource attribute, and drops records without that metadata before export. The Collector remains the OTLP parser.

The proxy accepts at most 8 MiB of encoded body and 128 concurrent ingestion requests per API process. Length-delimited requests stream without a full-body buffer. At most four unknown-length bodies can be buffered at once; additional unknown-length requests receive 429. At most four upstream response buffers are held at once, with other responses waiting within their deadline. The upstream deadline is 10 seconds, with a 1 MiB upstream response limit. Collector bounds decoded HTTP input to 8 MiB. Overload returns 429; excessive encoded input returns 413. Unsupported content types/encodings return 415. Upstream failures return 502. Valid upstream status and body, including partial success, pass through unchanged. Successful OTLP responses are not durable-persistence or exactly-once guarantees.

Membership, role, deletion, and token changes apply to new authorization decisions. Already authorized in-flight requests can finish. Deleted projects reject new reads/writes and revoke all their tokens atomically. Deletion is logical: telemetry remains in ClickHouse until its configured TTL, not until immediate physical erasure.

## Release, recovery, and rollback

1. Back up PostgreSQL and the encryption key separately. Record tested image digests and secret references, never secret values. Pin matching API/web images.
2. Stop public ingestion and project access for the cutover. Apply `logice migrate`; schema version 2 is required at startup. It adds project tables without assigning existing accounts or telemetry to a project.
3. Deploy matching Go, web, Collector, and routing configuration together. Remove direct Collector host/public routes. Set `COLLECTOR_URL` and the internal `OTLP_TOKEN` only on trusted infrastructure. Rotate the former shared ingestion credential.
4. The Helm NetworkPolicy allows Collector HTTP only from this release's API pods. A CNI that enforces NetworkPolicy is required. ClusterIP alone is insufficient. Verify enforcement and node/edge routing before release. Compose does not publish Collector ports; its project network is a trusted local boundary, not an isolation boundary from hostile local containers.
5. Users create projects and new project tokens. Move SDKs to Go ingress. Old `validation` data remains inaccessible. Attribution or copying requires a separate approved migration; do not automatically grant it to an administrator.
6. For a lost Owner Passkey, use the existing operator-only `logice recover -user OWNER_UUID` procedure, verify the account identity through an external trusted process, and re-enroll that same account UUID. Ownership is retained. Recovery is audited; it is not a platform-admin HTTP override. After login, verify membership and revoke any suspected project tokens.
7. Before release, use disposable accounts to prove restored Owner access and token revocation. Verify a real HTTPS Passkey and the intended public HTTP ingestion route separately. Local tests do not verify Cloudflare Tunnel compatibility or live Kubernetes enforcement.
8. If validation fails, disable access and ingestion first. Keep additive tables and backups. Never restore an old unscoped reader while multi-project data is exposed. Restore only a tested compatible configuration or restore the backup while access remains stopped. Do not automatically drop project tables or delete ClickHouse data.

No deployment or production-data mutation is part of the implementation tests.

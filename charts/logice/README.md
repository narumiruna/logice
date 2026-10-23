# Logice Helm chart

The chart runs web, API, private PostgreSQL, ClickHouse, and OpenTelemetry Collector workloads for one shared telemetry project. It does not provide high availability or multi-project authorization.

**Do not deploy this wiring until matching authentication-capable API/web images are published and tested.** The defaults still use `latest`; older images cannot run the migration CLI or enforce authentication. Pre-create the new Secret keys before any approved sync. No live deployment is authorized or performed by the chart checks.

See [authentication](../../docs/authentication.md) and the [Passkey operator runbook](../../docs/passkey-operations.md) for enrollment, backup, restore, recovery, and release gates.

## Prerequisites

- Kubernetes 1.26 or later and Helm 3.
- A default StorageClass, or explicit `clickhouse.persistence.storageClass` and `postgres.persistence.storageClass` values.
- API and web images from the same tested authentication-capable revision.
- Namespace-local `logice-secrets` with `CLICKHOUSE_PASSWORD`, `OTLP_TOKEN`, `POSTGRES_PASSWORD`, and `AUTH_ENCRYPTION_KEY`.
  - `AUTH_ENCRYPTION_KEY` must be exactly 64 hex characters (32 bytes AES-256-GCM).
  - Generate it with `openssl rand -hex 32`; back it up separately from PostgreSQL.
- A namespace-local image pull Secret if packages are private.
- Argo CD repository access and a restricted AppProject if using GitOps.

## Images and Secrets

The [Docker workflow](../../.github/workflows/docker.yml) publishes `linux/amd64` and `linux/arm64` API/web images on pushes to `main` and manual runs. It uses `GITHUB_TOKEN` and tags images with the full commit SHA; runs on `main` also publish `latest`.

Wait for both authentication image publish jobs to succeed. For repeatable rollout and rollback, set both image tags to that same full SHA:

| Value | Default | Requirement |
| --- | --- | --- |
| `api.image.repository` | `ghcr.io/narumiruna/logice-api` | Cluster must have pull access |
| `web.image.repository` | `ghcr.io/narumiruna/logice-web` | Cluster must have pull access |
| `api.image.tag`, `web.image.tag` | `latest` | Override with the same tested authentication commit SHA |
| `existingSecret` | `logice-secrets` | All four keys above must already exist |
| `api.authOrigin` | `https://logice.narumi.dev` | Exact external HTTPS origin; no trailing slash or path |

For a private registry, set `imagePullSecrets` to a namespace-local Secret with package read access. Build/publish manually if required:

```sh
docker build -f deploy/api.Dockerfile -t registry.example.com/private/logice-api:COMMIT_SHA .
docker build -f deploy/web.Dockerfile -t registry.example.com/private/logice-web:COMMIT_SHA .
docker push registry.example.com/private/logice-api:COMMIT_SHA
docker push registry.example.com/private/logice-web:COMMIT_SHA
```

Provision Secrets with your secret manager. For a **new installation only**, protected files must contain only the respective values, without trailing newlines:

```sh
kubectl create namespace logice
kubectl -n logice create secret generic logice-secrets \
  --from-file=CLICKHOUSE_PASSWORD=/secure/path/clickhouse-password \
  --from-file=OTLP_TOKEN=/secure/path/otlp-token \
  --from-file=POSTGRES_PASSWORD=/secure/path/postgres-password \
  --from-file=AUTH_ENCRYPTION_KEY=/secure/path/auth-encryption-key
```

For an existing installation, merge the two new keys through the secret manager without deleting or changing existing values. Never put credentials in Git, Helm values, or the Application. The chart generates no Secrets, random values, or install hooks. Offline rendering cannot check Secret existence or key contents. Missing keys block container startup; malformed encryption keys must stop the backend.

Secret changes do not restart running Pods. Coordinate credential changes and restarts with database changes; changing `POSTGRES_PASSWORD` does not change a role password in an existing PostgreSQL volume. Encryption-key changes are not a routine password rotation. See the operator runbook before changing the key.

## Configuration and migration

The API and its migration initContainer share the image, environment, and restricted security context:

- `AUTH_ORIGIN` comes from `api.authOrigin`.
- `AUTH_ENCRYPTION_KEY` references the same-named Secret key.
- `PGHOST` names the release's PostgreSQL Service, with `PGPORT=5432`, `PGUSER=logice`, and `PGDATABASE=logice`.
- `PGPASSWORD` references `POSTGRES_PASSWORD`. No plaintext password or credential-bearing URL is placed in values.

The backend also accepts `DATABASE_URL`; this chart uses libpq environment settings instead. `AUTH_ORIGIN` and the encryption key are always required, including CLI commands. There is no unauthenticated server mode.

Each API Pod runs `logice migrate` before starting the server. A failed migration blocks startup. The backend must serialize concurrent migrations with a PostgreSQL advisory transaction lock; an initContainer alone does not serialize different Pods or operator commands. API uses Recreate to avoid overlap during a schema transition. Stop or isolate the old unauthenticated deployment during the initial upgrade. Do not reopen access until query authentication is verified.

## Argo CD

Copy [the Application example](../argocd-application.example.yaml) into a private GitOps repository and select a restricted AppProject. Repository and registry credentials are separate. The example uses manual sync and a pinned Git commit. Create the namespace and Secret before an approved sync; `CreateNamespace=true` does not create credentials.

Rendering without overrides works, but is not a deployment readiness check. The `latest` API/web tags publish separately and can temporarily refer to different revisions. `pullPolicy: Always` checks the registry only at container startup. Argo CD does not detect changes behind the same tag. Prefer immutable matching tags; restart only after operator approval and confirmed compatible images/Secrets.

## Access and ingestion

Preserve Cloudflare Access while application authentication is validated. Use the configured public origin `https://logice.narumi.dev` for enrollment and login. NodePort and port-forward URLs do not match that WebAuthn origin.

The web Service is `logice-tunnel`, with NodePort `30173` by default. This name creates no tunnel or authentication. **Direct node access can bypass Cloudflare Access.** Restrict node firewall access or set `web.service.type: ClusterIP` and use private tunnel routing. Only one release per namespace can use this fixed Service name. `web.service.nodePort` can change the port if required.

API, PostgreSQL, ClickHouse, and Collector Services are ClusterIP. No public database, LoadBalancer, or Collector Ingress is created. Other cluster workloads can connect unless network policies restrict them. In-cluster database traffic is plaintext; use trusted cluster networking or separately managed TLS where required.

Nginx forwards `/api` to the API Service; the Go API must enforce sessions on real query routes. Static assets and process health probes need not require a session. Configuration changes trigger web rollouts. Health probes do not prove authenticated queries or credential validity.

For local diagnostic Collector access after approval:

```sh
kubectl -n logice port-forward service/logice-logice-collector 4318:4318
```

Send traces to `http://127.0.0.1:4318/v1/traces` and logs to `/v1/logs`, with `Authorization: Bearer <OTLP_TOKEN>`. In-cluster clients use `logice-logice-collector.logice.svc:4317` for gRPC or port `4318` for HTTP. Browser sessions and ingestion tokens are independent.

Optional Ingress requires `ingress.enabled`, a host matching `api.authOrigin`, the controller class, TLS, and separately configured edge access controls. The chart installs no Ingress controller, certificate manager, identity provider, or Cloudflare resources. HTTP localhost origins are development-only.

## Data and upgrades

- PostgreSQL and ClickHouse each run one replica with Recreate strategy and ReadWriteOnce storage. Defaults are 5 GiB and 20 GiB respectively.
- Both PVCs are retained on Helm uninstall and Argo CD prune/Application deletion. Retention is not backup. Delete claims manually only when data loss is intended.
  - Preserve release name and namespace to reuse the claims. Retained claims may require explicit adoption on reinstall and can appear as requiring pruning in Argo CD.
- Choose storage classes before installation. Changes do not migrate data; expansion requires driver support and shrinking is unsupported.
- PostgreSQL uses the same pinned PostgreSQL 18 Alpine image as Compose. UID/GID and `fsGroup` are 70. Its root filesystem is read-only; data, `/var/run/postgresql`, and `/tmp` are writable mounts.
  - Verify the storage driver supports the configured permissions. Probes use `pg_isready`, not HTTP.
- Back up PostgreSQL and the encryption key separately before schema/key changes. Back up ClickHouse before upgrades. The chart provides no backup controller.
- Migrations must be additive and backward-compatible. Rollback must retain authentication and use schema-compatible images; never return to the unauthenticated release or drop authentication tables as an automatic rollback.
- A Git rollback does not roll back stored data. PostgreSQL major-version changes need a separate upgrade procedure.
- Collector uses Recreate and a memory-only queue; restarts can interrupt ingestion and lose queued telemetry.
- Collector manages telemetry tables and assigns the fixed `validation` project. API/database names are fixed to `logice`; do not change them independently.
- Default telemetry TTL is 24 hours. Changing `collector.ttl` does not update existing table TTLs automatically.

## Checks and operator acceptance

No cluster or credentials are needed:

```sh
uv run charts/logice/tests/check.py
helm lint charts/logice --strict
helm template charts/logice --name-template logice --namespace logice --kube-version 1.36.5 --include-crds
git diff --check
```

Checks cover deterministic defaults/custom rendering, five components, private service wiring, Secret references, shared migration configuration, PostgreSQL probes/image/mounts, retained PVCs, and optional Ingress. They do not prove live rollout or application authentication.

Before release approval, the operator must verify image pulls, PVC write access and restart persistence, migration serialization, fail-closed queries, administrator-only invitations, real HTTPS Passkey enrollment/login, session revocation/recovery, backup restore, and authenticated OTLP ingestion. Use disposable accounts for validation. Follow the [operator runbook](../../docs/passkey-operations.md).

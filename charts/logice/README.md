# Logice Helm chart

Deploy the current single-project Logice runtime from a private Argo CD repository. This chart runs the web server, API, ClickHouse, and OpenTelemetry Collector. PostgreSQL is omitted because the application does not use it yet.

**This is not a production-ready or multi-tenant deployment.** The UI and query API have no authentication. Keep them on a private network or behind an authenticated proxy. A private Argo CD installation does not restrict application access.

## Prerequisites

- Kubernetes 1.26 or later and Helm 3.
- A default StorageClass, or a class set in `clickhouse.persistence.storageClass`.
- API and web images built from the same repository revision and pushed to your registry.
- A namespace-local Secret with nonempty `CLICKHOUSE_PASSWORD` and `OTLP_TOKEN` keys.
- A namespace-local image pull Secret if the registry requires authentication.
- Argo CD access to the Git repository and an AppProject that permits the repository and destination.

Build and publish both images, replacing the registry and tag:

```sh
docker build -f deploy/api.Dockerfile -t registry.example.com/private/logice-api:COMMIT_SHA .
docker build -f deploy/web.Dockerfile -t registry.example.com/private/logice-web:COMMIT_SHA .
docker push registry.example.com/private/logice-api:COMMIT_SHA
docker push registry.example.com/private/logice-web:COMMIT_SHA
```

No application images are published by this repository's CI. Use immutable tags and do not reuse them.

Provision Secrets with your existing secret manager. For manual provisioning, use two protected files that contain only the respective secret value, without a trailing newline:

```sh
kubectl create namespace logice
kubectl -n logice create secret generic logice-secrets \
  --from-file=CLICKHOUSE_PASSWORD=/secure/path/clickhouse-password \
  --from-file=OTLP_TOKEN=/secure/path/otlp-token
```

Do not put credentials in Git, Helm values, or the Application. The chart creates no Secrets and uses no random values or install hooks. Secret changes require a manual restart of the API, ClickHouse, and Collector workloads. Coordinate password rotation across all three; back up data first.

## Argo CD

Copy and edit [the Application example](../argocd-application.example.yaml) in your private GitOps repository. Replace all placeholders and select an existing restricted AppProject. Repository credentials belong in Argo CD, not in this chart. Registry credentials belong in the destination namespace. These are separate credentials.

The example uses manual sync and a pinned Git commit. Create the namespace and Secrets before the first sync, then sync the Application. No cluster resources are installed by the chart itself; Argo CD can create the destination namespace through `CreateNamespace=true`.

Required Helm values:

| Value | Purpose |
| --- | --- |
| `existingSecret` | Secret containing `CLICKHOUSE_PASSWORD` and `OTLP_TOKEN` |
| `api.image.repository`, `api.image.tag` | Published API image |
| `web.image.repository`, `web.image.tag` | Published web image |

See [values.yaml](values.yaml) for resource limits, private registry access, storage, telemetry TTL, and optional Ingress. Rendering without the required values fails deliberately. The Secret must exist at deployment time; offline rendering cannot check its contents.

## Access and ingestion

All four Services use `ClusterIP`. No LoadBalancer, NodePort, Collector Ingress, or public database endpoint is created. This is not network isolation: other cluster workloads can reach these Services unless your cluster applies NetworkPolicies.

For the example release name `logice`, use:

```sh
kubectl -n logice port-forward service/logice-logice-web 5173:8080
kubectl -n logice port-forward service/logice-logice-collector 4318:4318
```

Run each command in a separate terminal. Open `http://127.0.0.1:5173`. Send OTLP/HTTP traces to `http://127.0.0.1:4318/v1/traces` and logs to `/v1/logs`, with `Authorization: Bearer <OTLP_TOKEN>`. In-cluster clients can use `logice-logice-collector.logice.svc:4317` for gRPC or port `4318` for HTTP. Transport is plaintext inside the cluster; use a trusted network or a TLS proxy.

To enable web Ingress, set `ingress.enabled`, `ingress.host`, the controller class, and TLS settings. Configure controller-specific access controls separately before enabling it. The chart does not install an Ingress controller, certificate manager, or identity provider.

The Nginx ConfigMap replaces the image's Docker-only DNS settings with the Kubernetes API Service address. Configuration changes trigger workload rollouts. Health probes check process health, not end-to-end ingestion, database credentials, or query readiness.

## Data and upgrades

- One ClickHouse replica stores data on a 20 GiB ReadWriteOnce PVC by default. This is not an HA database.
- The chart retains the PVC on Helm uninstall and Argo CD prune/Application deletion. Delete it manually only when data loss is intended. Argo CD can report a retained claim as requiring pruning.
- Preserve the release name and namespace to reuse the claim. Changes to either create a different claim.
- Choose the StorageClass before deployment. Changing it does not migrate data. Capacity expansion requires StorageClass support; shrinking is not supported.
- ClickHouse and Collector use the Recreate deployment strategy. Upgrades can interrupt ingestion. The Collector queue is memory-only; restarts can lose queued telemetry.
- The Collector creates its own schema and assigns every record to the fixed `validation` project. The API uses the fixed `logice` database and user. Do not change these names independently.
- The default telemetry TTL is 24 hours. Changing `collector.ttl` does not guarantee a change to existing table TTLs. Inspect and alter existing tables separately.
- Back up ClickHouse before an upgrade. A Git rollback does not roll back stored data or schema changes. Restore a compatible backup if a database downgrade is not safe.
- This chart has no backup controller or database migration jobs.

## Local checks

Supply test-only identifiers; no cluster or real credentials are required:

```sh
helm lint charts/logice --strict \
  --set existingSecret=test \
  --set api.image.repository=test/api --set api.image.tag=test \
  --set web.image.repository=test/web --set web.image.tag=test
uv run charts/logice/tests/check.py
```

The test requires `helm` on PATH and uses PyYAML through uv. It checks rendering, deterministic output, service wiring, Secret references, persistence retention, configuration, and optional Ingress.

Local rendering does not prove cluster rollout. Before use, the cluster operator must check image pulls, PVC binding and write access, workload readiness, authenticated OTLP ingestion, query results, private routing, and data persistence after a ClickHouse restart. No live cluster deployment is performed by these checks.

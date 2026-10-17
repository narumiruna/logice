# Stack feasibility test

Run from the repository root:

```sh
go test -tags=integration -count=1 -timeout=8m ./tests/integration/...
```

Requirements: Go 1.26 or later, Docker Engine 28 or later, and Docker Compose 2.24 or later. The selected Docker daemon must permit containers, networks, volumes, and loopback port publication. The first run must be able to pull the pinned images in `compose.yaml`.

The test starts its own Compose project. Do not start the stack manually. It generates credentials, ignores inherited Compose settings and `.env` files, and uses the selected Docker connection settings. It reads ports from its own containers, not from fixed localhost ports. It checks the resolved configuration before startup and checks container ownership and loopback bindings after startup. Database clients are recreated after database restarts because Docker can assign new random host ports.

## Checks

- Each missing credential causes Compose configuration to fail.
- Goose 3.29.0 applies separate PostgreSQL and ClickHouse fixtures. A second application makes no changes and both versions remain 1.
- PostgreSQL stores only application metadata and Goose bookkeeping.
- ClickHouse accepts `NO TRANSACTION` migrations through its native Go driver.
  - A deliberate failure after DDL leaves the table present and the Goose version at 0.
  - A retry fails because the table already exists. Nontransactional failures require inspection and repair; Goose does not roll back DDL.
- OTLP HTTP accepts two related spans and a log linked to the child. An actual OTLP gRPC client exports one additional span.
- Native ClickHouse queries verify trace and span identities, parent links, service names, duration, log correlation, and current timestamps with nanosecond precision.
- The default attribute columns are `Map(LowCardinality(String), String)`. String, integer, Boolean, and floating-point OTLP scalar values retain their string representations. This does not preserve the original OTLP value types.
- Custom resource and record attributes survive. Trusted configuration replaces the resource project identity; spoofed project identities cannot survive in span or log attributes.
- Both telemetry tables have a 24-hour timestamp TTL. This checks the TTL definition, not the time at which background merges delete expired data.
- HTTP and gRPC reject missing and incorrect tokens for traces and logs. Authenticated malformed HTTP protobuf requests return 4xx. Rejected requests do not change telemetry row counts.
- A short ClickHouse outage causes export retries. The Collector exports the queued span after ClickHouse returns, without a duplicate in this test.
- Both databases retain fixture data, and ClickHouse retains telemetry, after database container restarts.

## Cleanup and limits

Normal completion, startup failures, and assertion failures run project-scoped cleanup with volume deletion. Failure output includes only sanitized, bounded Compose logs. Generated passwords and tokens are removed from diagnostic text. Database queries use `pgx/stdlib` and `clickhouse-go/v2`, not shell SQL clients.

The test has a 6-minute-45-second work deadline, bounded commands and queries, and a separate cleanup deadline. A forced process termination or an unavailable Docker daemon can prevent cleanup. Each test logs its random project name so that an operator can identify its resources. No global Docker prune command is used.

This is a disposable stack-selection proof. SQL under `testdata/` is not an application schema. The test does not prove production security, multi-project isolation, throughput, backup recovery, or lossless ingestion. The Collector queue is in memory; a Collector restart can lose queued telemetry.

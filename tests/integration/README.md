# Stack and telemetry compatibility tests

Run from the repository root:

```sh
go test -tags=integration -count=1 -timeout=8m ./tests/integration/...
```

Requirements: Go 1.26 or later, Docker Engine 28 or later, and Docker Compose 2.24 or later. The selected Docker daemon must permit containers, networks, volumes, and loopback port publication. The first run must be able to pull the pinned images in `compose.yaml`.

Each top-level test starts its own Compose project. Do not start the stack manually. It generates credentials, ignores inherited Compose settings and `.env` files, and uses the selected Docker connection settings. It reads ports from its own containers, not from fixed localhost ports. It checks the resolved configuration before startup and checks container ownership and loopback bindings after startup. Database clients are recreated after database restarts because Docker can assign new random host ports.

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

## Deterministic telemetry compatibility

The [source contract and exact fixture matrix](../../docs/telemetry-compatibility.md) record expectations from the pinned source before the integration assertions. Collector 0.163.1 contains clickhouseexporter v0.163.0 and pdata v1.69.0; do not assume the exporter module has the image version.

```sh
# Ordinary fixture tests need no Docker or integration build tag.
go test -count=2 -timeout=2m ./tests/fixtures/telemetry
# Type-check and run the compatibility proof in its own disposable stack.
go vet -tags=integration ./tests/integration/...
go test -tags=integration -count=1 -timeout=8m -v -run '^TestTelemetryCompatibility$' ./tests/integration/...
# Preserve and rerun all existing migration, rejection, retry and persistence proofs.
go test -tags=integration -count=1 -timeout=8m -v ./tests/integration/...
```

Use a 300-second outer deadline for ordinary checks. For the tagged integration suite, use an outer deadline of at least 9 minutes so the 8-minute Go deadline and bounded cleanup can finish; CI has a 15-minute job deadline. The observed local suite takes less than 300 seconds. Missing Docker, network access or required services is a failure, not a skipped success.

`TestMatrixOracle` checks explicit seed-7 identities, parent links, counts, log associations and batch order. `TestDeterminismAndOwnership` checks repeated generation and independent nested messages. `TestCompatibilityInput` checks numeric boundaries and structured input. None of these tests uses the wall clock.

`TestTelemetryCompatibility` uses seeds 7 (HTTP), 8 (gRPC), and 99 (rejected requests), with one current UTC base time; gRPC times are one second later. Cases are `deep` (8 spans/2 logs), `wide` (9/2), `orphan` (2/2), `child-before-parent` (2/2), `later-parent` (2/2), `correlated` (2/2), `uncorrelated` (0/2), and `compatibility` (3/3). Both protocols together must store exactly 56 spans and 34 logs.

- All cases use both HTTP and gRPC. Responses must succeed with no partial rejection count or message. Empty exports must create no rows.
- The later-parent case requires a stored child and an absent parent before sending the second batch. The final identity set and parent links are checked without SQL row-order assumptions.
- Native queries compare resource/record arrays, nested maps, empty values, bytes, integer limits, finite double limits and scalar nonfinite doubles with explicit stored strings. They compare events and links in the actual `Events.*` and `Links.*` columns.
- Scope name/version, log scope attributes/schema URLs, nanosecond timestamps, duration, log correlation and observed-time fallback are checked. Trace scope attributes/schema URLs and event/link dropped-attribute counts have no columns.
- Nested nonfinite values are accepted but their containing JSON map becomes an empty string. This is a tested limitation, not lossless support. Other attribute conversions also lose OTLP type information.
- Resource map/array spoofing cannot replace the trusted project identity. Reserved span/log record keys must be absent; nested data does not become trusted identity. Expanded multi-record requests repeat missing/invalid-token rejection over both protocols; whole-table counts include uncorrelated logs.

Failure messages identify protocol, fixture, identity or column. Query and Compose errors use the harness secret filter, and cleanup emits bounded sanitized service logs. If a nanosecond range query is changed, use integer `toUnixTimestamp64Nano(Timestamp)` bounds: inferred datetime parameters can round the boundary and hide valid rows. Timestamp values are still compared exactly after scanning.

## Cleanup and limits

Normal completion, startup failures, and assertion failures run project-scoped cleanup with volume deletion. Failure output includes only sanitized, bounded Compose logs. Generated passwords and tokens are removed from diagnostic text. Database queries use `pgx/stdlib` and `clickhouse-go/v2`, not shell SQL clients.

Each stack has a work deadline equal to the earlier of start plus 6 minutes 45 seconds or the Go suite deadline minus 70 seconds. The reserve allows failure logs (12 seconds), Compose cleanup (40 seconds), and an 18-second margin before Go terminates the process. `TestStackWorkDeadline` verifies this calculation, including later tests and insufficient budget. Startup fails before creating resources if no work budget remains. Commands and queries remain bounded; cleanup uses its separate deadline. A forced process termination or an unavailable Docker daemon can prevent cleanup. Each test logs its random project name so that an operator can identify its resources. No global Docker prune command is used.

This is a disposable stack-selection proof. SQL under `testdata/` is not an application schema. The test does not prove production security, multi-project isolation, throughput, backup recovery, or lossless ingestion. The Collector queue is in memory; a Collector restart can lose queued telemetry.

# Pinned telemetry compatibility

## Source contract (recorded before integration assertions)

`compose.yaml` pins Collector **0.163.1**, image digest `sha256:1175b03003053962012f5a231f5567f66a3e8fdb960c7835c0e48f7aa1555806`.
The image label identifies releases revision `e3bd087aedd311e3b1a5cdbb4c4f82043f02f1f2`.
Its [distribution manifest](https://github.com/open-telemetry/opentelemetry-collector-releases/blob/e3bd087aedd311e3b1a5cdbb4c4f82043f02f1f2/distributions/otelcol-contrib/manifest.yaml) pins **clickhouseexporter v0.163.0**, not v0.163.1. The contrib v0.163.1 source URLs return HTTP 404; do not substitute an unrelated exporter version.

Source was downloaded with `curl --fail --location` into a temporary directory:

- [Exporter module archive](https://proxy.golang.org/github.com/open-telemetry/opentelemetry-collector-contrib/exporter/clickhouseexporter/@v/v0.163.0.zip), source revision `df849b5403c041d5e799e7846392a6f18b0b55ae` (module proxy origin metadata).
- [Trace insertion and event/link conversion](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/exporter/clickhouseexporter/v0.163.0/exporter/clickhouseexporter/exporter_traces.go), `pushTraceData`, `convertEvents`, `convertLinks`.
- [Log insertion](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/exporter/clickhouseexporter/v0.163.0/exporter/clickhouseexporter/exporter_logs.go), `pushLogsData`.
- [Attribute conversion](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/exporter/clickhouseexporter/v0.163.0/exporter/clickhouseexporter/internal/util.go), `AttributesToMap` calls `Value.AsString`.
- [Schema directory](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/exporter/clickhouseexporter/v0.163.0/exporter/clickhouseexporter/internal/sqltemplates), `traces_table.sql`, `logs_table.sql` and insertion templates.
- The exporter go.mod pins pdata **v1.69.0**, source revision `5177a6a85ca3783068077e25aec6cebbe1d50d1f`. [pdata module archive](https://proxy.golang.org/go.opentelemetry.io/collector/pdata/@v/v1.69.0.zip); [value conversion](https://github.com/open-telemetry/opentelemetry-collector/blob/pdata/v1.69.0/pdata/pcommon/value.go), `AsString`, `marshalJSONNoHTMLEscape`, `float64AsString`.

The expectations below apply to the default string-map schema, not the optional JSON schema. Each accepted HTTP protobuf export must return 200; each accepted gRPC export must return OK. Partial-success rejected counts must be zero and error messages empty. Acceptance alone is not storage evidence.

| Input | Expected ClickHouse representation | Result / limit |
| --- | --- | --- |
| Resource and record arrays | String `["alpha",42,true,1.5]` in the attribute map | Converted; OTLP element types are not stored as typed columns |
| Nested key/value map | String `{"inner":{"enabled":true},"logice.project.id":"nested-spoof"}` | Converted JSON, not flattened; nested project key is data, not trusted identity |
| Empty value / array / map | `""` / `"[]"` / `"{}"` | Converted; empty value and empty string cannot be distinguished |
| Bytes `00 ff` | `AP8=` | Base64 string |
| Signed integer limits | `-9223372036854775808`, `9223372036854775807` | Decimal strings |
| Maximum finite double / smallest positive double | `1.7976931348623157e+308`, `5e-324` | Strings; original numeric type absent |
| Scalar NaN / positive infinity / negative infinity | `NaN`, `Infinity`, `-Infinity` | Converted strings, not numeric columns |
| Nested nonfinite double | Empty string for the containing map | Unsupported JSON value: pdata ignores the JSON encoder error; payload accepted but containing value lost |
| Span events | `Events.Timestamp`, `Events.Name`, `Events.Attributes` arrays | Preserved in actual Nested columns; event attributes use the same string conversion |
| Span links | `Links.TraceId`, `Links.SpanId`, `Links.TraceState`, `Links.Attributes` arrays | IDs, state and converted attributes preserved; not ordinary span attributes |
| Event/link dropped attribute counts (2 / 3 in input) | No corresponding trace columns | Absent; unsupported |
| Scope name / version | `ScopeName`, `ScopeVersion` in both tables | Preserved |
| Scope attributes | Logs `ScopeAttributes`; no trace `ScopeAttributes` column | Converted for logs; absent for traces (unsupported) |
| Resource / scope schema URLs | Logs `ResourceSchemaUrl`, `ScopeSchemaUrl`; no corresponding trace columns | Preserved for logs; absent for traces |
| Nanosecond span/log/event times | `Timestamp` and `Events.Timestamp` are `DateTime64(9)`; `Duration` is UInt64 nanoseconds | Exact comparison; log ObservedTime is not a separate column |
| Log with time zero and observed time set | Observed time in `Timestamp` | Fallback; separate observed time absent |
| Correlated / uncorrelated logs | Hex trace/span IDs / empty ID strings | Preserved; missing parents are not synthesized |
| Empty trace/log request | No new rows | Accepted, no partial rejection; no assumption that exporter receives an empty batch |
| Bounded multi-record request | One row per span/log | Accepted; storage checked by exact identity set, not SQL row order |
| Map/array project spoofing | Resource `logice.project.id` is `validation`; record key absent | Configuration overwrites resource key and deletes reserved record key; nested data remains ordinary data |
| Missing / invalid token | HTTP 401 or 403; gRPC Unauthenticated or PermissionDenied | Rejected; no new rows |

## Fixture matrix

`tests/fixtures/telemetry` is test support, not application code. Seed and base time are explicit. Trace IDs encode the seed and case number; span IDs encode seed, case number and ordinal. Each call allocates independent messages and manifest data. Integration takes one current UTC base time per test to avoid the 24-hour TTL; gRPC uses base plus one second to give uncorrelated logs a separate time range. Seeds are 7 (HTTP), 8 (gRPC), and 99 (rejected requests). Credentials and Compose names still use cryptographic randomness.

| Case number / identifier | Spans | Logs | Span batches (ordinals, in send order) | Parent oracle |
| --- | ---: | ---: | --- | --- |
| 1 / deep | 8 | 2 | 1–8 | 1 root; n points to n-1 |
| 2 / wide | 9 | 2 | 1–9 | 1 root; 2–9 point to 1 |
| 3 / orphan | 2 | 2 | 1,2 | 1 root; 2 points to absent 99 |
| 4 / child-before-parent | 2 | 2 | 2,1 (one request) | 1 root; 2 points to 1 |
| 5 / later-parent | 2 | 2 | 2; then 1 | Observe stored child with parent absent before sending parent |
| 6 / correlated | 2 | 2 | 1,2 | 1 root; 2 points to 1; both logs linked to 2 |
| 7 / uncorrelated | 0 | 2 | none | Both logs have no trace/span IDs |
| 8 / compatibility | 3 | 3 | 1,2,3 | 1 root; 2,3 point to 1 |

Resource spoof values alternate between maps and arrays by case; record spoof values alternate by ordinal. Scope, event and link attributes are not record attributes: their nested project values remain data and do not set the trusted resource identity.

Except `correlated` and `uncorrelated`, log 1 links to the last span and remaining logs have no IDs. Logs are sent once after the span batches. All cases are below 128 spans and 128 logs. Relative span starts are ordinal nanoseconds after base; durations are 1,234,567 ns. Log times are base plus 100+ordinal ns. Compatibility log 3 exercises observed-time fallback. Events occur at base plus ordinal+7 ns, and links point to span 1.

## Evidence and limits

`TestMatrixOracle`, `TestDeterminismAndOwnership`, and `TestCompatibilityInput` test ordinary fixture behavior. `TestTelemetryCompatibility` runs every case over HTTP and gRPC in a separate disposable stack, checks the matrix against native ClickHouse columns, observes the later-parent intermediate state, checks empty exports and repeats rejection with expanded requests. `TestStackFeasibility` retains the existing migration, malformed-request, outage/retry and restart proofs. `TestStackWorkDeadline` checks that each stack retains the 6-minute-45-second work ceiling and stops work at least 70 seconds before the suite deadline: 12 seconds for failure logs, 40 seconds for cleanup, and an 18-second margin. Insufficient budget fails before resource creation.

No application query API, trace-tree algorithm, production schema or runtime option is added. String conversions are not lossless. Scope attributes for traces, separate observed timestamps, and nested nonfinite JSON values remain unsupported. This single-project test does not prove dynamic authorization, production security, capacity, browser behavior, deployment or lossless delivery. The Collector queue is in memory. TTL checks prove the 24-hour definition, not merge-time deletion.
